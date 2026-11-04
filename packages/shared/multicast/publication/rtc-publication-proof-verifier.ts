import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import {
    toALPublicationProofSigningInput,
    verifyALPublicationProof,
    type ALPublicationProof
} from '../../al-contracts/publication-proof/al-publication-proof.ts';
import { resolvePublicationKey } from '../../api/group-presence/resolve-publication-key.ts';
import type { GroupPresencePublicationKey, GroupRef, GroupSnapshot } from '../../api/group-types.ts';
import { LatestRepository } from '../../cache/LatestRepository.ts';
import { toBase64Url } from '../../encoding/base64url.ts';
import { computeEcdsaP256JwkThumbprint, importEcdsaP256PublicKey } from '../../signature/ecdsa-p256-signature.ts';
import type { PublicationVerificationCrypto } from '../../signature/publication-crypto.ts';
import type { RtcPublicationProofVerifierPort } from './rtc-publication-proof-verifier-port.ts';

const UTF8_ENCODER = new TextEncoder();

export namespace RtcPublicationProofVerifier {
    export interface Dependencies {
        /** The page's WebCrypto; a keyless page verifies nothing, so every granted frame stays unverified. */
        readonly crypto: PublicationVerificationCrypto;
        /**
         * The page's readable snapshot of a room, from which a sender's registered key is read. The page outlives each
         * connect's group cache, so the snapshot is found when a frame is verified.
         */
        findGroupSnapshot(groupRef: GroupRef): GroupSnapshot | undefined;
        readonly nowEpochMs: () => number;
    }
}

/**
 * One page's verdicts on granted publication proofs. A verdict is keyed by the proof and a digest of the signed bytes,
 * so a forged copy under the same proof never inherits one; the planner reads a verdict synchronously through the
 * exact message object that was verified.
 */
export class RtcPublicationProofVerifier implements RtcPublicationProofVerifierPort {
    readonly #crypto: PublicationVerificationCrypto;
    readonly #findGroupSnapshot: (groupRef: GroupRef) => GroupSnapshot | undefined;
    readonly #nowEpochMs: () => number;
    readonly #publicKeys = new LatestRepository<string, CryptoKey>({ maxEntries: 256 });
    readonly #verdicts = new LatestRepository<string, true>({ maxEntries: 1024 });
    /** A per-object record, not a keyed cache: an object leaves it when it is collected. */
    readonly #verifiedMessages = new WeakSet<ALMessage>();

    constructor(dependencies: RtcPublicationProofVerifier.Dependencies) {
        this.#crypto = dependencies.crypto;
        this.#findGroupSnapshot = (groupRef) => dependencies.findGroupSnapshot(groupRef);
        this.#nowEpochMs = dependencies.nowEpochMs;
    }

    async verifyPublicationProof(message: ALMessage): Promise<boolean> {
        const crypto = this.#crypto;
        const proof = message.proof;
        if (this.#verifiedMessages.has(message)) {
            return true;
        }
        if (crypto.kind === 'unavailable' || proof === undefined) {
            return false;
        }
        const signedBytes = UTF8_ENCODER.encode(toALPublicationProofSigningInput(message));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', signedBytes));
        const verdictKey = `${proof.keyId}|${proof.signature}|${toBase64Url(digest)}`;
        const nowEpochMs = this.#nowEpochMs();
        if (this.#verdicts.readAt(verdictKey, nowEpochMs) === undefined) {
            if (!await this.verifyAgainstSnapshot(crypto.subtle, message, proof)) {
                return false;
            }
            this.#verdicts.acceptAt({
                key: verdictKey,
                value: true,
                nowEpochMs,
                expireAtEpochMs: message.constraints?.expiresAtMs
            });
        }
        this.#verifiedMessages.add(message);
        return true;
    }

    getVerifiedSignature(message: ALMessage): boolean {
        return this.#verifiedMessages.has(message);
    }

    private async verifyAgainstSnapshot(
        subtle: SubtleCrypto,
        message: ALMessage,
        proof: ALPublicationProof
    ): Promise<boolean> {
        const groupRef = readALTargetGroupRef(message);
        const snapshot = groupRef === undefined ? undefined : this.#findGroupSnapshot(groupRef);
        const registered = snapshot === undefined
            ? null
            : resolvePublicationKey(snapshot, message.id.senderId, this.#nowEpochMs());
        if (registered === null || registered.keyId !== proof.keyId) {
            return false;
        }
        const publicKey = await this.readPublicKey(subtle, registered);
        return publicKey !== undefined &&
            (await verifyALPublicationProof({ subtle, publicKey, message })).right !== undefined;
    }

    /** A registration is imported only under the keyId its own key's thumbprint names. */
    private async readPublicKey(
        subtle: SubtleCrypto,
        registered: GroupPresencePublicationKey
    ): Promise<CryptoKey | undefined> {
        const cached = this.#publicKeys.read(registered.keyId);
        if (cached !== undefined) {
            return cached;
        }
        if (await computeEcdsaP256JwkThumbprint(subtle, registered.publicJwk) !== registered.keyId) {
            return undefined;
        }
        const imported = (await importEcdsaP256PublicKey(subtle, registered.publicJwk)).right;
        if (imported !== undefined) {
            this.#publicKeys.accept(registered.keyId, imported);
        }
        return imported;
    }
}
