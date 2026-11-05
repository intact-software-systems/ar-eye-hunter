import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { signALPublicationProof } from '../../al-contracts/publication-proof/al-publication-proof.ts';
import { resolvePublicationKey } from '../../api/group-presence/resolve-publication-key.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';
import type { PublicationCrypto } from '../../signature/publication-crypto.ts';
import { isRtcUnfrozenRoomMessage } from '../web-rtc-overlay-frozen-audience.ts';

/** What an origin signs with: its page key, and the room snapshot that must attest that key for its session. */
export interface RtcPublicationSigningAuthority {
    readonly crypto: PublicationCrypto;
    /** The origin's cached snapshot of the message's room; `null` when it holds none. */
    readonly snapshot: GroupSnapshot | null;
    readonly selfSessionId: string;
    readonly nowEpochMs: number;
}

export interface SignRtcPublicationInput extends RtcPublicationSigningAuthority {
    /** The admitted message: frozen to its room audience and normalized, so its signed fields never change again. */
    readonly message: ALMessage;
}

export interface RtcPublicationSigningFailure {
    readonly kind: 'signing-unavailable' | 'no-authority' | 'key-not-registered' | 'unfrozen-audience' | 'sign-failed';
    readonly message: string;
}

/**
 * Why the origin cannot sign at all, whatever the message: a keyless page, no snapshot of the room, or a snapshot that
 * does not yet name this page's key; `undefined` when it can. A leg is refused for it before admission.
 */
export function resolveRtcPublicationSigningRefusal(
    input: RtcPublicationSigningAuthority
): RtcPublicationSigningFailure | undefined {
    return resolveRtcPublicationSigningKey(input).left;
}

/** The origin signs a granted publication only with the key its own room snapshot attests for its session. */
export async function signRtcPublication(
    input: SignRtcPublicationInput
): Promise<Either<RtcPublicationSigningFailure, ALMessage>> {
    const { message } = input;
    return await resolveRtcPublicationSigningKey(input).fold<Promise<Either<RtcPublicationSigningFailure, ALMessage>>>(
        async (failure) => Either.ofLeft(failure),
        async ({ subtle, keyPair }) => {
            if (isRtcUnfrozenRoomMessage(message)) {
                return toSigningFailure(
                    'unfrozen-audience',
                    'The room admission froze no audience for the publication.'
                );
            }
            const signed = await signALPublicationProof({ subtle, keyPair, message });
            return signed.mapLeft((failure) => ({ kind: 'sign-failed', message: failure.message }));
        }
    );
}

function resolveRtcPublicationSigningKey(
    input: RtcPublicationSigningAuthority
): Either<RtcPublicationSigningFailure, Extract<PublicationCrypto, { kind: 'available'; }>> {
    const { crypto, snapshot } = input;
    if (crypto.kind === 'unavailable') {
        return toSigningFailure('signing-unavailable', `This page cannot sign a publication: ${crypto.reason}.`);
    }
    if (snapshot === null) {
        return toSigningFailure('no-authority', 'The origin holds no snapshot of the room to attest its key.');
    }
    if (resolvePublicationKey(snapshot, input.selfSessionId, input.nowEpochMs)?.keyId !== crypto.keyPair.keyId) {
        return toSigningFailure('key-not-registered', 'The room snapshot does not yet name this page\'s key.');
    }
    return Either.ofRight(crypto);
}

function toSigningFailure<R>(
    kind: RtcPublicationSigningFailure['kind'],
    message: string
): Either<RtcPublicationSigningFailure, R> {
    return Either.ofLeft({ kind, message });
}
