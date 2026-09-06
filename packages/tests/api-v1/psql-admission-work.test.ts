import { describe, expect, it, vi } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { RUNTIME_STATE_PREFIX_READ_PAGE_SIZE } from '@shared-server/al-runtime/postgres/read-runtime-state-entries-by-prefix.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from '@shared/alm/outbound/to-al-outbound-prepared-fingerprint.ts';
import {
    createALInboundAdmissionStore,
    createALOutboundAdmissionStore,
    newALAckControlMessage,
    newALUnicastMessage,
    normalizeALRuntimeStoreRetention
} from '@shared/mod.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage } from '../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';

interface IndexedRecord {
    readonly index: number;
}

interface TestPreparedOutboundSend {
    readonly kind: 'send';
    readonly msgId: string;
}

describe('PostgreSQL inbound admission', () => {
    it('lists prefix rows through runtime-state pages when available', async () => {
        const { sql, repository } = await createPSqlAdmissionTestStorage();
        const namespace = 'psql-test:inbound:paged-list';
        const backend = new PSqlAdmissionWorkBackend(sql, namespace);
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

        const values = await backend.list(prefix, decodeIndexedRecord);

        expect(values).toHaveLength(total);
        expect(values[0]).toEqual({
            key: 'effect:000000',
            value: { index: 0 }
        });
        expect(values.at(-1)).toEqual({
            key: `effect:${String(total - 1).padStart(6, '0')}`,
            value: { index: total - 1 }
        });
    });

    it('returns a read-only admission result without opening a SQL transaction', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend(sql, 'psql-test:read-only');
        vi.spyOn(sql, 'begin').mockRejectedValue(new Error('A read-only result must not begin a write'));

        await expect(backend.write((read) => read.read('missing', decodeIndexedRecord))).resolves.toBeUndefined();
    });

    it('conditionally advances the inbound sender version', async () => {
        const { sql, repository } = await createPSqlAdmissionTestStorage();
        const namespace = 'psql-test:inbound:admission';
        const store = createALInboundAdmissionStore({
            namespace,
            backend: new PSqlAdmissionWorkBackend(sql, namespace),
            orderingTrackTtlMs: 5 * 60_000,
            supersedenceTrackTtlMs: 5 * 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });

        const status = await store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            versionExpireAtTimestamp: Date.now() + 60_000,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: 'msg-1',
                    senderId: 'peer-1',
                    source: { kind: 'ws-client', peerId: 'peer-1' },
                    supersedenceKey: null,
                    expireAtTimestamp: Date.now() + 60_000
                }
            ]
        });

        expect(status).toBe('committed');
        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:peer-1`);
        expect(versionEntry).toBeDefined();
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'peer-1',
            version: 1
        });
    });

    it('bumps the owning sender version when accepting a control message', async () => {
        const { sql, repository } = await createPSqlAdmissionTestStorage();
        const namespace = 'psql-test:inbound:admission';
        const store = createALInboundAdmissionStore({
            namespace,
            backend: new PSqlAdmissionWorkBackend(sql, namespace),
            orderingTrackTtlMs: 5 * 60_000,
            supersedenceTrackTtlMs: 5 * 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });

        await store.commitMutations({
            senderId: 'peer-1',
            expectedVersion: undefined,
            versionExpireAtTimestamp: Date.now() + 60_000,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId: 'msg-1',
                    senderId: 'peer-1',
                    source: { kind: 'ws-client', peerId: 'peer-1' },
                    supersedenceKey: null,
                    expireAtTimestamp: Date.now() + 60_000
                },
                {
                    kind: 'set-control-pending',
                    msgId: 'msg-1',
                    senderId: 'peer-1',
                    value: {
                        kind: 'pending',
                        value: {
                            toPeerId: 'peer-1',
                            status: 'subtree-complete',
                            localReady: false,
                            expectedFromPeerIds: ['peer-2'],
                            ackedFromPeerIds: []
                        }
                    },
                    expireAtTimestamp: Date.now() + 60_000
                },
                {
                    kind: 'set-control-owners',
                    msgId: 'msg-1',
                    expected: undefined,
                    value: { ambiguous: false, values: [{ peerId: 'peer-2', senderId: 'peer-1' }] },
                    expireAtTimestamp: Date.now() + 60_000
                }
            ]
        });
        const acceptance = await store.acceptControlMessage(
            newALAckControlMessage(
                { v: 2, msgId: 'ack-msg-1', ts: 1, senderId: 'peer-2' },
                {
                    ackedMsgId: 'msg-1',
                    fromPeerId: 'peer-2',
                    toPeerId: 'self',
                    status: 'delivered',
                    observedAtEpochMs: 1
                }
            )
        );

        expect(acceptance.handled).toBe(true);
        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:peer-1`);
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'peer-1',
            version: 2
        });

        const ackEntry = await repository.findEntry(namespace, `${namespace}:control:acks:msg-1:peer-1`);
        expect(ackEntry).toBeDefined();
    });
});

describe('PostgreSQL outbound admission', () => {
    it('conditionally advances sender version and persists durable effects in one commit', async () => {
        const { sql, repository } = await createPSqlAdmissionTestStorage();
        const namespace = 'psql-test:outbound:admission';
        const backend = new PSqlAdmissionWorkBackend(sql, namespace);
        const store = createALOutboundAdmissionStore({
            namespace,
            backend,
            supersedenceTrackTtlMs: 5 * 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const msg = createOutboundMessage('msg-outbound-1');
        const prepared = {
            kind: 'send',
            msgId: msg.id.msgId
        } satisfies TestPreparedOutboundSend;
        const preparedFingerprint = toALOutboundPreparedFingerprint(prepared);
        const effectId = toALOutboundEffectId([
            'send',
            msg.id.msgId,
            'immediate',
            0,
            preparedFingerprint
        ]);

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
                        preparedFingerprint,
                        phase: 'immediate'
                    }
                }
            ]
        }, decodePreparedOutboundSend);

        expect(status).toBe('committed');
        const versionEntry = await repository.findEntry(namespace, `${namespace}:version:self`);
        expect(JSON.parse(versionEntry!.value)).toEqual({
            senderId: 'self',
            version: 1
        });

        const workKey = toALOutboundWorkKey(namespace, effectId);
        const effectEntry = await backend.workQueue.getItem(workKey);
        expect(effectEntry).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
        expect(JSON.parse(effectEntry!.resource)).toMatchObject({
            namespace,
            effectId,
            payload: {
                kind: 'send-prepared'
            }
        });

        const claimed = await store.claimReadyEffects({ maxCount: 1 }, decodePreparedOutboundSend);

        expect(claimed).toHaveLength(1);
        expect(claimed[0].effectId).toBe(effectId);
        await store.completeEffect(claimed[0].entry);
        expect(await backend.workQueue.getItem(workKey)).toMatchObject({ status: EntityStatus.COMPLETED });
        expect(await store.peekNextEffectReadyAt()).toBeUndefined();
    });

    it('bumps the owning sender version when accepting outbound control messages', async () => {
        const { sql, repository } = await createPSqlAdmissionTestStorage();
        const namespace = 'psql-test:outbound:admission';
        const store = createALOutboundAdmissionStore({
            namespace,
            backend: new PSqlAdmissionWorkBackend(sql, namespace),
            supersedenceTrackTtlMs: 5 * 60_000,
            retention: normalizeALRuntimeStoreRetention()
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
                },
                {
                    kind: 'set-sent-message',
                    snapshot: { msgId: msg.id.msgId, msg }
                },
                {
                    kind: 'set-pending-ack',
                    snapshot: {
                        msgId: msg.id.msgId,
                        expectedPeerIds: ['peer-1'],
                        ackedPeerIds: [],
                        timeoutMs: 2_000,
                        maxAttempts: 3,
                        attempts: 0,
                        deadlineAtMs: Date.now() + 2_000
                    }
                }
            ],
            durableEffects: []
        }, decodePreparedOutboundSend);
        const acceptance = await store.acceptControlMessage(
            newALAckControlMessage(
                { v: 2, msgId: 'ack-outbound-message', ts: 1, senderId: 'peer-1' },
                {
                    ackedMsgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    status: 'delivered',
                    observedAtEpochMs: 1
                }
            ),
            decodePreparedOutboundSend
        );

        expect(acceptance.handled).toBe(true);
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
        const { createDefaultPSqlALOutboundRuntimeStores } = await import(
            '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts'
        );
        const { repository } = await createPSqlAdmissionTestStorage();
        const namespace = 'psql-test:factory';
        const stores = createDefaultPSqlALOutboundRuntimeStores({
            namespace,
            repository
        });
        const msg = createOutboundMessage('msg-factory');

        expect(stores.admissionStore).toBeDefined();
        await stores.admissionStore.commitBundle({
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
        }, decodePreparedOutboundSend);

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

function decodeIndexedRecord(value: unknown): IndexedRecord {
    if (
        typeof value !== 'object' || value === null ||
        !('index' in value) || typeof value.index !== 'number' || !Number.isSafeInteger(value.index)
    ) {
        throw new TypeError('Stored indexed record must contain an integer index');
    }
    return { index: value.index };
}

function decodePreparedOutboundSend(value: unknown, msg: ALMessage): TestPreparedOutboundSend {
    if (
        typeof value !== 'object' || value === null ||
        !('kind' in value) || value.kind !== 'send' ||
        !('msgId' in value) || value.msgId !== msg.id.msgId
    ) {
        throw new TypeError('Stored prepared send must match its outbound message');
    }
    return { kind: value.kind, msgId: value.msgId };
}
