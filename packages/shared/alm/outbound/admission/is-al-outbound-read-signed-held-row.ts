import { NOT_COMPLETED_RETRYABLE_STATUSES } from '../../../queuebox/ResourceEntry.ts';
import type { ALOutboundMessageReadDto } from './al-outbound-admission-store.ts';

/**
 * Whether this read's signer signed an unsigned request whose stored row is unsigned too, still awaits its first
 * dispatch and has not ended. A row a dispatch completed keeps what that dispatch stored, and an ended row stays
 * ended: storing over it would send a message whose terminal settlement was already stated.
 */
export function isALOutboundReadSignedHeldRow<TPrepared>(read: ALOutboundMessageReadDto<TPrepared>): boolean {
    const signedByRead = read.originalMsg.proof === undefined && read.msg.proof !== undefined;
    const storedUnsigned = read.sentSnapshot !== undefined && read.sentSnapshot.msg.proof === undefined;
    const awaitsDispatch = read.canonicalEntry !== undefined &&
        NOT_COMPLETED_RETRYABLE_STATUSES.has(read.canonicalEntry.status);
    return signedByRead && storedUnsigned && awaitsDispatch && read.storedMessage?.ended !== true;
}
