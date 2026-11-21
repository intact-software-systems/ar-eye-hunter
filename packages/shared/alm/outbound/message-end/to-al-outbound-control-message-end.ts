import type { ALOutboundAdmissionMutation } from '../admission/al-outbound-admission-mutations.ts';
import type { ALControlAdmissionCandidate } from '../compute-al-outbound-control-admission.ts';
import { resolveALOutboundRelayRejection } from '../control/resolve-al-outbound-relay-rejection.ts';
import { isALOutboundReceiptComplete } from '../transition-al-outbound-pending-ack.ts';

/**
 * The control commit's end of its message: a relay's refusal of the send, a receipt the control completed, or an open
 * receipt it removed is the terminal settlement the commit states. A message already ended is ended once only.
 */
export function toALOutboundControlMessageEnd(
    candidate: Pick<ALControlAdmissionCandidate, 'read' | 'pending'>
): readonly ALOutboundAdmissionMutation[] {
    const { read, pending } = candidate;
    const settles = resolveALOutboundRelayRejection(read) !== undefined ||
        (pending.kind === 'set' && isALOutboundReceiptComplete(pending.value)) ||
        (pending.kind === 'remove' && read.pending !== undefined);
    return settles && read.sent !== undefined && !read.sent.ended
        ? [{ kind: 'end-sent-message', stored: read.sent }]
        : [];
}
