import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { isALFreezeOfMessage } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isKeysEqual, type Key } from '../../../queuebox/ResourceEntry.ts';
import type { ALOutboundDequeueAuthority, ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';
import { toALMessageWithAppliedSupersedence } from '../supersedence/to-al-message-with-applied-supersedence.ts';
import {
    validateALOutboundAdmittedMessage,
    validateALOutboundPlannedMessage
} from '../validate-al-outbound-dispatch.ts';
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
    const rechecked = resolveALOutboundAppliedDequeueAuthority(
        outgoing.dequeueAuthority,
        stored?.reference.key,
        outgoing.observedCanonicalEntry?.key
    );
    const selected = outgoing.planner(
        source,
        authority === undefined ? undefined : {
            admittedAudience: toAttemptAudience(authority.admittedAudience, rechecked?.admittedAudience),
            admittedConnectionGenerationIds: stored?.policy.admittedConnectionGenerationIds,
            recipientScope: authority.recipientScope,
            principalTargetId: authority.principalTargetId,
            sessionInvalidation: authority.sessionInvalidation,
            accountView: authority.accountView,
            referenceKey: stored ? stored.reference.key : outgoing.observedCanonicalEntry?.key
        }
    );
    requireALOutboundPlannedMessage(source, selected.msg);
    const planned = canonical && !isALFreezeOfMessage(canonical, selected.msg)
        ? { ...selected, msg: canonical }
        : selected;
    const captured = intent !== 'repair' && stored ? applyALOutboundCapturedPolicy(planned, stored.policy) : planned;
    // Before the read mints, records and signs, so the proof covers the stamp; a signed or requested one stays.
    const plan = outgoing.stampsAppliedSupersedence
        ? { ...captured, msg: toALMessageWithAppliedSupersedence(captured.msg, captured.supersedenceTracking) }
        : captured;
    requireALOutboundAdmittedMessage(msg, plan.msg);
    return plan;
}

/**
 * The dequeue authority applies to the stored row only when it was read for that row, not for a canonical row that won;
 * with no row stored yet, the plan is for the observed row the authority was read for.
 */
export function resolveALOutboundAppliedDequeueAuthority(
    authority: ALOutboundDequeueAuthority | undefined,
    storedKey: Key | undefined,
    observedKey: Key | undefined
): ALOutboundDequeueAuthority | undefined {
    return storedKey === undefined || (observedKey !== undefined && isKeysEqual(storedKey, observedKey))
        ? authority
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
    if (captured === undefined || rechecked === undefined) {
        return captured;
    }
    const eligible = new Set(rechecked);
    return captured.filter((sessionId) => eligible.has(sessionId));
}

export function requireALOutboundPlannedMessage(source: ALMessage, planned: ALMessage): void {
    throwALOutboundMessageRejections(validateALOutboundPlannedMessage(source, planned));
}

/** The plan's message against the request: it may be the stored copy, carrying what its admission added. */
function requireALOutboundAdmittedMessage(request: ALMessage, admitted: ALMessage): void {
    throwALOutboundMessageRejections(validateALOutboundAdmittedMessage(request, admitted));
}

function throwALOutboundMessageRejections(issues: readonly ALMessageRejection[]): void {
    if (issues.length > 0) {
        throw new NonRetryableException(issues.map((issue) => issue.message).join('; '));
    }
}
