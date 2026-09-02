import type { GroupLifecyclePolicy, GroupLifecycleState, GroupStageTrigger } from './group-lifecycle-policy.ts';

export type GroupStageTriggerDecision =
    | 'fire'
    | 'wait';

export interface EvaluateGroupStageTriggerInput {
    readonly trigger: GroupStageTrigger;
    /**
     * When the group entered the stage this trigger governs; null for a
     * caller whose elapsed half is owned by the durable timer leg, which
     * leaves only the facts that can be observed now.
     */
    readonly stageEnteredAtEpochMs: number | null;
    readonly nowEpochMs: number;
    readonly livePresenceMemberCount: number;
}

/**
 * Pure evaluation of one automatic stage boundary (product decision 8).
 * `manual` never fires — the boundary belongs to an application command — and
 * `presence` fires on its member threshold or its timer fallback, whichever
 * comes first. Arming the fallback timer durably is the trigger owner's job;
 * this function only answers whether the boundary is satisfied now.
 */
export function evaluateGroupStageTrigger(
    input: EvaluateGroupStageTriggerInput
): GroupStageTriggerDecision {
    const { trigger } = input;
    switch (trigger.kind) {
        case 'manual':
            return 'wait';
        case 'immediate':
            return 'fire';
        case 'after':
            return hasStageElapsed(input, trigger.settleMs) ? 'fire' : 'wait';
        case 'presence':
            if (input.livePresenceMemberCount >= trigger.memberCount) {
                return 'fire';
            }
            return hasStageElapsed(input, trigger.fallbackMs) ? 'fire' : 'wait';
    }
}

function hasStageElapsed(input: EvaluateGroupStageTriggerInput, delayMs: number): boolean {
    return input.stageEnteredAtEpochMs !== null && input.nowEpochMs - input.stageEnteredAtEpochMs >= delayMs;
}

/**
 * The delay after a stage entry at which the trigger's durable timer leg is
 * due: `immediate` at the entry, `after` at its settle, `presence` at its
 * fallback — the half of the threshold-or-fallback rule that cannot be
 * observed from presence alone. `manual` has no timer leg.
 */
export function toStageTriggerTimerDelayMs(trigger: GroupStageTrigger): number | null {
    switch (trigger.kind) {
        case 'immediate':
            return 0;
        case 'after':
            return trigger.settleMs;
        case 'presence':
            return trigger.fallbackMs;
        case 'manual':
            return null;
    }
}

/**
 * The trigger that governs a group's next automatic boundary, or null where
 * no trigger does. `forming` is governed by the plan trigger and `planned`
 * by the connect trigger; `reconfiguring` holds a planned candidate too, but
 * its boundary is an application `connect` until a latch can name the
 * publication it waits for.
 */
export function resolveGroupStageTrigger(
    policy: GroupLifecyclePolicy,
    lifecycleState: GroupLifecycleState
): GroupStageTrigger | null {
    switch (lifecycleState) {
        case 'forming':
            return policy.establishment.planTrigger;
        case 'planned':
            return policy.establishment.connectTrigger;
        default:
            return null;
    }
}
