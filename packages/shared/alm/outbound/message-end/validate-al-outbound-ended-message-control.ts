import { isALOutsideAudienceNackReason } from '../../delivery/is-al-outside-audience-nack-reason.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import { toALOutboundRefusalIssue, type ALOutboundControlIssue } from '../control/read-al-outbound-recipient-proof.ts';
import { isALOutboundReceiptComplete } from '../transition-al-outbound-pending-ack.ts';

type ALOutboundEndedMessageControlRead = Pick<ALControlAdmissionRead, 'parsed' | 'sent' | 'pending'>;

/**
 * A control for a message that has ended is refused, except a gap report and a repair request, which name the message
 * whose arrival revealed the gap, not the missing one, so the missing sequence's repair finds its own end. A kept
 * incomplete receipt row is the final snapshot of the terminal settlement: an ACK or an outside-audience NACK would
 * rewrite it and state a settlement after that one, so both are refused while it stands. A kept complete row still
 * admits them as before.
 */
export function validateALOutboundEndedMessageControl(
    read: ALOutboundEndedMessageControlRead
): readonly ALOutboundControlIssue[] {
    return read.sent?.ended === true && isRefusedOnEndedMessage(read)
        ? [toALOutboundRefusalIssue('AL control names a message that has ended')]
        : [];
}

function isRefusedOnEndedMessage(read: ALOutboundEndedMessageControlRead): boolean {
    const { parsed } = read;
    if (parsed.type === 'repair' || (parsed.type === 'nack' && parsed.payload.reason === 'gap')) {
        return false;
    }
    if (parsed.type === 'ack' || isALOutsideAudienceNackReason(parsed.payload.reason)) {
        return read.pending !== undefined && !isALOutboundReceiptComplete(read.pending);
    }
    return true;
}
