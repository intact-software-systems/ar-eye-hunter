import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { toALOrderingTrackKey, toALSequenceMintTrackKey } from '../../../al-contracts/al-runtime.ts';

/**
 * The candidate as its request would compare to it: what an admission adds to a request is removed -- a sequence
 * minted on the track its request named without one, and the prior-sequence record, the applied supersedence and the
 * proof its request does not carry -- so an admitted copy matches its request while a copy that changes the key, the
 * epoch, a stated sequence, a stated record, a requested supersedence or a carried proof still differs.
 */
export function toALOutboundRequestComparableMessage(original: ALMessage, candidate: ALMessage): ALMessage {
    const unadmitted = toALOutboundUnadmittedMessage(original, candidate);
    return original.qos?.supersedence === undefined ? toALUnstampedMessage(original, unadmitted) : unadmitted;
}

/**
 * The candidate without what an admission adds only once its commit lands -- a minted sequence, a recorded record, a
 * proof -- but with the supersedence the admission applied: that stamp is decided by the first admission's origin and
 * stays part of the request a conflicted admission retains, so its drain never decides it again.
 */
export function toALOutboundUnadmittedMessage(original: ALMessage, candidate: ALMessage): ALMessage {
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

/** The candidate without a supersedence its request did not ask for, its `qos` as the request had it. */
function toALUnstampedMessage(original: ALMessage, message: ALMessage): ALMessage {
    if (message.qos?.supersedence === undefined) {
        return message;
    }
    const { supersedence: _supersedence, ...qos } = message.qos;
    if (original.qos === undefined && Object.keys(qos).length === 0) {
        const { qos: _qos, ...unstamped } = message;
        return unstamped;
    }
    return { ...message, qos };
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
