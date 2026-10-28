import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import {
    decodeFormationTimerWork,
    type GroupFormationTimerWork
} from '../../../group-state/formation-timer-outbox-entry.ts';
import {
    toFailFormationCommand,
    toFormationRetryPlanCommand,
    toFormationTriggerPlanCommand
} from '../../../group-state/group-formation-mutation-command.ts';
import type { GroupTopologyGroupSnapshotReader } from '../../planning/group-topology-planning-contracts.ts';
import type { GroupTopologyPlanningService } from '../../planning/group-topology-planning-service.ts';
import { computeFormationCriterionCommand } from './compute-formation-criterion-command.ts';
import {
    petitionAwaitingGroupConnectTriggers,
    type GroupFormationAutomationPort
} from './create-group-connect-trigger-work-handler.ts';
import type { FormationCriterionPort } from './formation-criterion-observer.ts';

export interface FormationTimerWorkHandlerOptions {
    readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    readonly readPlannedTopology: (ref: GroupRef) => Promise<RallarOverlayTopologySnapshot | null>;
    readonly topologyPlanning: Pick<GroupTopologyPlanningService, 'readTopologyPlanningAuthority'>;
    /** The deadline's policy read and its submit: activation and formation failure. */
    readonly formationCriterion: Pick<FormationCriterionPort, 'readLifecyclePolicy' | 'submitCommand'>;
    readonly formationAutomation: GroupFormationAutomationPort;
    readonly nowEpochMs: () => number;
}

/**
 * The time leg's consumer. Every queue backend holds entries invisible until
 * their next_ts, so a dequeued entry is normally due; the not-due throw is
 * defense against clock skew between the queue's clock and this node's --
 * the retry release walks the entry forward until this clock agrees. Once
 * due, the only check left is staleness: every transition but the idempotent
 * replan advances the formation epoch, so a group still at the timer's epoch
 * is still in the stage that armed it, and a group past it makes the entry
 * a cheap drop.
 */
export function createFormationTimerWorkHandler(
    options: FormationTimerWorkHandlerOptions
): OnMessageCallback {
    return {
        onMessage: async (message, entry) => {
            await consumeFormationTimer(options, decodeFormationTimerWork(entry.resource), message.id.traceId);
        }
    };
}

async function consumeFormationTimer(
    options: FormationTimerWorkHandlerOptions,
    work: GroupFormationTimerWork,
    traceId: string
): Promise<void> {
    if (options.nowEpochMs() < work.notBeforeEpochMs) {
        throw new Error('Formation timer is not due yet; retry release will walk it forward');
    }
    const snapshot = await readArmingStageSnapshot(options, work);
    if (snapshot === null) {
        return;
    }
    const atEpochMs = options.nowEpochMs();
    switch (work.kind) {
        case 'retry':
            await options.formationAutomation.submitCommand({
                command: toFormationRetryPlanCommand(work),
                atEpochMs,
                traceId
            });
            return;
        case 'plan':
            await options.formationAutomation.submitCommand({
                command: toFormationTriggerPlanCommand(work),
                atEpochMs,
                traceId
            });
            return;
        case 'connect':
            await petitionAwaitingGroupConnectTriggers(options.formationAutomation, work.groupRef, {
                settle: { kind: 'clock', atEpochMs: work.notBeforeEpochMs },
                traceId
            });
            return;
        case 'deadline':
            await evaluateFormationDeadline(options, { work, snapshot, traceId });
            return;
    }
}

/**
 * The group at the timer's own epoch, or null when the group is gone or has
 * moved past the stage that armed the timer. A snapshot still behind the
 * timer throws so the retry release rereads it.
 */
async function readArmingStageSnapshot(
    options: FormationTimerWorkHandlerOptions,
    work: GroupFormationTimerWork
): Promise<GroupSnapshot | null> {
    const snapshot = await options.findGroupSnapshotByRef(work.groupRef, {
        minSnapshotVersion: work.groupSnapshotVersion
    });
    if (!snapshot) {
        return null;
    }
    if (snapshot.group.formationEpoch < work.formationEpoch) {
        throw new Error('Formation timer group snapshot is behind; retry after refreshing group state');
    }
    return snapshot.group.formationEpoch > work.formationEpoch ? null : snapshot;
}

interface EvaluateFormationDeadlineInput {
    readonly work: GroupFormationTimerWork;
    readonly snapshot: GroupSnapshot;
    readonly traceId: string;
}

/**
 * The deadline evaluates the criterion the evidence leg evaluates, on the
 * same function. A dialing group whose planned layout is gone by its
 * deadline — torn down, or never published in a whole deadline — has
 * nothing to fence and no readiness to measure: the attempt fails at once,
 * landing where every failed attempt lands, instead of retrying the
 * durable entry without bound.
 */
async function evaluateFormationDeadline(
    options: FormationTimerWorkHandlerOptions,
    { work, snapshot, traceId }: EvaluateFormationDeadlineInput
): Promise<void> {
    const planned = await options.readPlannedTopology(work.groupRef);
    if (planned === null || planned.state !== 'active') {
        await options.formationCriterion.submitCommand({
            command: toFailFormationCommand({
                groupRef: work.groupRef,
                formationEpoch: work.formationEpoch,
                observedRate: 0,
                expectedLayout: null
            }),
            atEpochMs: options.nowEpochMs(),
            traceId
        });
        return;
    }
    const [authority, lifecyclePolicy] = await Promise.all([
        options.topologyPlanning.readTopologyPlanningAuthority({
            groupRef: work.groupRef,
            knownGroup: snapshot
        }),
        options.formationCriterion.readLifecyclePolicy(work.groupRef)
    ]);
    const command = computeFormationCriterionCommand({
        group: authority.group,
        planned,
        rttMeasurements: authority.rttMeasurements,
        nowEpochMs: authority.nowEpochMs,
        lifecyclePolicy
    });
    if (command === null) {
        return;
    }
    await options.formationCriterion.submitCommand({ command, atEpochMs: authority.nowEpochMs, traceId });
}
