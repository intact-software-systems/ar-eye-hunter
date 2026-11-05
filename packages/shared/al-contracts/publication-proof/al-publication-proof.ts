import { toCanonicalGroupRef } from '../../api/group-types.ts';
import { serializeCanonicalJson, type CanonicalJsonInput } from '../../encoding/canonical-json.ts';
import { Either } from '../../resilience/Either.ts';
import {
    signDetached,
    verifyDetached,
    type SignatureFailure,
    type SigningKeyPair
} from '../../signature/ecdsa-p256-signature.ts';
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

export interface ALPublicationProof {
    readonly alg: 'ES256';
    readonly keyId: string;
    readonly signature: string;
}

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

/**
 * Relay-mutable fields are `excluded`: a forwarder rewrites them, so the proof cannot cover them. A field added after
 * the v1 slots is `signed-when-present`: it signs after every v1 slot as a `[path, value]` pair, only when present, so
 * a message without it signs the v1 bytes and builds on either side of the addition verify each other's such messages.
 * Every later signed field is appended this way, trailing and only when present, for the same reason.
 */
export type ALPublicationProofFieldClass = 'signed' | 'signed-when-present' | 'excluded';

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
    } as const satisfies Record<keyof ALMessage, ALPublicationProofFieldClass>,
    id: {
        v: 'signed',
        msgId: 'signed',
        ts: 'signed',
        senderId: 'signed',
        sessionId: 'signed',
        traceId: 'excluded'
    } as const satisfies Record<keyof ALMessageId, ALPublicationProofFieldClass>,
    route: {
        topicId: 'signed',
        resourceId: 'signed',
        contextId: 'signed'
    } as const satisfies Record<keyof ALRoute, ALPublicationProofFieldClass>,
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
    } as const satisfies Record<UnionKeys<ALTargets>, ALPublicationProofFieldClass>,
    constraints: {
        ttlHops: 'excluded',
        expiresAtMs: 'signed'
    } as const satisfies Record<keyof ALConstraints, ALPublicationProofFieldClass>,
    ordering: {
        orderingKey: 'signed',
        epoch: 'signed',
        seq: 'signed',
        priorSeqByRecipient: 'signed-when-present'
    } as const satisfies Record<keyof ALOrdering, ALPublicationProofFieldClass>,
    delivery: {
        ownership: 'signed',
        reliability: 'signed',
        ack: 'signed'
    } as const satisfies Record<keyof ALDelivery, ALPublicationProofFieldClass>,
    actions: {
        corrId: 'signed',
        replyToMsgId: 'signed'
    } as const satisfies Record<keyof ALActions, ALPublicationProofFieldClass>,
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
    } as const satisfies Record<keyof ALQosPolicyRequest, ALPublicationProofFieldClass>,
    payload: {
        typeId: 'signed',
        contentType: 'signed',
        resource: 'signed'
    } as const satisfies Record<keyof ALPayload, ALPublicationProofFieldClass>
} as const;

/** `keyof` a union is only its common keys; the targets record classifies every member's keys. */
type UnionKeys<T> = T extends object ? keyof T : never;

/** One signed section's share of the signing input: its v1 slots, and its later fields that are present. */
interface ALPublicationProofSectionSigning {
    readonly slots: readonly CanonicalJsonInput[];
    readonly trailing: readonly CanonicalJsonInput[];
}

type ALPublicationProofSignedSection = {
    [Section in keyof ALMessage]-?: (typeof AL_PUBLICATION_PROOF_FIELD_CLASSES.message)[Section] extends 'signed' ?
        Section :
        never;
}[keyof ALMessage];

const UTF8_ENCODER = new TextEncoder();

/**
 * The domain tag leads, so a signature over these bytes never verifies as another protocol's; an absent signed field
 * signs as `null`, so dropping one changes the bytes as surely as rewriting it. A present `signed-when-present` field
 * follows every v1 slot as its `[path, value]` pair, so dropping or adding one changes the bytes too.
 */
export function toALPublicationProofSigningInput(message: ALMessage): string {
    const sections = toSignedFieldValues<keyof ALMessage, ALPublicationProofSectionSigning>(
        toALPublicationProofSections(message),
        AL_PUBLICATION_PROOF_FIELD_CLASSES.message
    );
    return serializeCanonicalJson([
        AL_PUBLICATION_PROOF_DOMAIN_TAG,
        ...sections.flatMap((section) => section?.slots ?? []),
        ...sections.flatMap((section) => section?.trailing ?? [])
    ]);
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

function toALPublicationProofSections(
    message: ALMessage
): Readonly<Record<ALPublicationProofSignedSection, ALPublicationProofSectionSigning>> {
    const classes = AL_PUBLICATION_PROOF_FIELD_CLASSES;
    return {
        id: toSectionSigning('id', message.id, classes.id),
        route: toSectionSigning('route', message.route, classes.route),
        targets: toSectionSigning('targets', toSignedTargets(message.targets), classes.targets),
        constraints: toSectionSigning('constraints', message.constraints, classes.constraints),
        ordering: toSectionSigning('ordering', message.ordering, classes.ordering),
        delivery: toSectionSigning('delivery', message.delivery, classes.delivery),
        actions: toSectionSigning('actions', message.actions, classes.actions),
        qos: toSectionSigning('qos', message.qos, classes.qos),
        payload: toSectionSigning('payload', message.payload, classes.payload)
    };
}

function toSectionSigning<Key extends string, Value extends CanonicalJsonInput>(
    section: ALPublicationProofSignedSection,
    fields: Partial<Readonly<Record<NoInfer<Key>, Value>>> | undefined,
    classes: Readonly<Record<Key, ALPublicationProofFieldClass>>
): ALPublicationProofSectionSigning {
    const trailing: CanonicalJsonInput[] = [];
    for (const key in classes) {
        const value = fields?.[key];
        if (classes[key] === 'signed-when-present' && value !== undefined) {
            trailing.push([`${section}.${key}`, value]);
        }
    }
    return { slots: toSignedFieldValues(fields, classes), trailing };
}

function toSignedFieldValues<Key extends string, Value>(
    fields: Partial<Readonly<Record<NoInfer<Key>, Value>>> | undefined,
    classes: Readonly<Record<Key, ALPublicationProofFieldClass>>
): (Value | null)[] {
    const values: (Value | null)[] = [];
    for (const key in classes) {
        if (classes[key] === 'signed') {
            values.push(fields?.[key] ?? null);
        }
    }
    return values;
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
