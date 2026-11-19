import type { ALOutboundAdmissionMutation } from '../admission/al-outbound-admission-mutations.ts';
import type { ALStoredOutboundMessage } from '../admission/al-outbound-admission-validation.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';

/**
 * The end a commit owes its message when the facts it states hold a terminal one: a complete acknowledgement, a
 * receipt that ended, or a relay's refusal of the send. A message already ended is ended once only.
 */
export function toALOutboundSettledMessageEnd(
    sent: ALStoredOutboundMessage | undefined,
    facts: readonly ALOutboundSettlementFact[]
): readonly ALOutboundAdmissionMutation[] {
    const terminal = facts.some((fact) =>
        (fact.kind === 'acknowledgement' && fact.complete) || fact.kind === 'receipt-exhausted' ||
        fact.kind === 'relay-rejected'
    );
    return sent !== undefined && !sent.ended && terminal ? [{ kind: 'end-sent-message', stored: sent }] : [];
}
