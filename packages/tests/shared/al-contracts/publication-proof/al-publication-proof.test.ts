import {
    describe,
    expect,
    expectTypeOf,
    it
} from 'vitest';

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
} from '@shared/al-contracts/al-contract.ts';
import type { ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import {
    AL_PUBLICATION_PROOF_DOMAIN_TAG,
    AL_PUBLICATION_PROOF_FIELD_CLASSES,
    assertALPublicationProofSigningInputKept,
    signALPublicationProof,
    toALPublicationProofSigningInput,
    verifyALPublicationProof,
    type ALPublicationProofFailure,
    type ALPublicationProofFieldClass
} from '@shared/al-contracts/publication-proof/al-publication-proof.ts';
import {
    createSigningKeyPair,
    importEcdsaP256PublicKey,
    signDetached,
    type SigningKeyPair
} from '@shared/signature/ecdsa-p256-signature.ts';

interface ALPublicationProofFieldChange {
    readonly field: string;
    readonly signed: ALMessage;
    readonly change: (message: ALMessage) => ALMessage;
}

const subtle = globalThis.crypto.subtle;

const GROUP_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

const MULTICAST: ALMessage = {
    id: { v: 4, msgId: 'message-1', ts: 1_700_000_000_000, senderId: 'session-a', traceId: 'trace-proof' },
    route: { topicId: 'room.chat', resourceId: 'resource-1', contextId: 'room-1' },
    targets: {
        mode: 'multicast',
        groupRef: GROUP_REF,
        minSnapshotVersion: 3,
        rosterVersion: 4,
        recipientPeerIds: ['session-b', 'session-c'],
        snapshotVersion: 5
    },
    forwarding: { nextHopPeerIds: ['session-b'], overlayId: 'overlay-1', fanoutLimit: 2 },
    constraints: { ttlHops: 3, expiresAtMs: 1_700_000_060_000 },
    ordering: { orderingKey: 'room-1', epoch: 1, seq: 7 },
    delivery: { ownership: 'shared', reliability: 'at-least-once', ack: 'receiver' },
    actions: { corrId: 'corr-1', replyToMsgId: 'message-0' },
    qos: { fanout: { algo: 'limit', opts: { limit: 2 } }, durability: { algo: 'volatile' } },
    payload: { typeId: 'chat.message.v1', contentType: 'application/json', resource: '{"text":"hello"}' },
    audit: { createdBy: 'session-a', createdTs: 1_700_000_000_000 },
    diagnostics: { visitedPeerIds: ['session-a'] }
};

/** The multicast with the prior-sequence record an authority stamped on it. */
const RECORDED: ALMessage = { ...MULTICAST, ordering: { ...MULTICAST.ordering, priorSeqByRecipient: { 'session-c': 4 } } };

/** `MULTICAST`'s signing input as the v1 classification, before the record existed, wrote it. */
const V1_SIGNING_INPUT = '["rallar-alm-publication-proof-v1",4,"message-1",1700000000000,"session-a",null,' +
    '"room.chat","resource-1","room-1",' +
    '"multicast",{"applicationId":"app-1","groupId":"room-1","workspaceId":"workspace-1"},null,null,' +
    '["session-b","session-c"],5,3,4,null,null,' +
    '1700000060000,' +
    '"room-1",1,7,' +
    '"shared","at-least-once","receiver",' +
    '"corr-1","message-0",' +
    'null,null,null,null,null,null,null,null,{"algo":"limit","opts":{"limit":2}},null,{"algo":"volatile"},null,' +
    '"chat.message.v1","application/json","{\\"text\\":\\"hello\\"}"]';

const UNICAST: ALMessage = {
    ...MULTICAST,
    targets: { mode: 'unicast', toPeerId: 'session-b', groupRef: GROUP_REF }
};

const PRINCIPAL_BROADCAST: ALMessage = {
    ...MULTICAST,
    targets: {
        mode: 'broadcast',
        scope: 'principal',
        groupRef: GROUP_REF,
        principalRef: { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'principal-1' },
        exceptPeerIds: ['session-c']
    }
};

const SIGNED_FIELD_CHANGES: readonly ALPublicationProofFieldChange[] = [
    { field: 'id.msgId', signed: MULTICAST, change: (message) => ({ ...message, id: { ...message.id, msgId: 'message-2' } }) },
    { field: 'id.ts', signed: MULTICAST, change: (message) => ({ ...message, id: { ...message.id, ts: 1_700_000_000_001 } }) },
    { field: 'id.senderId', signed: MULTICAST, change: (message) => ({ ...message, id: { ...message.id, senderId: 'session-z' } }) },
    { field: 'id.sessionId', signed: MULTICAST, change: (message) => ({ ...message, id: { ...message.id, sessionId: 'session-1' } }) },
    { field: 'route.topicId', signed: MULTICAST, change: (message) => ({ ...message, route: { ...message.route, topicId: 'room.other' } }) },
    { field: 'route.resourceId', signed: MULTICAST, change: (message) => ({ ...message, route: { ...message.route, resourceId: 'resource-2' } }) },
    { field: 'route.contextId', signed: MULTICAST, change: (message) => ({ ...message, route: { ...message.route, contextId: 'room-2' } }) },
    { field: 'targets.mode', signed: MULTICAST, change: (message) => ({ ...message, targets: { mode: 'broadcast', scope: 'room', groupRef: GROUP_REF } }) },
    { field: 'targets.groupRef', signed: MULTICAST, change: (message) => withMulticastTargets(message, { groupRef: { ...GROUP_REF, groupId: 'room-2' } }) },
    { field: 'targets.recipientPeerIds', signed: MULTICAST, change: (message) => withMulticastTargets(message, { recipientPeerIds: ['session-b'] }) },
    { field: 'targets.snapshotVersion', signed: MULTICAST, change: (message) => withMulticastTargets(message, { snapshotVersion: 6 }) },
    { field: 'targets.minSnapshotVersion', signed: MULTICAST, change: (message) => withMulticastTargets(message, { minSnapshotVersion: 4 }) },
    { field: 'targets.rosterVersion', signed: MULTICAST, change: (message) => withMulticastTargets(message, { rosterVersion: 5 }) },
    {
        field: 'targets.toPeerId',
        signed: UNICAST,
        change: (message) => ({ ...message, targets: { mode: 'unicast', toPeerId: 'session-c', groupRef: GROUP_REF } })
    },
    { field: 'targets.scope', signed: PRINCIPAL_BROADCAST, change: (message) => withBroadcastTargets(message, { scope: 'room' }) },
    { field: 'targets.exceptPeerIds', signed: PRINCIPAL_BROADCAST, change: (message) => withBroadcastTargets(message, { exceptPeerIds: [] }) },
    {
        field: 'targets.principalRef',
        signed: PRINCIPAL_BROADCAST,
        change: (message) => withBroadcastTargets(message, { principalRef: { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'principal-2' } })
    },
    {
        field: 'constraints.expiresAtMs',
        signed: MULTICAST,
        change: (message) => ({ ...message, constraints: { ...message.constraints, expiresAtMs: 1_700_000_060_001 } })
    },
    { field: 'ordering.orderingKey', signed: MULTICAST, change: (message) => ({ ...message, ordering: { ...message.ordering, orderingKey: 'room-2' } }) },
    { field: 'ordering.epoch', signed: MULTICAST, change: (message) => ({ ...message, ordering: { ...message.ordering, epoch: 2 } }) },
    { field: 'ordering.seq', signed: MULTICAST, change: (message) => ({ ...message, ordering: { ...message.ordering, seq: 8 } }) },
    {
        field: 'ordering.priorSeqByRecipient entry',
        signed: RECORDED,
        change: (message) => ({ ...message, ordering: { ...message.ordering, priorSeqByRecipient: { 'session-c': 6 } } })
    },
    {
        field: 'ordering.priorSeqByRecipient presence',
        signed: RECORDED,
        change: (message) => ({ ...message, ordering: MULTICAST.ordering })
    },
    {
        field: 'delivery.ownership',
        signed: MULTICAST,
        change: (message) => ({ ...message, delivery: { ownership: 'exclusive', reliability: 'at-least-once', ack: 'receiver' } })
    },
    {
        field: 'delivery.reliability',
        signed: MULTICAST,
        change: (message) => ({ ...message, delivery: { ownership: 'shared', reliability: 'best-effort', ack: 'receiver' } })
    },
    {
        field: 'delivery.ack',
        signed: MULTICAST,
        change: (message) => ({ ...message, delivery: { ownership: 'shared', reliability: 'at-least-once', ack: 'none' } })
    },
    { field: 'actions.corrId', signed: MULTICAST, change: (message) => ({ ...message, actions: { ...message.actions, corrId: 'corr-2' } }) },
    { field: 'actions.replyToMsgId', signed: MULTICAST, change: (message) => ({ ...message, actions: { ...message.actions, replyToMsgId: 'message-9' } }) },
    {
        field: 'qos option value',
        signed: MULTICAST,
        change: (message) => ({ ...message, qos: { ...message.qos, fanout: { algo: 'limit', opts: { limit: 3 } } } })
    },
    { field: 'qos aspect', signed: MULTICAST, change: (message) => ({ ...message, qos: { ...message.qos, ack: { algo: 'receiver' } } }) },
    { field: 'payload.typeId', signed: MULTICAST, change: (message) => ({ ...message, payload: { ...message.payload, typeId: 'chat.message.v2' } }) },
    {
        field: 'payload.contentType',
        signed: MULTICAST,
        change: (message) => ({ ...message, payload: { typeId: message.payload.typeId, resource: message.payload.resource } })
    },
    { field: 'payload.resource', signed: MULTICAST, change: (message) => ({ ...message, payload: { ...message.payload, resource: '{"text":"hellO"}' } }) }
];

const EXCLUDED_FIELD_CHANGES: readonly ALPublicationProofFieldChange[] = [
    { field: 'forwarding', signed: MULTICAST, change: (message) => ({ ...message, forwarding: { nextHopPeerIds: ['session-c'], overlayId: 'overlay-2' } }) },
    { field: 'constraints.ttlHops', signed: MULTICAST, change: (message) => ({ ...message, constraints: { ...message.constraints, ttlHops: 2 } }) },
    { field: 'diagnostics', signed: MULTICAST, change: (message) => ({ ...message, diagnostics: { visitedPeerIds: ['session-a', 'session-b'] } }) },
    { field: 'id.traceId', signed: MULTICAST, change: (message) => ({ ...message, id: { ...message.id, traceId: 'trace-other' } }) },
    { field: 'audit', signed: MULTICAST, change: (message) => ({ ...message, audit: undefined }) }
];

async function createKeyPair(): Promise<SigningKeyPair> {
    return (await createSigningKeyPair(subtle)).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (pair) => pair
    );
}

async function importPublicKey(keyPair: SigningKeyPair): Promise<CryptoKey> {
    return (await importEcdsaP256PublicKey(subtle, keyPair.publicJwk)).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (key) => key
    );
}

async function sign(keyPair: SigningKeyPair, message: ALMessage): Promise<ALMessage> {
    return (await signALPublicationProof({ subtle, keyPair, message })).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (signed) => signed
    );
}

async function verify(publicKey: CryptoKey, message: ALMessage): Promise<ALPublicationProofFailure | 'verified'> {
    return (await verifyALPublicationProof({ subtle, publicKey, message })).fold<ALPublicationProofFailure | 'verified'>(
        (failure) => failure,
        (verified) => {
            expect(verified).toBe(message);
            return 'verified';
        }
    );
}

function withMulticastTargets(message: ALMessage, changes: Partial<Extract<ALTargets, { mode: 'multicast'; }>>): ALMessage {
    return message.targets?.mode === 'multicast' ? { ...message, targets: { ...message.targets, ...changes } } : message;
}

function withBroadcastTargets(message: ALMessage, changes: Partial<Extract<ALTargets, { mode: 'broadcast'; }>>): ALMessage {
    return message.targets?.mode === 'broadcast' ? { ...message, targets: { ...message.targets, ...changes } } : message;
}

describe('ALM publication proof signing input', () => {
    it('is the canonical JSON array of the signed fields in their pinned order, the domain tag first and absent values null', () => {
        expect(AL_PUBLICATION_PROOF_DOMAIN_TAG).toBe('rallar-alm-publication-proof-v1');
        expect(toALPublicationProofSigningInput(MULTICAST)).toBe(V1_SIGNING_INPUT);
    });

    it('appends a present later field after every v1 slot, named by its path, so an unrecorded frame keeps the v1 bytes', () => {
        expect(toALPublicationProofSigningInput(RECORDED)).toBe(
            `${V1_SIGNING_INPUT.slice(0, -1)},["ordering.priorSeqByRecipient",{"session-c":4}]]`
        );
    });

    it('is byte-stable for the same message and for a copy whose group ref carries extra members', () => {
        const widenedGroupRef = { ...GROUP_REF, displayName: 'Room 1' };

        expect(toALPublicationProofSigningInput(structuredClone(MULTICAST))).toBe(toALPublicationProofSigningInput(MULTICAST));
        expect(toALPublicationProofSigningInput(withMulticastTargets(MULTICAST, { groupRef: widenedGroupRef })))
            .toBe(toALPublicationProofSigningInput(MULTICAST));
    });

    it('signs a message without optional sections as nulls', () => {
        const bare: ALMessage = { id: MULTICAST.id, route: MULTICAST.route, payload: { typeId: 'chat.message.v1', resource: '{}' } };

        expect(JSON.parse(toALPublicationProofSigningInput(bare))).toEqual([
            AL_PUBLICATION_PROOF_DOMAIN_TAG,
            4,
            'message-1',
            1_700_000_000_000,
            'session-a',
            null,
            'room.chat',
            'resource-1',
            'room-1',
            ...Array.from({ length: 10 + 1 + 3 + 3 + 2 + 12 }, () => null),
            'chat.message.v1',
            null,
            '{}'
        ]);
    });

    it.each(SIGNED_FIELD_CHANGES)('changes when the signed field $field changes', ({ signed, change }) => {
        expect(toALPublicationProofSigningInput(change(signed))).not.toBe(toALPublicationProofSigningInput(signed));
    });

    it.each([
        ...EXCLUDED_FIELD_CHANGES,
        {
            field: 'proof',
            signed: MULTICAST,
            change: (message: ALMessage): ALMessage => ({ ...message, proof: { alg: 'ES256', keyId: 'k'.repeat(43), signature: 's'.repeat(86) } })
        }
    ])('does not change when the relay-mutable field $field changes', ({ signed, change }) => {
        expect(toALPublicationProofSigningInput(change(signed))).toBe(toALPublicationProofSigningInput(signed));
    });

    it('classifies every envelope key as signed or excluded, so an added key fails the build unclassified', () => {
        const classes = AL_PUBLICATION_PROOF_FIELD_CLASSES;

        expectTypeOf<keyof typeof classes.message>().toEqualTypeOf<keyof ALMessage>();
        expectTypeOf<keyof typeof classes.id>().toEqualTypeOf<keyof ALMessageId>();
        expectTypeOf<keyof typeof classes.route>().toEqualTypeOf<keyof ALRoute>();
        expectTypeOf<keyof typeof classes.constraints>().toEqualTypeOf<keyof ALConstraints>();
        expectTypeOf<keyof typeof classes.ordering>().toEqualTypeOf<keyof ALOrdering>();
        expectTypeOf<keyof typeof classes.delivery>().toEqualTypeOf<keyof ALDelivery>();
        expectTypeOf<keyof typeof classes.actions>().toEqualTypeOf<keyof ALActions>();
        expectTypeOf<keyof typeof classes.qos>().toEqualTypeOf<keyof ALQosPolicyRequest>();
        expectTypeOf<keyof typeof classes.payload>().toEqualTypeOf<keyof ALPayload>();
        // @ts-expect-error a key the record does not classify fails the satisfies check
        expect(classes.message satisfies Record<keyof ALMessage | 'added', ALPublicationProofFieldClass>).toBeDefined();
        expect(classes.message).toMatchObject({
            forwarding: 'excluded',
            audit: 'excluded',
            diagnostics: 'excluded',
            proof: 'excluded'
        });
        expect(classes.id.traceId).toBe('excluded');
        expect(classes.ordering.priorSeqByRecipient).toBe('signed-when-present');
        expect(classes.constraints.ttlHops).toBe('excluded');
    });
});

describe('ALM publication proof signing and verification', () => {
    it('signs the message with an ES256 proof named by the key id, which verifies against the public key', async () => {
        const keyPair = await createKeyPair();

        const signed = await sign(keyPair, MULTICAST);

        expect(signed).toEqual({ ...MULTICAST, proof: { alg: 'ES256', keyId: keyPair.keyId, signature: expect.any(String) } });
        expect(signed.proof?.signature).toHaveLength(86);
        expect(await verify(await importPublicKey(keyPair), signed)).toBe('verified');
    });

    it.each(SIGNED_FIELD_CHANGES)('refuses a frame whose signed field $field changed after signing as invalid-signature', async ({ signed, change }) => {
        const keyPair = await createKeyPair();
        const proven = await sign(keyPair, signed);

        expect(await verify(await importPublicKey(keyPair), change(proven))).toMatchObject({ kind: 'invalid-signature' });
    });

    it.each(EXCLUDED_FIELD_CHANGES)('verifies a frame whose relay-mutable field $field changed after signing', async ({ signed, change }) => {
        const keyPair = await createKeyPair();
        const proven = await sign(keyPair, signed);

        expect(await verify(await importPublicKey(keyPair), change(proven))).toBe('verified');
    });

    it('verifies an unrecorded frame an older build signed over the v1 signing input', async () => {
        const keyPair = await createKeyPair();
        const signature = (await signDetached(subtle, keyPair.privateKey, new TextEncoder().encode(V1_SIGNING_INPUT))).right!;
        const signedByOlderBuild: ALMessage = { ...MULTICAST, proof: { alg: 'ES256', keyId: keyPair.keyId, signature } };

        expect(await verify(await importPublicKey(keyPair), signedByOlderBuild)).toBe('verified');
    });

    it('refuses a frame signed by another key as invalid-signature', async () => {
        const signed = await sign(await createKeyPair(), MULTICAST);

        expect(await verify(await importPublicKey(await createKeyPair()), signed)).toMatchObject({ kind: 'invalid-signature' });
    });

    it('refuses a frame whose signature text is not a signature as invalid-signature', async () => {
        const keyPair = await createKeyPair();
        const signed = await sign(keyPair, MULTICAST);
        const proof = { alg: 'ES256' as const, keyId: keyPair.keyId, signature: 'A'.repeat(43) };

        expect(await verify(await importPublicKey(keyPair), { ...signed, proof })).toMatchObject({ kind: 'invalid-signature' });
    });

    it('refuses a frame without a proof as missing-proof', async () => {
        const keyPair = await createKeyPair();

        expect(await verify(await importPublicKey(keyPair), MULTICAST)).toEqual({
            kind: 'missing-proof',
            message: expect.any(String)
        });
    });

    it('reports a key WebCrypto refuses to verify with as invalid-key, copying the primitive message', async () => {
        const keyPair = await createKeyPair();
        const signed = await sign(keyPair, MULTICAST);

        expect(await verify(keyPair.privateKey, signed)).toEqual({
            kind: 'invalid-key',
            message: expect.stringMatching(/^Verification was refused: /)
        });
    });

    it('reports a key WebCrypto refuses to sign with as sign-failed, copying the primitive message', async () => {
        const keyPair = await createKeyPair();
        const verifyOnly = { ...keyPair, privateKey: await importPublicKey(keyPair) };

        expect((await signALPublicationProof({ subtle, keyPair: verifyOnly, message: MULTICAST })).left).toEqual({
            kind: 'sign-failed',
            message: expect.stringMatching(/^Signing was refused: /)
        });
    });
});

describe('assertALPublicationProofSigningInputKept', () => {
    it.each(SIGNED_FIELD_CHANGES)('throws when a plan changes the signed $field', ({ signed, change }) => {
        expect(() => assertALPublicationProofSigningInputKept(signed, change(signed))).toThrow(
            `A plan changed a signed field of publication ${signed.id.msgId}.`
        );
    });

    it.each(EXCLUDED_FIELD_CHANGES)('keeps a plan that changes only the excluded $field', ({ signed, change }) => {
        expect(() => assertALPublicationProofSigningInputKept(signed, change(signed))).not.toThrow();
    });
});
