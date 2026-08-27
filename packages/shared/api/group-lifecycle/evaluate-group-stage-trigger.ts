import type { GroupStageTrigger } from './group-lifecycle-policy.ts';

export type GroupStageTriggerDecision =
    | 'fire'
    | 'wait';

export interface EvaluateGroupStageTriggerInput {
    readonly trigger: GroupStageTrigger;
    readonly stageEnteredAtEpochMs: number;
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
    if (trigger.kind === 'manual') {
        return 'wait';
    }
    if (trigger.kind === 'immediate') {
        return 'fire';
    }
    if (trigger.kind === 'after') {
        return input.nowEpochMs - input.stageEnteredAtEpochMs >= trigger.settleMs ? 'fire' : 'wait';
    }
    if (input.livePresenceMemberCount >= trigger.memberCount) {
        return 'fire';
    }
    return input.nowEpochMs - input.stageEnteredAtEpochMs >= trigger.fallbackMs ? 'fire' : 'wait';
}
