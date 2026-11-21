import { isALOutsideAudienceNackReason } from '../../delivery/is-al-outside-audience-nack-reason.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import { toALOutboundRefusalIssue, type ALOutboundControlIssue } from '../control/read-al-outbound-recipient-proof.ts';
import { isALOutboundReceiptComplete } from '../transition-al-outbound-pending-ack.ts';

/**
 * A control for a message that has ended is refused, except a gap report and an outside-audience NACK, and an ACK on a
 * kept complete receipt row: a gap NACK names the message whose arrival revealed the gap, not the missing one, and the
 * missing sequence's repair finds its own end. An ACK on a kept incomplete row would complete a receipt whose terminal
 * settlement was already stated, so the row stays the final snapshot it was.
 */
export function validateALOutboundEndedMessageControl(
    read: Pick<ALControlAdmissionRead, 'parsed' | 'sent' | 'pending'>
): readonly ALOutboundControlIssue[] {
    return read.sent?.ended === true && (isRefusedEndedNack(read) || isRefusedEndedAck(read))
        ? [toALOutboundRefusalIssue('AL control names a message that has ended')]
        : [];
}

function isRefusedEndedNack(read: Pick<ALControlAdmissionRead, 'parsed'>): boolean {
    const { parsed } = read;
    return parsed.type === 'nack' && parsed.payload.reason !== 'gap' &&
        !isALOutsideAudienceNackReason(parsed.payload.reason);
}

function isRefusedEndedAck(read: Pick<ALControlAdmissionRead, 'parsed' | 'pending'>): boolean {
    return read.parsed.type === 'ack' && read.pending !== undefined && !isALOutboundReceiptComplete(read.pending);
}
