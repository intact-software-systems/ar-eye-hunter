import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import {
    toALPublicationProofSigningInput,
    verifyALPublicationProof
} from '../../al-contracts/publication-proof/al-publication-proof.ts';
import { isALDeliveryFallbackPastDeadline } from '../../alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import type { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import { resolvePublicationKey } from '../../api/group-presence/resolve-publication-key.ts';
import type { GroupRef, GroupSnapshot } from '../../api/group-types.ts';
import { LatestRepository } from '../../cache/LatestRepository.ts';
import { toBase64Url } from '../../encoding/base64url.ts';
import type { PublicationVerificationCrypto } from '../../signature/publication-crypto.ts';
import type { SignatureProof } from '../../signature/signature-proof.ts';
import { VerificationKeyCache } from '../../signature/verification-key-cache.ts';
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
    readonly #publicKeys = new VerificationKeyCache();
    readonly #verdicts = new LatestRepository<string, true>({ maxEntries: 1024 });
    /** A per-object record, not a keyed cache: an object leaves it when it is collected. */
    readonly #verifiedMessages = new WeakSet<ALMessage>();

    constructor(dependencies: RtcPublicationProofVerifier.Dependencies) {
        this.#crypto = dependencies.crypto;
        this.#findGroupSnapshot = (groupRef) => dependencies.findGroupSnapshot(groupRef);
    }

    async verifyPublicationProof(message: ALMessage, clock: ALOutboundMessageRuntime.Clock): Promise<boolean> {
        const crypto = this.#crypto;
        const proof = message.proof;
        const expiresAtMs = message.constraints?.expiresAtMs;
        if (isALDeliveryFallbackPastDeadline(expiresAtMs, clock.nowMs())) {
            return false;
        }
        if (this.#verifiedMessages.has(message)) {
            return true;
        }
        if (crypto.kind === 'unavailable' || proof === undefined) {
            return false;
        }
        const signedBytes = UTF8_ENCODER.encode(toALPublicationProofSigningInput(message));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', signedBytes));
        const verdictKey = `${proof.keyId}|${proof.signature}|${toBase64Url(digest)}`;
        const nowEpochMs = clock.nowMs();
        if (this.#verdicts.readAt(verdictKey, nowEpochMs) === undefined) {
            if (!await this.verifyAgainstSnapshot(crypto.subtle, message, proof, nowEpochMs)) {
                return false;
            }
            this.#verdicts.acceptAt({
                key: verdictKey,
                value: true,
                nowEpochMs,
                expireAtEpochMs: message.constraints?.expiresAtMs
            });
        }
        if (isALDeliveryFallbackPastDeadline(expiresAtMs, clock.nowMs())) {
            return false;
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
        proof: SignatureProof,
        nowEpochMs: number
    ): Promise<boolean> {
        const groupRef = readALTargetGroupRef(message);
        const snapshot = groupRef === undefined ? undefined : this.#findGroupSnapshot(groupRef);
        const registered = snapshot === undefined
            ? null
            : resolvePublicationKey(snapshot, message.id.senderId, nowEpochMs);
        if (registered === null || registered.keyId !== proof.keyId) {
            return false;
        }
        const publicKey = await this.#publicKeys.readVerificationKey(subtle, registered);
        return publicKey !== undefined &&
            (await verifyALPublicationProof({ subtle, publicKey, message })).right !== undefined;
    }
}
