import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    decodeFormationTimerWork,
    type GroupFormationTimerWork
} from '../../group-state/formation-timer-outbox-entry.ts';
import { toFormationRetryEstablishCommand } from '../../group-state/group-formation-mutation-command.ts';
import type { GroupMutationCommand } from '../../group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '../../group-state/persistence/group-lifecycle-policy-repository.ts';
import type { GroupTopologyPlanningService } from '../planning/group-topology-planning-service.ts';
import { computeFormationCriterionCommand } from './compute-formation-criterion-command.ts';

interface OnMessageCallback {
    onMessage(message: ALMessage, entry: ResourceEntry): Promise<void>;
}

export interface FormationTimerWorkHandlerOptions {
    readonly findGroupSnapshotByRef: (ref: GroupRef) => Promise<GroupSnapshot | undefined>;
    readonly readPlannedTopology: (ref: GroupRef) => Promise<RallarOverlayTopologySnapshot | null>;
    readonly topologyPlanning: Pick<GroupTopologyPlanningService, 'readTopologyPlanningAuthority'>;
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
    readonly submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
    readonly nowEpochMs: () => number;
}

/**
 * The time leg's consumer. Every queue backend holds entries invisible until
 * their next_ts, so a dequeued entry is normally due; the not-due throw is
 * defense against clock skew between the queue's clock and this node's --
 * the retry release walks the entry forward until this clock agrees. Once
 * due, the only checks left are staleness -- the group moved on (epoch or
 * state mismatch) is a cheap drop -- and the criterion itself, evaluated by
 * the same function the evidence leg uses.
 */
export function createFormationTimerWorkHandler(
    options: FormationTimerWorkHandlerOptions
): OnMessageCallback {
    return {
        onMessage: async (_message, entry) => {
            await processFormationTimerWork(options, decodeFormationTimerWork(entry.resource));
        }
    };
}

async function processFormationTimerWork(
    options: FormationTimerWorkHandlerOptions,
    work: GroupFormationTimerWork
): Promise<void> {
    if (options.nowEpochMs() < work.notBeforeEpochMs) {
        throw new Error('Formation timer is not due yet; retry release will walk it forward');
    }
    const snapshot = await options.findGroupSnapshotByRef(work.groupRef);
    if (!snapshot || snapshot.group.formationEpoch !== work.formationEpoch) {
        return;
    }
    const nowEpochMs = options.nowEpochMs();
    if (work.kind === 'retry') {
        if (snapshot.group.lifecycleState !== 'forming') {
            return;
        }
        await options.submitCommand(
            toFormationRetryEstablishCommand({
                groupRef: work.groupRef,
                formationEpoch: work.formationEpoch
            }),
            nowEpochMs
        );
        return;
    }
    const lifecycleState = snapshot.group.lifecycleState;
    if (lifecycleState !== 'establishing' && lifecycleState !== 'reconfiguring') {
        return;
    }
    const [authority, planned] = await Promise.all([
        options.topologyPlanning.readTopologyPlanningAuthority({
            groupRef: work.groupRef,
            knownGroup: snapshot,
            snapshotSelection: 'prefer-current'
        }),
        options.readPlannedTopology(work.groupRef)
    ]);
    if (planned === null) {
        return;
    }
    const command = await computeFormationCriterionCommand({
        group: authority.group,
        planned,
        rttMeasurements: authority.rttMeasurements,
        nowEpochMs: authority.nowEpochMs,
        readLifecyclePolicy: options.readLifecyclePolicy
    });
    if (command === null) {
        return;
    }
    await options.submitCommand(command, authority.nowEpochMs);
}
