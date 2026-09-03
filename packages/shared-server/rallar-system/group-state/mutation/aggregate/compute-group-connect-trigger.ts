import { toStageTriggerTimerDelayMs } from '@shared/api/group-lifecycle/evaluate-group-stage-trigger.ts';
import { toGroupLayoutIdentity, type GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupLifecyclePolicy, GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { holdsPlannedCandidateAt } from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { RuntimeStateGuardedBatchEffect } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { opensPlannedCandidateStage } from '../../formation-timer-outbox-entry.ts';
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
 * `after` from its settle on, under `presence` from its fallback on — or
 * sooner, when the member threshold is met and the topology cycle petitions
 * the latch as satisfied — and `manual` arms nothing. A
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
    // A re-plan behind a spent attempt continues a series the application
    // already started, whatever the trigger says and whatever the formation
    // mode: it dials as soon as its layout publishes, because the trigger
    // that opened the series has already been satisfied once. The plan
    // trigger only ever plans a fresh series, at attempt zero.
    if (facts.internalAuthority === 'formation-automation' && next.formationAttemptCount > 0) {
        return latchAwaitingPublication(input, 0);
    }
    const delayMs = policy.formation === 'phased'
        ? toStageTriggerTimerDelayMs(policy.establishment.connectTrigger)
        : null;
    if (delayMs === null) {
        return NO_CONNECT_TRIGGER;
    }
    // `immediate` carries no floor at all rather than this node's clock: it
    // has no timer leg, so a publication petitioned from a node whose clock
    // lags this one must not be gated out with nothing left to wake it.
    return latchAwaitingPublication(input, delayMs === 0 ? 0 : facts.nowEpochMs + delayMs);
}

/**
 * A command that lands the group in a stage holding a candidate: `plan` from
 * `forming`, and the `reconfigure` that opens `reconfiguring`. Both arm; what
 * separates them is which publication satisfies the latch. A `reconfigure`
 * commands its own replan, so at arming time the planned slot still holds the
 * layout it means to replace — the latch names that layout and waits for a
 * different one (plan slice 11d). A `plan` names nothing, because its replan
 * may be skipped as unchanged and the standing candidate is then the one to
 * dial. The idempotent replan from `planned` is excluded by the stage change.
 */
function entersHeldStage(
    command: GroupMutationCommand,
    previous: GroupLifecycleState | null,
    next: Group
): boolean {
    return opensPlannedCandidateStage(command.operation) &&
        holdsPlannedCandidateAt(next.lifecycleState) && previous !== next.lifecycleState;
}

/** The candidate a `reconfigure` supersedes: the one its own replan replaces. */
function resolveSupersededLayoutIdentity(input: ComputeGroupConnectTriggerInput): GroupLayoutIdentity | null {
    if (input.command.operation !== 'reconfigureGroup' || input.read.plannedLayoutRow === null) {
        return null;
    }
    return toGroupLayoutIdentity(input.read.plannedLayoutRow.snapshot);
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
        supersedesLayoutIdentity: resolveSupersededLayoutIdentity(input),
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
