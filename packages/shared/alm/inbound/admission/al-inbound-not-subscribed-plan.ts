import type { ALAckStatus } from '../../../al-contracts/al-control.ts';
import type { ALMessageHandlingPlan } from '../../../al-contracts/al-policy.ts';

/** A frozen recipient that delivers nothing answers `not-subscribed` for itself and never confirms itself. */
export function isALInboundNotSubscribedPlan(plan: ALMessageHandlingPlan): boolean {
    return plan.nack.enabled && plan.nack.reason === 'not-subscribed';
}

/** How this peer ends its hop when it delivered nothing: a not-subscribed recipient's ending confirms nobody. */
export function toALInboundHopCompletionStatus(plan: ALMessageHandlingPlan): ALAckStatus {
    return isALInboundNotSubscribedPlan(plan) ? 'subtree-complete-not-subscribed' : 'subtree-complete';
}
