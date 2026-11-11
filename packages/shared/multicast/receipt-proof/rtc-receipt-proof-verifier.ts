import {
    toALReceiptProofRefusal,
    toALReceiptProofSigningInput,
    verifyALReceiptProof,
    type ALReceiptControl,
    type ALReceiptProofRefusal,
    type ALReceiptProofVerifierPort
} from '../../al-contracts/receipt-proof/al-receipt-proof.ts';
import type { GroupPresencePublicationKey } from '../../api/group-types.ts';
import { LatestRepository } from '../../cache/LatestRepository.ts';
import { toBase64Url } from '../../encoding/base64url.ts';
import { Either } from '../../resilience/Either.ts';
import type { PublicationVerificationCrypto } from '../../signature/publication-crypto.ts';
import type { SignatureProof } from '../../signature/signature-proof.ts';
import { VerificationKeyCache } from '../../signature/verification-key-cache.ts';

const UTF8_ENCODER = new TextEncoder();

export namespace RtcReceiptProofVerifier {
    export interface Dependencies {
        /** The page's WebCrypto; a keyless page verifies nothing, so every signed control is `invalid-signature`. */
        readonly crypto: PublicationVerificationCrypto;
        readonly nowEpochMs: () => number;
    }
}

/**
 * One origin page's verdicts on its recipients' receipt proofs, each against the key the origin froze for the
 * recipient the control speaks for. Only a `verified` verdict is kept: a forger varies the signature for free, so a
 * refusal entry would never hit and a flood of them would evict true verdicts.
 */
export class RtcReceiptProofVerifier implements ALReceiptProofVerifierPort {
    readonly #subtle: SubtleCrypto | undefined;
    readonly #nowEpochMs: () => number;
    readonly #publicKeys = new VerificationKeyCache();
    readonly #verdicts = new LatestRepository<string, true>({ maxEntries: 1024 });

    constructor(dependencies: RtcReceiptProofVerifier.Dependencies) {
        this.#subtle = dependencies.crypto.kind === 'available' ? dependencies.crypto.subtle : undefined;
        this.#nowEpochMs = dependencies.nowEpochMs;
    }

    async verifyReceiptProof(
        control: ALReceiptControl,
        frozenKey: GroupPresencePublicationKey | undefined
    ): Promise<Either<ALReceiptProofRefusal, true>> {
        const proof = control.payload.proof;
        if (proof === null) {
            return Either.ofLeft(toALReceiptProofRefusal('missing-proof', control));
        }
        if (frozenKey === undefined) {
            return Either.ofLeft(toALReceiptProofRefusal('unknown-key', control));
        }
        if (proof.keyId !== frozenKey.keyId) {
            return Either.ofLeft(toALReceiptProofRefusal('key-mismatch', control));
        }
        return await this.verifySignature(control, proof, frozenKey)
            ? Either.ofRight(true)
            : Either.ofLeft(toALReceiptProofRefusal('invalid-signature', control));
    }

    private async verifySignature(
        control: ALReceiptControl,
        proof: SignatureProof,
        frozenKey: GroupPresencePublicationKey
    ): Promise<boolean> {
        const subtle = this.#subtle;
        if (subtle === undefined) {
            return false;
        }
        // The key comes first, so a verdict cached under its key id never answers for a record whose JWK is another key's.
        const publicKey = await this.#publicKeys.readVerificationKey(subtle, frozenKey);
        if (publicKey === undefined) {
            return false;
        }
        const signedBytes = UTF8_ENCODER.encode(toALReceiptProofSigningInput(control));
        const digest = new Uint8Array(await subtle.digest('SHA-256', signedBytes));
        const verdictKey = `${proof.keyId}|${proof.signature}|${toBase64Url(digest)}`;
        const nowEpochMs = this.#nowEpochMs();
        if (this.#verdicts.readAt(verdictKey, nowEpochMs) !== undefined) {
            return true;
        }
        if ((await verifyALReceiptProof({ subtle, publicKey, control })).right !== true) {
            return false;
        }
        this.#verdicts.acceptAt({ key: verdictKey, value: true, nowEpochMs });
        return true;
    }
}
