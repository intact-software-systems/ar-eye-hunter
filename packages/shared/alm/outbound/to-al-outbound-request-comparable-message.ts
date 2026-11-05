import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { toALOrderingTrackKey, toALSequenceMintTrackKey } from '../../al-contracts/al-runtime.ts';

/**
 * The candidate as its request would compare to it: what an admission adds to a request is removed -- a sequence
 * minted on the track its request named without one, and the prior-sequence record and the proof its request does
 * not carry -- so an admitted copy matches its request while a copy that changes the key, the epoch, a stated
 * sequence, a stated record or a carried proof still differs.
 */
export function toALOutboundRequestComparableMessage(original: ALMessage, candidate: ALMessage): ALMessage {
    const unsigned = original.proof === undefined ? toALUnsignedMessage(candidate) : candidate;
    const unrecorded = original.ordering?.priorSeqByRecipient === undefined
        ? toALUnrecordedMessage(unsigned)
        : unsigned;
    return toALOutboundUnmintedMessage(original, unrecorded);
}

/**
 * The candidate without a sequence minted on the track its request named without one: the one addition an outbound
 * makes before its planner's message is checked. Every other field stays, so a stated sequence still differs.
 */
export function toALOutboundUnmintedMessage(original: ALMessage, candidate: ALMessage): ALMessage {
    return toALSequenceMintTrackKey(original) !== undefined &&
            toALOrderingTrackKey(candidate) === toALSequenceMintTrackKey(original)
        ? toALUnsequencedMessage(candidate)
        : candidate;
}

function toALUnsignedMessage(message: ALMessage): ALMessage {
    if (message.proof === undefined) {
        return message;
    }
    const { proof: _proof, ...unsigned } = message;
    return unsigned;
}

function toALUnrecordedMessage(message: ALMessage): ALMessage {
    if (message.ordering?.priorSeqByRecipient === undefined) {
        return message;
    }
    const { priorSeqByRecipient: _priorSeqByRecipient, ...ordering } = message.ordering;
    return { ...message, ordering };
}

function toALUnsequencedMessage(message: ALMessage): ALMessage {
    if (message.ordering?.seq === undefined) {
        return message;
    }
    const { seq: _seq, ...ordering } = message.ordering;
    return { ...message, ordering };
}
