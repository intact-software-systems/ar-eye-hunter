import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { isSameGroupLayoutIdentity, toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { holdsPlannedCandidateAt } from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import {
    decodeGroupConnectTriggerWork,
    type GroupConnectTriggerWork
} from '../../../group-state/group-connect-trigger-outbox-entry.ts';
import type { GroupMutationCommand } from '../../../group-state/mutation/group-mutation-contracts.ts';
import type {
    GroupConnectTriggerIdentity,
    GroupConnectTriggerLatchRepository
} from '../../../group-state/persistence/group-connect-trigger-latch-repository.ts';
import { serializeCanonicalJson } from '../../../protocol/canonical-json.ts';

export interface GroupFormationAutomationPort {
    readonly latches: GroupConnectTriggerLatchRepository;
    readonly readGroup: (ref: GroupRef) => Promise<Group | null>;
    readonly readPlanned: (ref: GroupRef) => Promise<RallarOverlayTopologySnapshot | null>;
    readonly submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
    readonly nowEpochMs: () => number;
}

export function createGroupConnectTriggerWorkHandler(port: GroupFormationAutomationPort): OnMessageCallback {
    return {
        onMessage: async (_message, entry) => {
            const work = decodeGroupConnectTriggerWork(entry.resource);
            await petitionGroupConnectTriggerWork(port, work);
        }
    };
}

async function petitionGroupConnectTriggerWork(
    port: GroupFormationAutomationPort,
    work: GroupConnectTriggerWork
): Promise<void> {
    if (work.kind === 'intent') {
        await petitionGroupConnectTrigger(port, work, { kind: 'clock', atEpochMs: port.nowEpochMs() });
        return;
    }
    await petitionAwaitingGroupConnectTriggers(port, work.groupRef, { kind: 'clock', atEpochMs: port.nowEpochMs() });
}

/**
 * What satisfied the trigger the latch is waiting on: an instant the caller
 * vouches for — this node's clock for a publication, the timer's own due
 * time for the connect timer, so a node whose clock lags the one that
 * latched cannot strand a settle the queue already served — or the trigger's
 * own condition, met before any of that (product decision 8's threshold).
 * Satisfaction names the formation epoch it was observed at, because it
 * overrides the latch's own instant and must not fire a later series' latch
 * on an earlier series' evidence.
 */
export type GroupConnectTriggerSettle =
    | Readonly<{ kind: 'clock'; atEpochMs: number; }>
    | Readonly<{ kind: 'satisfied'; observedFormationEpoch: number; }>;

/** Every latch still awaiting publication in the group's current epoch, petitioned in turn. */
export async function petitionAwaitingGroupConnectTriggers(
    port: GroupFormationAutomationPort,
    groupRef: GroupRef,
    settle: GroupConnectTriggerSettle
): Promise<void> {
    const group = await port.readGroup(groupRef);
    if (group === null) {
        return;
    }
    const latches = await port.latches.listAwaiting(groupRef, group.formationEpoch);
    for (const { latch } of latches) {
        await petitionGroupConnectTrigger(port, latch, settle);
    }
}

export async function petitionGroupConnectTrigger(
    port: GroupFormationAutomationPort,
    identity: GroupConnectTriggerIdentity,
    settle: GroupConnectTriggerSettle
): Promise<void> {
    const row = await port.latches.read(identity);
    if (row === null || row.latch.state !== 'awaiting-publication') {
        return;
    }
    if (settle.kind === 'clock' && settle.atEpochMs < row.latch.notBeforeEpochMs) {
        // A publication ahead of the settle leaves the intent latched; the
        // connect timer petitions again at the settle instant, and a met
        // presence threshold petitions sooner still.
        return;
    }
    if (settle.kind === 'satisfied' && settle.observedFormationEpoch !== identity.formationEpoch) {
        return;
    }
    const group = await port.readGroup(identity.groupRef);
    if (
        group === null || group.formationEpoch !== identity.formationEpoch ||
        !holdsPlannedCandidateAt(group.lifecycleState)
    ) {
        return;
    }
    const planned = await port.readPlanned(identity.groupRef);
    if (planned === null || planned.state !== 'active') {
        // Intent remains in the latch; publication creates fresh durable work.
        return;
    }
    const publication = toGroupLayoutIdentity(planned);
    if (
        row.latch.supersedesLayoutIdentity !== null &&
        isSameGroupLayoutIdentity(publication, row.latch.supersedesLayoutIdentity)
    ) {
        // The reconfigure's own replan has not published yet, so this is the
        // candidate it means to replace. Dialing it would enter `reconnecting`
        // on the stale layout and freeze the replan (plan slice 11d).
        return;
    }
    await port.submitCommand(toAutomaticGroupConnectCommand(identity, publication), port.nowEpochMs());
}

export function toAutomaticGroupConnectCommand(
    identity: GroupConnectTriggerIdentity,
    expectedLayout: GroupLayoutIdentity
): GroupMutationCommand {
    const commandId = `formation-automation:connect:${
        serializeCanonicalJson({
            groupRef: identity.groupRef,
            formationEpoch: identity.formationEpoch,
            triggerGeneration: identity.triggerGeneration,
            expectedLayout
        })
    }`;
    return {
        operation: 'connectGroup',
        aggregateRef: identity.groupRef,
        commandId,
        requestId: commandId,
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            expectedFormationEpoch: identity.formationEpoch,
            expectedLayout,
            connectTriggerGeneration: identity.triggerGeneration
        }
    };
}
