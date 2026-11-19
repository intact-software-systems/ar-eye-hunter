import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { isALOutsideAudienceNackReason } from '../../delivery/is-al-outside-audience-nack-reason.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';

/**
 * A NACK for a message that has ended is refused, except a gap report and an outside-audience one: a gap NACK names
 * the message whose arrival revealed the gap, not the missing one, and the missing sequence's repair finds its own end.
 */
export function validateALOutboundEndedMessageControl(
    read: Pick<ALControlAdmissionRead, 'parsed' | 'sent'>
): readonly ALMessageRejection[] {
    const { parsed } = read;
    if (
        !read.sent?.ended || parsed.type !== 'nack' || parsed.payload.reason === 'gap' ||
        isALOutsideAudienceNackReason(parsed.payload.reason)
    ) {
        return [];
    }
    return [{ code: 'unauthorized', message: 'AL control names a message that has ended' }];
}
