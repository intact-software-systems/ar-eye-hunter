import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { isALFreezeOfMessage } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isKeysEqual } from '../../../queuebox/ResourceEntry.ts';
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
            admittedAudience: toAttemptAudience(authority.admittedAudience, readRecheckedAudience(outgoing, stored)),
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

/** The dequeue authority re-checks the stored row only when it was read for that row, not for a canonical row that won. */
function readRecheckedAudience<TPrepared>(
    outgoing: ALOutboundOutgoingReadInput<TPrepared>,
    stored: ALStoredOutboundMessage | undefined
): readonly string[] | undefined {
    const observedKey = outgoing.observedCanonicalEntry?.key;
    return stored === undefined || (observedKey !== undefined && isKeysEqual(stored.reference.key, observedKey))
        ? outgoing.dequeueAuthority?.admittedAudience
        : undefined;
}

/**
 * A dequeue attempt plans over the captured audience as its own authority read re-checked it (D498): the re-check only
 * narrows, and the captured policy the plan then applies keeps the admitted audience for the next attempt.
 */
function toAttemptAudience(
    captured: readonly string[] | undefined,
    rechecked: readonly string[] | undefined
): readonly string[] | undefined {
    return captured === undefined || rechecked === undefined
        ? captured
        : captured.filter((sessionId) => rechecked.includes(sessionId));
}

export function requireALOutboundPlannedMessage(source: ALMessage, planned: ALMessage): void {
    const issues = validateALOutboundPlannedMessage(source, planned);
    if (issues.length > 0) {
        throw new NonRetryableException(issues.map((issue) => issue.message).join('; '));
    }
}
