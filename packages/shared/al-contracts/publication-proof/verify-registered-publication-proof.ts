import { resolvePublicationKey } from '../../api/group-presence/resolve-publication-key.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import type { VerificationKeyCache } from '../../signature/verification-key-cache.ts';
import type { ALMessage } from '../al-contract.ts';
import { verifyALPublicationProof } from './al-publication-proof.ts';

export interface VerifyRegisteredPublicationProofInput {
    readonly message: ALMessage;
    readonly snapshot: GroupSnapshot;
    readonly nowEpochMs: number;
    readonly subtle: SubtleCrypto;
    readonly keys: VerificationKeyCache;
}

/** Verify the original envelope with the publication key registered by its live sender session in this room. */
export async function verifyRegisteredPublicationProof(input: VerifyRegisteredPublicationProofInput): Promise<boolean> {
    const { message, snapshot, nowEpochMs, subtle, keys } = input;
    const registered = resolvePublicationKey(snapshot, message.id.senderId, nowEpochMs);
    if (registered === null || registered.keyId !== message.proof?.keyId) {
        return false;
    }
    const publicKey = await keys.readVerificationKey(subtle, registered);
    return publicKey !== undefined &&
        (await verifyALPublicationProof({ subtle, publicKey, message })).right !== undefined;
}
