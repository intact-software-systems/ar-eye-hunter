import type { GroupPresencePublicationKey } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';
import {
    signDetached,
    verifyDetached,
    type SignatureFailure,
    type SigningKeyPair
} from '../../signature/ecdsa-p256-signature.ts';
import type { SignatureProof } from '../../signature/signature-proof.ts';
import { toClassifiedSigningInput, type SignedFieldClass } from '../../signature/to-classified-signing-input.ts';
import type { ALAckPayload, ALNackPayload, ALPeerControlMessage } from '../al-control.ts';

export type ALReceiptControl = Exclude<ALPeerControlMessage, Readonly<{ type: 'repair'; }>>;

/** By counted recipient session id. */
export type ALReceiptProofKeys = Readonly<Record<string, GroupPresencePublicationKey>>;

export const AL_ACK_PROOF_DOMAIN_TAG = 'rallar-alm-ack-proof-v1';
export const AL_NACK_PROOF_DOMAIN_TAG = 'rallar-alm-nack-proof-v1';

/** Every ACK and NACK key, classified; the signing input takes its field order from these records. */
export const AL_RECEIPT_PROOF_FIELD_CLASSES = {
    ack: {
        ackedMsgId: 'signed',
        originPeerId: 'signed',
        logicalRecipientPeerId: 'signed',
        status: 'signed',
        observedAtEpochMs: 'signed',
        fromPeerId: 'excluded',
        toPeerId: 'excluded',
        carrier: 'excluded',
        proof: 'excluded'
    } satisfies Record<keyof ALAckPayload, SignedFieldClass>,
    nack: {
        msgId: 'signed',
        originPeerId: 'signed',
        logicalRecipientPeerId: 'signed',
        reason: 'signed',
        observedAtEpochMs: 'signed',
        orderingKey: 'signed',
        expectedSeq: 'signed',
        missingRanges: 'signed',
        serverSnapshotVersion: 'signed',
        fromPeerId: 'excluded',
        toPeerId: 'excluded',
        proof: 'excluded'
    } satisfies Record<keyof ALNackPayload, SignedFieldClass>
} as const;

export interface ALReceiptProofFailure {
    readonly kind: 'signing-unavailable' | 'invalid-key' | 'sign-failed' | 'invalid-signature';
    readonly message: string;
}

export interface ALReceiptProofRefusal {
    readonly kind: 'missing-proof' | 'unknown-key' | 'key-mismatch' | 'invalid-signature';
    readonly claimedRecipientPeerId: string;
    readonly channelPeerId: string;
}

export interface SignALReceiptProofInput {
    readonly subtle: SubtleCrypto;
    readonly keyPair: SigningKeyPair;
    readonly control: ALReceiptControl;
}

export interface VerifyALReceiptProofInput {
    readonly subtle: SubtleCrypto;
    readonly publicKey: CryptoKey;
    readonly control: ALReceiptControl;
}

export interface ALReceiptProofSignerPort {
    signReceiptProof(control: ALReceiptControl): Promise<Either<ALReceiptProofFailure, SignatureProof>>;
}

export interface ALReceiptProofVerifierPort {
    verifyReceiptProof(
        control: ALReceiptControl,
        frozenKey: GroupPresencePublicationKey | undefined
    ): Promise<Either<ALReceiptProofRefusal, true>>;
}

const UTF8_ENCODER = new TextEncoder();

export function toALReceiptProofSigningInput(control: ALReceiptControl): string {
    return control.type === 'ack'
        ? toClassifiedSigningInput(AL_ACK_PROOF_DOMAIN_TAG, [
            { name: 'ack', fields: { ...control.payload }, classes: AL_RECEIPT_PROOF_FIELD_CLASSES.ack }
        ])
        : toClassifiedSigningInput(AL_NACK_PROOF_DOMAIN_TAG, [
            { name: 'nack', fields: { ...control.payload }, classes: AL_RECEIPT_PROOF_FIELD_CLASSES.nack }
        ]);
}

export async function signALReceiptProof(
    input: SignALReceiptProofInput
): Promise<Either<ALReceiptProofFailure, SignatureProof>> {
    const signature = await signDetached(
        input.subtle,
        input.keyPair.privateKey,
        UTF8_ENCODER.encode(toALReceiptProofSigningInput(input.control))
    );
    return signature.mapBoth(toALReceiptProofFailure, (signatureText) => ({
        alg: 'ES256',
        keyId: input.keyPair.keyId,
        signature: signatureText
    }));
}

/** A control without a proof is `invalid-signature` here; the port's verifier names it `missing-proof` before it reaches this. */
export async function verifyALReceiptProof(
    input: VerifyALReceiptProofInput
): Promise<Either<ALReceiptProofFailure, true>> {
    const proof = input.control.payload.proof;
    if (proof === null) {
        return Either.ofLeft({ kind: 'invalid-signature', message: 'The control carries no receipt proof.' });
    }
    const verified = await verifyDetached({
        subtle: input.subtle,
        publicKey: input.publicKey,
        bytes: UTF8_ENCODER.encode(toALReceiptProofSigningInput(input.control)),
        signature: proof.signature
    });
    return verified.mapBoth(toALReceiptProofFailure, () => true as const);
}

function toALReceiptProofFailure(
    failure: SignatureFailure<'invalid-key' | 'sign-failed' | 'invalid-signature'>
): ALReceiptProofFailure {
    return { kind: failure.kind, message: failure.message };
}
