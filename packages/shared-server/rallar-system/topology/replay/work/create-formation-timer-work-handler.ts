import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    decodeFormationTimerWork,
    type GroupFormationTimerWork
} from '../../../group-state/formation-timer-outbox-entry.ts';
import {
    toFailFormationCommand,
    toFormationRetryPlanCommand,
    toFormationTriggerPlanCommand
} from '../../../group-state/group-formation-mutation-command.ts';
import type { GroupMutationCommand } from '../../../group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '../../../group-state/persistence/group-lifecycle-policy-repository.ts';
import type { GroupTopologyGroupSnapshotReader } from '../../planning/group-topology-planning-contracts.ts';
import type { GroupTopologyPlanningService } from '../../planning/group-topology-planning-service.ts';
import { computeFormationCriterionCommand } from './compute-formation-criterion-command.ts';
import {
    petitionAwaitingGroupConnectTriggers,
    type GroupFormationAutomationPort
} from './create-group-connect-trigger-work-handler.ts';

interface OnMessageCallback {
    onMessage(message: ALMessage, entry: ResourceEntry): Promise<void>;
}

export interface FormationTimerWorkHandlerOptions {
    readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    readonly readPlannedTopology: (ref: GroupRef) => Promise<RallarOverlayTopologySnapshot | null>;
    readonly topologyPlanning: Pick<GroupTopologyPlanningService, 'readTopologyPlanningAuthority'>;
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
    /** The criterion's submit: activation and formation failure. */
    readonly submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
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
        onMessage: async (_message, entry) => {
            await consumeFormationTimer(options, decodeFormationTimerWork(entry.resource));
        }
    };
}

async function consumeFormationTimer(
    options: FormationTimerWorkHandlerOptions,
    work: GroupFormationTimerWork
): Promise<void> {
    if (options.nowEpochMs() < work.notBeforeEpochMs) {
        throw new Error('Formation timer is not due yet; retry release will walk it forward');
    }
    const snapshot = await options.findGroupSnapshotByRef(work.groupRef, {
        minSnapshotVersion: work.groupSnapshotVersion
    });
    if (!snapshot) {
        return;
    }
    if (snapshot.group.formationEpoch < work.formationEpoch) {
        throw new Error('Formation timer group snapshot is behind; retry after refreshing group state');
    }
    if (snapshot.group.formationEpoch > work.formationEpoch) {
        return;
    }
    const nowEpochMs = options.nowEpochMs();
    switch (work.kind) {
        case 'retry':
            await options.formationAutomation.submitCommand(toFormationRetryPlanCommand(work), nowEpochMs);
            return;
        case 'plan':
            await options.formationAutomation.submitCommand(toFormationTriggerPlanCommand(work), nowEpochMs);
            return;
        case 'connect':
            await petitionAwaitingGroupConnectTriggers(options.formationAutomation, work.groupRef, {
                kind: 'clock',
                atEpochMs: work.notBeforeEpochMs
            });
            return;
        case 'deadline':
            await evaluateFormationDeadline(options, work, snapshot);
            return;
    }
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
    work: GroupFormationTimerWork,
    snapshot: GroupSnapshot
): Promise<void> {
    const planned = await options.readPlannedTopology(work.groupRef);
    if (planned === null || planned.state !== 'active') {
        await options.submitCommand(
            toFailFormationCommand({
                groupRef: work.groupRef,
                formationEpoch: work.formationEpoch,
                observedRate: 0,
                expectedLayout: null
            }),
            options.nowEpochMs()
        );
        return;
    }
    const [authority, lifecyclePolicy] = await Promise.all([
        options.topologyPlanning.readTopologyPlanningAuthority({
            groupRef: work.groupRef,
            knownGroup: snapshot
        }),
        options.readLifecyclePolicy(work.groupRef)
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
    await options.submitCommand(command, authority.nowEpochMs);
}
