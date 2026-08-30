import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { Group, GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';

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
        await petitionGroupConnectTrigger(port, work);
        return;
    }
    const group = await port.readGroup(work.groupRef);
    if (group === null) {
        return;
    }
    const latches = await port.latches.listAwaiting(work.groupRef, group.formationEpoch);
    for (const { latch } of latches) {
        await petitionGroupConnectTrigger(port, latch);
    }
}

export async function petitionGroupConnectTrigger(
    port: GroupFormationAutomationPort,
    identity: GroupConnectTriggerIdentity
): Promise<void> {
    const row = await port.latches.read(identity);
    if (row === null || row.latch.state !== 'awaiting-publication') {
        return;
    }
    const group = await port.readGroup(identity.groupRef);
    if (
        group === null || group.formationEpoch !== identity.formationEpoch ||
        (group.lifecycleState !== 'planned' && group.lifecycleState !== 'reconfiguring')
    ) {
        return;
    }
    const planned = await port.readPlanned(identity.groupRef);
    if (planned === null || planned.state !== 'active') {
        // Intent remains in the latch; publication creates fresh durable work.
        return;
    }
    await port.submitCommand(
        toAutomaticGroupConnectCommand(identity, toGroupLayoutIdentity(planned)),
        port.nowEpochMs()
    );
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
