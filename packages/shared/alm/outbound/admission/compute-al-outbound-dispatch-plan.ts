import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { isALFreezeOfMessage } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';
import { validateALOutboundPlannedMessage } from '../validate-al-outbound-dispatch.ts';
import type { ALOutboundOutgoingReadInput } from './al-outbound-admission-store.ts';
import { applyALOutboundCapturedPolicy, type ALStoredOutboundMessage } from './al-outbound-admission-validation.ts';

/** Applies the planned message's captured authority before the read owner fetches its fences. */
export function computeALOutboundDispatchPlan<TPrepared>(
    outgoing: ALOutboundOutgoingReadInput<TPrepared>,
    canonical: ALMessage | undefined,
    stored: ALStoredOutboundMessage | undefined
): ALOutboundDispatchPlan<TPrepared> {
    const { msg, intent } = outgoing;
    const authority = stored?.policy ?? outgoing.dequeueAuthority;
    const source = canonical ?? msg;
    const selected = outgoing.planner(
        source,
        authority === undefined ? undefined : {
            admittedAudience: authority.admittedAudience,
            recipientScope: authority.recipientScope,
            principalTargetId: authority.principalTargetId,
            sessionInvalidation: authority.sessionInvalidation,
            referenceKey: stored ? stored.reference.key : outgoing.observedCanonicalEntry?.key
        }
    );
    requireALOutboundPlannedMessage(source, selected.msg);
    const planned = canonical && !isALFreezeOfMessage(canonical, selected.msg)
        ? { ...selected, msg: canonical }
        : selected;
    const plan = intent !== 'repair' && stored ? applyALOutboundCapturedPolicy(planned, stored.policy) : planned;
    requireALOutboundPlannedMessage(msg, plan.msg);
    return plan;
}

export function requireALOutboundPlannedMessage(source: ALMessage, planned: ALMessage): void {
    const issues = validateALOutboundPlannedMessage(source, planned);
    if (issues.length > 0) {
        throw new NonRetryableException(issues.map((issue) => issue.message).join('; '));
    }
}
