import { toCanonicalGroupRef } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';
import {
    signDetached,
    verifyDetached,
    type SignatureFailure,
    type SigningKeyPair
} from '../../signature/ecdsa-p256-signature.ts';
import {
    toClassifiedSigningInput,
    type ClassifiedSigningSection,
    type SignedFieldClass
} from '../../signature/to-classified-signing-input.ts';
import type {
    ALActions,
    ALConstraints,
    ALDelivery,
    ALMessage,
    ALMessageId,
    ALOrdering,
    ALPayload,
    ALRoute,
    ALTargets
} from '../al-contract.ts';
import type { ALQosPolicyRequest } from '../al-policy.ts';

export interface ALPublicationProofFailure {
    readonly kind: 'missing-proof' | 'invalid-key' | 'sign-failed' | 'invalid-signature';
    readonly message: string;
}

export interface SignALPublicationProofInput {
    readonly subtle: SubtleCrypto;
    readonly keyPair: SigningKeyPair;
    readonly message: ALMessage;
}

export interface VerifyALPublicationProofInput {
    readonly subtle: SubtleCrypto;
    readonly publicKey: CryptoKey;
    readonly message: ALMessage;
}

export const AL_PUBLICATION_PROOF_DOMAIN_TAG = 'rallar-alm-publication-proof-v1';

/** Every envelope key, classified; the signing input takes its field order from these records. */
export const AL_PUBLICATION_PROOF_FIELD_CLASSES = {
    message: {
        id: 'signed',
        route: 'signed',
        targets: 'signed',
        forwarding: 'excluded',
        constraints: 'signed',
        ordering: 'signed',
        delivery: 'signed',
        actions: 'signed',
        qos: 'signed',
        payload: 'signed',
        audit: 'excluded',
        diagnostics: 'excluded',
        proof: 'excluded'
    } as const satisfies Record<keyof ALMessage, SignedFieldClass>,
    id: {
        v: 'signed',
        msgId: 'signed',
        ts: 'signed',
        senderId: 'signed',
        sessionId: 'signed',
        traceId: 'excluded'
    } as const satisfies Record<keyof ALMessageId, SignedFieldClass>,
    route: {
        topicId: 'signed',
        resourceId: 'signed',
        contextId: 'signed'
    } as const satisfies Record<keyof ALRoute, SignedFieldClass>,
    targets: {
        mode: 'signed',
        groupRef: 'signed',
        toPeerId: 'signed',
        scope: 'signed',
        recipientPeerIds: 'signed',
        snapshotVersion: 'signed',
        minSnapshotVersion: 'signed',
        rosterVersion: 'signed',
        exceptPeerIds: 'signed',
        principalRef: 'signed'
    } as const satisfies Record<UnionKeys<ALTargets>, SignedFieldClass>,
    constraints: {
        ttlHops: 'excluded',
        expiresAtMs: 'signed'
    } as const satisfies Record<keyof ALConstraints, SignedFieldClass>,
    ordering: {
        orderingKey: 'signed',
        epoch: 'signed',
        seq: 'signed',
        priorSeqByRecipient: 'signed-when-present'
    } as const satisfies Record<keyof ALOrdering, SignedFieldClass>,
    delivery: {
        ownership: 'signed',
        reliability: 'signed',
        ack: 'signed'
    } as const satisfies Record<keyof ALDelivery, SignedFieldClass>,
    actions: {
        corrId: 'signed',
        replyToMsgId: 'signed'
    } as const satisfies Record<keyof ALActions, SignedFieldClass>,
    qos: {
        delivery: 'signed',
        forwarding: 'signed',
        repair: 'signed',
        ack: 'signed',
        expiry: 'signed',
        retry: 'signed',
        dedup: 'signed',
        supersedence: 'signed',
        fanout: 'signed',
        congestion: 'signed',
        durability: 'signed',
        ownership: 'signed'
    } as const satisfies Record<keyof ALQosPolicyRequest, SignedFieldClass>,
    payload: {
        typeId: 'signed',
        contentType: 'signed',
        resource: 'signed'
    } as const satisfies Record<keyof ALPayload, SignedFieldClass>
} as const;

/** `keyof` a union is only its common keys; the targets record classifies every member's keys. */
type UnionKeys<T> = T extends object ? keyof T : never;

const UTF8_ENCODER = new TextEncoder();

export function toALPublicationProofSigningInput(message: ALMessage): string {
    return toClassifiedSigningInput(AL_PUBLICATION_PROOF_DOMAIN_TAG, toALPublicationProofSections(message));
}

/** A planner never changes a signed field of a signed message: the copies it plans carry the origin's proof. */
export function assertALPublicationProofSigningInputKept(signed: ALMessage, planned: ALMessage): void {
    if (toALPublicationProofSigningInput(planned) !== toALPublicationProofSigningInput(signed)) {
        throw new Error(`A plan changed a signed field of publication ${signed.id.msgId}.`);
    }
}

export async function signALPublicationProof(
    input: SignALPublicationProofInput
): Promise<Either<ALPublicationProofFailure, ALMessage>> {
    const signature = await signDetached(
        input.subtle,
        input.keyPair.privateKey,
        UTF8_ENCODER.encode(toALPublicationProofSigningInput(input.message))
    );
    return signature.mapBoth(toALPublicationProofFailure, (signatureText) => ({
        ...input.message,
        proof: { alg: 'ES256', keyId: input.keyPair.keyId, signature: signatureText }
    }));
}

export async function verifyALPublicationProof(
    input: VerifyALPublicationProofInput
): Promise<Either<ALPublicationProofFailure, ALMessage>> {
    const proof = input.message.proof;
    if (proof === undefined) {
        return Either.ofLeft({ kind: 'missing-proof', message: 'The message carries no publication proof.' });
    }
    const verified = await verifyDetached({
        subtle: input.subtle,
        publicKey: input.publicKey,
        bytes: UTF8_ENCODER.encode(toALPublicationProofSigningInput(input.message)),
        signature: proof.signature
    });
    return verified.mapBoth(toALPublicationProofFailure, () => input.message);
}

function toALPublicationProofSections(message: ALMessage): ClassifiedSigningSection[] {
    const classes = AL_PUBLICATION_PROOF_FIELD_CLASSES;
    return [
        { name: 'id', fields: { ...message.id }, classes: classes.id },
        { name: 'route', fields: { ...message.route }, classes: classes.route },
        { name: 'targets', fields: { ...toSignedTargets(message.targets) }, classes: classes.targets },
        { name: 'constraints', fields: { ...message.constraints }, classes: classes.constraints },
        { name: 'ordering', fields: { ...message.ordering }, classes: classes.ordering },
        { name: 'delivery', fields: { ...message.delivery }, classes: classes.delivery },
        { name: 'actions', fields: { ...message.actions }, classes: classes.actions },
        { name: 'qos', fields: { ...message.qos }, classes: classes.qos },
        { name: 'payload', fields: { ...message.payload }, classes: classes.payload }
    ];
}

function toSignedTargets(targets: ALTargets | undefined): ALTargets | undefined {
    return targets?.groupRef === undefined
        ? targets
        : { ...targets, groupRef: toCanonicalGroupRef(targets.groupRef) };
}

function toALPublicationProofFailure(
    failure: SignatureFailure<'invalid-key' | 'sign-failed' | 'invalid-signature'>
): ALPublicationProofFailure {
    return { kind: failure.kind, message: failure.message };
}
