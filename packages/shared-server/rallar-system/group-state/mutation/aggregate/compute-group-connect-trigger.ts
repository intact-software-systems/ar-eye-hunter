import { toStageTriggerSettleMs } from '@shared/api/group-lifecycle/evaluate-group-stage-trigger.ts';
import type { GroupLifecyclePolicy, GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { holdsPlannedCandidateAt } from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { RuntimeStateGuardedBatchEffect } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { computeGroupConnectTriggerEntry } from '../../group-connect-trigger-outbox-entry.ts';
import { toGroupConnectTriggerLatchEffect } from '../../persistence/group-connect-trigger-latch-repository.ts';
import type { GroupMutationCommand, GroupMutationFacts, GroupMutationRead } from '../group-mutation-contracts.ts';

export interface GroupConnectTriggerComputed {
    readonly effect: RuntimeStateGuardedBatchEffect | null;
    readonly outboxEntries: readonly ResourceEntry[];
}

export interface ComputeGroupConnectTriggerInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly next: Group;
    readonly policy: GroupLifecyclePolicy;
    /** The stage the group held before this write; null when the write creates the group. */
    readonly previous: GroupLifecycleState | null;
}

const NO_CONNECT_TRIGGER: GroupConnectTriggerComputed = { effect: null, outboxEntries: [] };

/**
 * Trigger satisfaction is durably latched until a matching `connect` commits
 * (product decision 32). The connect trigger arms when a phased group enters
 * a stage that holds a planned candidate (product decision 8): under
 * `immediate` the group may connect as soon as the layout publishes, under
 * `after` from its settle on, and `manual` or `presence` arm nothing. A
 * re-plan behind a spent attempt latches regardless — it continues a series
 * the application already started, which is what the attempt budget bounds
 * (product decision 37). An automatic `connect` consumes the latch it names.
 */
export function computeGroupConnectTrigger(input: ComputeGroupConnectTriggerInput): GroupConnectTriggerComputed {
    const { command, read, facts, next, policy, previous } = input;
    if (
        command.operation === 'connectGroup' && facts.internalAuthority === 'formation-automation' &&
        read.connectTriggerLatch !== null
    ) {
        return {
            effect: toGroupConnectTriggerLatchEffect(
                { ...read.connectTriggerLatch.latch, state: 'consumed' },
                read.connectTriggerLatch.revision
            ),
            outboxEntries: []
        };
    }
    if (!entersHeldStage(command, previous, next)) {
        return NO_CONNECT_TRIGGER;
    }
    const settleMs = policy.formation === 'phased'
        ? toStageTriggerSettleMs(policy.establishment.connectTrigger)
        : null;
    if (settleMs !== null) {
        return latchAwaitingPublication(input, settleMs === 0 ? 0 : facts.nowEpochMs + settleMs);
    }
    // A re-plan behind a spent attempt continues a series the application
    // already started, whatever the trigger says and whatever the formation
    // mode: the plan trigger only ever plans a fresh series, at attempt zero.
    const continuesSanctionedSeries = facts.internalAuthority === 'formation-automation' &&
        next.formationAttemptCount > 0;
    return continuesSanctionedSeries ? latchAwaitingPublication(input, 0) : NO_CONNECT_TRIGGER;
}

/**
 * A plan that lands a fresh candidate in a stage that holds one. The
 * reconfigure that opens `reconfiguring` is deliberately not an arming site:
 * its own replan has not published yet, so a latch armed there would petition
 * against the layout the reconfigure means to replace and freeze it by
 * dialing. `reconfiguring` still waits for an application `connect`; the
 * automatic boundary out of it needs the latch to name the publication it
 * waits for, which is the next slice's work.
 */
function entersHeldStage(
    command: GroupMutationCommand,
    previous: GroupLifecycleState | null,
    next: Group
): boolean {
    return command.operation === 'planGroupLayout' &&
        holdsPlannedCandidateAt(next.lifecycleState) && previous !== next.lifecycleState;
}

function latchAwaitingPublication(
    input: ComputeGroupConnectTriggerInput,
    notBeforeEpochMs: number
): GroupConnectTriggerComputed {
    const { command, facts, next } = input;
    const latch = {
        groupRef: command.aggregateRef,
        formationEpoch: next.formationEpoch,
        triggerGeneration: command.commandId,
        notBeforeEpochMs,
        state: 'awaiting-publication'
    } as const;
    return {
        effect: toGroupConnectTriggerLatchEffect(latch, null),
        outboxEntries: [computeGroupConnectTriggerEntry({
            work: {
                kind: 'intent',
                groupRef: latch.groupRef,
                formationEpoch: latch.formationEpoch,
                triggerGeneration: latch.triggerGeneration,
                wakeIdentity: command.commandId
            },
            senderId: facts.serviceId,
            createdAtEpochMs: facts.nowEpochMs,
            expireAtEpochMs: facts.expireAtEpochMs
        })]
    };
}
