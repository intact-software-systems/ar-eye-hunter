import { PSqlInboundAdmissionBackend } from '@shared-server/postgres/al-runtime/PSqlInboundAdmissionBackend.ts';
import { PSqlOutboundAdmissionBackend } from '@shared-server/postgres/al-runtime/PSqlOutboundAdmissionBackend.ts';
import { RUNTIME_STATE_PREFIX_READ_PAGE_SIZE } from '@shared-server/postgres/al-runtime/runtime-state-prefix-reader.ts';
import { createALInboundAdmissionStore, createALOutboundAdmissionStore, newALAckControlMessage, newALUnicastMessage } from '@shared/mod.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRuntimeStateRepository } from './fake-optimistic-runtime-state-repository.ts';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('PSqlInboundAdmissionBackend', () => {
    it('lists prefix rows through runtime-state pages when available', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:paged-list';
        const backend = new PSqlInboundAdmissionBackend(repository, namespace);
        const prefix = 'effect:';
        const total = RUNTIME_STATE_PREFIX_READ_PAGE_SIZE + 2;

        for (let index = 0; index < total; index++) {
            await repository.upsert(
                namespace,
                `${prefix}${String(index).padStart(6, '0')}`,
                JSON.stringify({ index }),
                Date.now() + 60_000
            );
        }
        await repository.upsert(
            namespace,
            'other:000001',
            JSON.stringify({ index: -1 }),
            Date.now() + 60_000
        );

        const values = await backend.list<{ index: number; }>(prefix);

        expect(values).toHaveLength(total);
        expect(values[0]).toEqual({
            key: 'effect:000000',
            value: { index: 0 }
        });
        expect(values.at(-1)).toEqual({
            key: `effect:${String(total - 1).padStart(6, '0')}`,
            value: { index: total - 1 }
        });
        expect(repository.findEntriesByPrefixCalls).toEqual([]);
        expect(repository.findEntriesByPrefixPageCalls).toEqual([
            {
                namespace,
                keyPrefix: prefix,
                afterKey: undefined,
                limit: RUNTIME_STATE_PREFIX_READ_PAGE_SIZE
            },
            {
                namespace,
                keyPrefix: prefix,
                afterKey: `effect:${String(RUNTIME_STATE_PREFIX_READ_PAGE_SIZE - 1).padStart(6, '0')}`,
                limit: RUNTIME_STATE_PREFIX_READ_PAGE_SIZE
            }
        ]);
    });

    it('conditionally advances the sender version without a domain lock', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:admission';
        const store = createALInboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlInboundAdmissionBackend(repository, namespace),
            orderingTrackTtlMs: 5 * 60_000,
            supersedenceTrackTtlMs: 5 * 60_000
        });

        const status = await store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: 'msg-1',
                    senderId: 'peer-1'
                }
            ]
        });

        expect(status).toBe('committed');
        expect(repository.lockedKeys).toEqual([]);
        expect(repository.conditionalWrites.length).toBeGreaterThan(0);

        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:peer-1`);
        expect(versionEntry).toBeDefined();
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'peer-1',
            version: 1
        });
    });

    it('bumps the owning sender version when accepting a control message', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:admission';
        const store = createALInboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlInboundAdmissionBackend(repository, namespace),
            orderingTrackTtlMs: 5 * 60_000,
            supersedenceTrackTtlMs: 5 * 60_000
        });

        await store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: 'msg-1',
                    senderId: 'peer-1'
                }
            ]
        });
        repository.lockedKeys.length = 0;

        const acceptance = await store.acceptControlMessage(
            newALAckControlMessage('peer-2', 'self', 'msg-1', 'delivered')
        );

        expect(acceptance.handled).toBe(true);
        expect(repository.lockedKeys).toEqual([]);

        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:peer-1`);
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'peer-1',
            version: 2
        });

        const ackEntry = await repository.findEntry(namespace, `${namespace}:control:acks:msg-1`);
        expect(ackEntry).toBeDefined();
    });
});

describe('PSqlOutboundAdmissionBackend', () => {
    it('lists prefix rows through runtime-state pages when available', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:outbound:paged-list';
        const backend = new PSqlOutboundAdmissionBackend(repository, namespace);
        const prefix = 'sent:';
        const total = RUNTIME_STATE_PREFIX_READ_PAGE_SIZE + 1;

        for (let index = 0; index < total; index++) {
            await repository.upsert(
                namespace,
                `${prefix}${String(index).padStart(6, '0')}`,
                JSON.stringify({ index }),
                Date.now() + 60_000
            );
        }

        const values = await backend.list<{ index: number; }>(prefix);

        expect(values).toHaveLength(total);
        expect(values.map((entry) => entry.value.index)).toEqual(
            Array.from({ length: total }, (_, index) => index)
        );
        expect(repository.findEntriesByPrefixCalls).toEqual([]);
        expect(repository.findEntriesByPrefixPageCalls).toEqual([
            {
                namespace,
                keyPrefix: prefix,
                afterKey: undefined,
                limit: RUNTIME_STATE_PREFIX_READ_PAGE_SIZE
            },
            {
                namespace,
                keyPrefix: prefix,
                afterKey: `sent:${String(RUNTIME_STATE_PREFIX_READ_PAGE_SIZE - 1).padStart(6, '0')}`,
                limit: RUNTIME_STATE_PREFIX_READ_PAGE_SIZE
            }
        ]);
    });

    it('conditionally advances sender version and persists durable effects in one commit', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:outbound:admission';
        const store = createALOutboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlOutboundAdmissionBackend(repository, namespace),
            supersedenceTrackTtlMs: 5 * 60_000
        });
        const msg = createOutboundMessage('msg-outbound-1');
        const effectId = `send:${msg.id.msgId}`;
        const prepared = {
            kind: 'send',
            msgId: msg.id.msgId
        } satisfies TestPreparedOutboundSend;

        const status = await store.commitBundle({
            senderId: 'self',
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: msg.id.msgId,
                    senderId: 'self'
                }
            ],
            durableEffects: [
                {
                    effectId,
                    expireAtTimestamp: Date.now() + 60_000,
                    payload: {
                        kind: 'send-prepared',
                        msg,
                        prepared,
                        phase: 'immediate'
                    }
                }
            ]
        });

        expect(status).toBe('committed');
        expect(repository.lockedKeys).toEqual([]);

        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:self`);
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'self',
            version: 1
        });

        const effectEntry = await repository.findEntry(
            namespace,
            `${namespace}:effect:${effectId}`
        );
        expect(effectEntry).toBeDefined();
        expect(JSON.parse(effectEntry!.value)).toMatchObject({
            effectId,
            status: 'pending',
            attempts: 0,
            payload: {
                kind: 'send-prepared'
            }
        });

        repository.lockedKeys.length = 0;
        const claimed = await store.claimReadyEffects<TestPreparedOutboundSend>(
            'worker-1',
            1,
            10_000,
            Date.now()
        );

        expect(claimed).toHaveLength(1);
        expect(claimed[0].effectId).toBe(effectId);
        expect(repository.lockedKeys).toEqual([]);

        await store.completeEffect(effectId, 'worker-1');
        expect(
            await repository.findEntry(namespace, `${namespace}:effect:${effectId}`)
        ).toBeUndefined();
    });

    it('bumps the owning sender version when accepting outbound control messages', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:outbound:admission';
        const store = createALOutboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlOutboundAdmissionBackend(repository, namespace),
            supersedenceTrackTtlMs: 5 * 60_000
        });
        const msg = createOutboundMessage('msg-outbound-ack');

        await store.commitBundle({
            senderId: 'self',
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: msg.id.msgId,
                    senderId: 'self'
                }
            ],
            durableEffects: []
        });
        repository.lockedKeys.length = 0;

        const acceptance = await store.acceptControlMessage(
            newALAckControlMessage('peer-1', 'self', msg.id.msgId)
        );

        expect(acceptance.handled).toBe(true);
        expect(repository.lockedKeys).toEqual([]);

        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:self`);
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'self',
            version: 2
        });

        const ackEntry = await repository.findEntry(
            namespace,
            `${namespace}:control:acks:${msg.id.msgId}`
        );
        expect(ackEntry).toBeDefined();
    });

    it('wires PostgreSQL outbound admission into the server runtime store factory', async () => {
        const { createPSqlALOutboundRuntimeStores } = await import(
            '@shared-server/postgres/al-runtime/createPSqlALRuntimeStores.ts'
        );
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:factory';
        const stores = createPSqlALOutboundRuntimeStores({
            namespace,
            repository
        });
        const msg = createOutboundMessage('msg-factory');

        expect(stores.admissionStore).toBeDefined();
        await stores.admissionStore!.commitBundle({
            senderId: 'self',
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: msg.id.msgId,
                    senderId: 'self'
                }
            ],
            durableEffects: []
        });

        const admissionNamespace = `${namespace}:outbound:admission`;
        const versionEntry = await repository.findEntry(
            admissionNamespace,
            `${admissionNamespace}:version:self`
        );
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'self',
            version: 1
        });
    });
});

function createOutboundMessage(resourceId: string) {
    return newALUnicastMessage(
        'self',
        {
            topicId: 'chat',
            resourceId,
            contextId: 'conversation-1'
        },
        'peer-1',
        'chat.private-text.v1',
        {
            text: resourceId
        }
    );
}

type TestPreparedOutboundSend = Readonly<{
    kind: 'send';
    msgId: string;
}>;
