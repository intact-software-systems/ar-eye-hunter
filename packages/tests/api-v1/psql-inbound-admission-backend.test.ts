import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createALInboundAdmissionStore,
    createALOutboundAdmissionStore,
    newALAckControlMessage,
    newALUnicastMessage,
} from '@shared/mod.ts';
import { PSqlInboundAdmissionBackend } from '@shared-server/postgres/al-runtime/PSqlInboundAdmissionBackend.ts';
import { PSqlOutboundAdmissionBackend } from '@shared-server/postgres/al-runtime/PSqlOutboundAdmissionBackend.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('PSqlInboundAdmissionBackend', () => {
    it('locks the sender version key when committing mutations', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:inbound:admission';
        const store = createALInboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlInboundAdmissionBackend(repository, namespace),
            orderingTrackTtlMs: 5 * 60_000,
            supersedenceTrackTtlMs: 5 * 60_000,
        });

        const status = await store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: 'msg-1',
                    senderId: 'peer-1',
                },
            ],
        });

        expect(status).toBe('committed');
        expect(repository.lockedKeys).toContainEqual({
            namespace,
            key: `${namespace}:version:peer-1`,
        });

        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:peer-1`);
        expect(versionEntry).toBeDefined();
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'peer-1',
            version: 1,
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
            supersedenceTrackTtlMs: 5 * 60_000,
        });

        await store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: 'msg-1',
                    senderId: 'peer-1',
                },
            ],
        });
        repository.lockedKeys.length = 0;

        const acceptance = await store.acceptControlMessage(
            newALAckControlMessage('peer-2', 'self', 'msg-1', 'delivered'),
        );

        expect(acceptance.handled).toBe(true);
        expect(repository.lockedKeys).toContainEqual({
            namespace,
            key: `${namespace}:version:peer-1`,
        });

        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:peer-1`);
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'peer-1',
            version: 2,
        });

        const ackEntry = await repository.findEntry(namespace, `${namespace}:control:acks:msg-1`);
        expect(ackEntry).toBeDefined();
    });
});

describe('PSqlOutboundAdmissionBackend', () => {
    it('locks the sender version key and persists durable effects when committing a bundle', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:outbound:admission';
        const store = createALOutboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlOutboundAdmissionBackend(repository, namespace),
            supersedenceTrackTtlMs: 5 * 60_000,
        });
        const msg = createOutboundMessage('msg-outbound-1');
        const effectId = `send:${msg.id.msgId}`;
        const prepared = {
            kind: 'send',
            msgId: msg.id.msgId,
        } satisfies TestPreparedOutboundSend;

        const status = await store.commitBundle({
            senderId: 'self',
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: msg.id.msgId,
                    senderId: 'self',
                },
            ],
            durableEffects: [
                {
                    effectId,
                    expireAtTimestamp: Date.now() + 60_000,
                    payload: {
                        kind: 'send-prepared',
                        msg,
                        prepared,
                        phase: 'immediate',
                    },
                },
            ],
        });

        expect(status).toBe('committed');
        expect(repository.lockedKeys).toContainEqual({
            namespace,
            key: `${namespace}:version:self`,
        });

        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:self`);
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'self',
            version: 1,
        });

        const effectEntry = await repository.findEntry(
            namespace,
            `${namespace}:effect:${effectId}`,
        );
        expect(effectEntry).toBeDefined();
        expect(JSON.parse(effectEntry!.value)).toMatchObject({
            effectId,
            status: 'pending',
            attempts: 0,
            payload: {
                kind: 'send-prepared',
            },
        });

        repository.lockedKeys.length = 0;
        const claimed = await store.claimReadyEffects<TestPreparedOutboundSend>(
            'worker-1',
            1,
            10_000,
            Date.now(),
        );

        expect(claimed).toHaveLength(1);
        expect(claimed[0].effectId).toBe(effectId);
        expect(repository.lockedKeys).toContainEqual({
            namespace,
            key: `${namespace}:effects:claim-lock`,
        });

        await store.completeEffect(effectId, 'worker-1');
        expect(
            await repository.findEntry(namespace, `${namespace}:effect:${effectId}`),
        ).toBeUndefined();
    });

    it('bumps the owning sender version when accepting outbound control messages', async () => {
        const repository = new FakeRuntimeStateRepository();
        const namespace = 'psql-test:outbound:admission';
        const store = createALOutboundAdmissionStore({
            kind: 'backend',
            namespace,
            backend: new PSqlOutboundAdmissionBackend(repository, namespace),
            supersedenceTrackTtlMs: 5 * 60_000,
        });
        const msg = createOutboundMessage('msg-outbound-ack');

        await store.commitBundle({
            senderId: 'self',
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: msg.id.msgId,
                    senderId: 'self',
                },
            ],
            durableEffects: [],
        });
        repository.lockedKeys.length = 0;

        const acceptance = await store.acceptControlMessage(
            newALAckControlMessage('peer-1', 'self', msg.id.msgId),
        );

        expect(acceptance.handled).toBe(true);
        expect(repository.lockedKeys).toContainEqual({
            namespace,
            key: `${namespace}:version:self`,
        });

        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:self`);
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'self',
            version: 2,
        });

        const ackEntry = await repository.findEntry(
            namespace,
            `${namespace}:control:acks:${msg.id.msgId}`,
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
            repository,
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
                    senderId: 'self',
                },
            ],
            durableEffects: [],
        });

        const admissionNamespace = `${namespace}:outbound:admission`;
        const versionEntry = await repository.findEntry(
            admissionNamespace,
            `${admissionNamespace}:version:self`,
        );
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'self',
            version: 1,
        });
    });
});

function createOutboundMessage(resourceId: string) {
    return newALUnicastMessage(
        'self',
        {
            topicId: 'chat',
            resourceId,
            contextId: 'conversation-1',
        },
        'peer-1',
        'chat.private-text.v1',
        {
            text: resourceId,
        },
    );
}

type TestPreparedOutboundSend = Readonly<{
    kind: 'send';
    msgId: string;
}>;

class FakeRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();
    readonly lockedKeys: Array<Readonly<{ namespace: string; key: string }>> = [];

    async begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        return await fn(this);
    }

    async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const entry = this.data.get(this.toKey(namespace, key));
        return entry ? { ...entry } : undefined;
    }

    async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return [...this.data.entries()]
            .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
            .map(([, entry]) => ({ ...entry }));
    }

    async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        return [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    this.toStoreKey(compositeKey).startsWith(keyPrefix),
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<void> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0,
        });
    }

    async deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
    }

    async deleteExpired(namespace: string): Promise<number> {
        let deleted = 0;
        for (const [compositeKey, entry] of this.data.entries()) {
            if (this.toNamespace(compositeKey) !== namespace) {
                continue;
            }

            if (entry.expireAtTimestamp > Date.now()) {
                continue;
            }

            this.data.delete(compositeKey);
            deleted += 1;
        }

        return deleted;
    }

    async lockKey(namespace: string, key: string): Promise<void> {
        this.lockedKeys.push({ namespace, key });
    }

    private toKey(namespace: string, key: string): string {
        return `${namespace}::${key}`;
    }

    private toNamespace(compositeKey: string): string {
        return compositeKey.split('::', 1)[0] ?? '';
    }

    private toStoreKey(compositeKey: string): string {
        return compositeKey.slice(this.toNamespace(compositeKey).length + 2);
    }
}
