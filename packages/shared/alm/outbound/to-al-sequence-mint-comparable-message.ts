import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { toALOrderingTrackKey, toALSequenceMintTrackKey } from '../../al-contracts/al-runtime.ts';

/**
 * The candidate as the original would compare to it: a sequence minted on the track its original named
 * without one is removed, so a minted copy matches its request while a copy that changes the key, the epoch
 * or a stated sequence still differs.
 */
export function toALSequenceMintComparableMessage(original: ALMessage, candidate: ALMessage): ALMessage {
    if (
        toALSequenceMintTrackKey(original) === undefined || candidate.ordering?.seq === undefined ||
        toALOrderingTrackKey(candidate) !== toALSequenceMintTrackKey(original)
    ) {
        return candidate;
    }
    const { seq: _seq, ...ordering } = candidate.ordering;
    return { ...candidate, ordering };
}
