import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { signALPublicationProof } from '../../al-contracts/publication-proof/al-publication-proof.ts';
import { resolvePublicationKey } from '../../api/group-presence/resolve-publication-key.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';
import type { PublicationCrypto } from '../../signature/publication-crypto.ts';
import { isRtcUnfrozenRoomMessage } from '../web-rtc-overlay-frozen-audience.ts';

export interface SignRtcPublicationInput {
    readonly crypto: PublicationCrypto;
    /** The origin's cached snapshot of the message's room; `null` when it holds none. */
    readonly snapshot: GroupSnapshot | null;
    readonly selfSessionId: string;
    readonly nowEpochMs: number;
    /** The admitted message: frozen to its room audience and normalized, so its signed fields never change again. */
    readonly message: ALMessage;
}

export interface RtcPublicationSigningFailure {
    readonly kind: 'signing-unavailable' | 'no-authority' | 'key-not-registered' | 'unfrozen-audience' | 'sign-failed';
    readonly message: string;
}

/** The origin signs a granted publication only with the key its own room snapshot attests for its session. */
export async function signRtcPublication(
    input: SignRtcPublicationInput
): Promise<Either<RtcPublicationSigningFailure, ALMessage>> {
    const { crypto, snapshot, message } = input;
    if (crypto.kind === 'unavailable') {
        return toSigningFailure('signing-unavailable', `This page cannot sign a publication: ${crypto.reason}.`);
    }
    if (snapshot === null) {
        return toSigningFailure('no-authority', 'The origin holds no snapshot of the room to attest its key.');
    }
    if (resolvePublicationKey(snapshot, input.selfSessionId, input.nowEpochMs)?.keyId !== crypto.keyPair.keyId) {
        return toSigningFailure('key-not-registered', 'The room snapshot does not yet name this page\'s key.');
    }
    if (isRtcUnfrozenRoomMessage(message)) {
        return toSigningFailure('unfrozen-audience', 'The room admission froze no audience for the publication.');
    }
    const signed = await signALPublicationProof({ subtle: crypto.subtle, keyPair: crypto.keyPair, message });
    return signed.mapLeft((failure) => ({ kind: 'sign-failed', message: failure.message }));
}

function toSigningFailure(
    kind: RtcPublicationSigningFailure['kind'],
    message: string
): Either<RtcPublicationSigningFailure, ALMessage> {
    return Either.ofLeft({ kind, message });
}
