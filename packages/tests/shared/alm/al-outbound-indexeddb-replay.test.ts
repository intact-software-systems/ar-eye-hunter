// @vitest-environment happy-dom

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_WORK_STORE_NAME, openIndexedDbAdmissionDatabase } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { IndexedDbConnection } from '@shared/persistence/open-indexed-db.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

import '../../setup-browser-indexeddb.ts';
import {
    createDefaultOutboundTestRuntime,
    createFlakyOutboundAdmissionStore,
    createOutboundMessage,
    reserveOutbox
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound IndexedDB durable queue replay', () => {
    it.each(['memory', 'indexeddb'] as const)('skips a complete audience after restart while replaying an incomplete audience in %s', async (storage) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { store } = createAdmission(storage);
        const messages = ['complete', 'partial'].map((resourceId) =>
            newALMulticastMessage(
                'self',
                { topicId: 'chat', resourceId, contextId: 'room' },
                { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
                'chat.message.v1',
                { text: resourceId },
                { ttlMs: 30_000, ack: 'receiver', reliability: 'at-least-once' }
            )
        );
        const runtime1 = createDefaultOutboundTestRuntime({
            queueEngine: new InboxOutboxEngine(),
            stores: { admissionStore: store },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ text: msg.route.resourceId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: msg.route.resourceId === 'complete' ? 100 : 60_000,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1', 'peer-2']
                }
            }),
            sendPreparedMessage: async () => ({ status: 'queued', settled: new Promise(() => {}) })
        });
        for (const msg of messages) {
            expect((await runtime1.enqueueIfAbsent(msg)).status).toBe('accepted');
            const respondents = msg.route.resourceId === 'complete' ? ['peer-1', 'peer-2'] : ['peer-1'];
            for (const fromPeerId of respondents) {
                await runtime1.acceptControlMessage(newALAckControlMessage(
                    { v: 2, msgId: crypto.randomUUID(), ts: Date.now(), senderId: fromPeerId },
                    { ackedMsgId: msg.id.msgId, fromPeerId, toPeerId: 'self', status: 'accepted', observedAtEpochMs: Date.now() }
                ));
            }
        }
        runtime1.dispose();
        vi.setSystemTime(Date.now() + 10_001);

        const sent: string[] = [];
        const runtime2 = createDefaultOutboundTestRuntime({
            queueEngine: new InboxOutboxEngine(),
            stores: { admissionStore: store },
            planOutgoingMessage: () => {
                throw new Error('Replay must use the retained message');
            },
            sendPreparedMessage: async (message) => {
                sent.push(message.text ?? '');
                return { status: 'sent' };
            }
        });
        await runtime2.ready();
        expect(sent).toEqual(['partial']);
        expect(await store.getPendingAck(messages[0].id.msgId)).toBeUndefined();
        expect(await store.readReceiptState(messages[0].id.msgId)).toMatchObject({
            expectedPeerIds: ['peer-1', 'peer-2'],
            ackedPeerIds: ['peer-1', 'peer-2']
        });
        expect(await store.getPendingAck(messages[1].id.msgId)).toMatchObject({
            expectedPeerIds: ['peer-1', 'peer-2'],
            ackedPeerIds: ['peer-1']
        });
    });

    it('retries through its injected queue engine and leaves unrelated work registered after disposal', async () => {
        vi.useFakeTimers();
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const engine = new InboxOutboxEngine();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            queueEngine: engine,
            planOutgoingMessage: () => ({ persist: false, preparedMessages: [{ text: 'engine-owned' }] }),
            sendPreparedMessage: async (message) => {
                sent.push(message.text ?? '');
                return sent.length === 1 ? { status: 'not-ready', retryAfterMs: 20 } : { status: 'sent' };
            }
        });
        await runtime.enqueueIfAbsent(createOutboundMessage('engine-owned'));
        expect(sent).toEqual(['engine-owned']);

        vi.setSystemTime(Date.now() + 100);
        await engine.executeOnce();
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(['engine-owned', 'engine-owned']);

        let unrelatedWork = true;
        engine.includeTask('unrelated', {
            name: 'unrelated',
            maxConcurrency: () => 1,
            isWork: () => unrelatedWork,
            runnable: () => {
                unrelatedWork = false;
            },
            ongoingTasks: []
        });
        runtime.dispose();
        await engine.executeOnce();
        expect(unrelatedWork).toBe(false);
        expect(sent).toEqual(['engine-owned', 'engine-owned']);
    });

    it('retains an actual QueueBox reservation while a runtime send waits in the native queue', async () => {
        const dbName = `outbound-queue-owner-${crypto.randomUUID()}`;
        const store = createALOutboundAdmissionStore({
            namespace: 'outbound',
            backend: new IndexedDbAdmissionBackend(dbName, 'admission', Date.now),
            supersedenceTrackTtlMs: 1_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore: store },
            planOutgoingMessage: () => ({ persist: false, preparedMessages: [{ text: 'retained' }] }),
            sendPreparedMessage: async () => ({ status: 'queued', settled: new Promise(() => {}) })
        });
        const msg = createOutboundMessage('queue-owned-send');
        expect((await runtime.enqueueIfAbsent(msg)).status).toBe('accepted');
        const database = await openIndexedDbAdmissionDatabase(dbName, 'admission');
        onTestFinished(() => database.close());
        const queue = new IndexedDbQueueBox({
            connection: new IndexedDbConnection(async () => database),
            storeName: AL_ADMISSION_WORK_STORE_NAME
        });
        const keys = await queue.getAllKeys();
        expect(keys).toHaveLength(1);
        const reserved = await queue.getItem(keys[0]);
        expect(reserved).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });
        expect(JSON.parse(reserved!.resource)).toMatchObject({
            payload: { kind: 'send-prepared', msg: { id: { msgId: msg.id.msgId } } }
        });
    });

    it.each(['memory', 'indexeddb'] as const)('fences old completion and retry after the same worker reclaims an effect in %s', async (storage) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { store } = createAdmission(storage);
        const msg = createOutboundMessage('lease-fence');
        const nowMs = Date.now();
        await store.commitBundle({
            senderId: msg.id.senderId,
            mutations: [],
            durableEffects: [{ effectId: 'lease-fence', retryAtMs: nowMs, payload: { kind: 'ack-timeout', msgId: msg.id.msgId } }]
        }, decodeOutboundTestPayload);
        const [oldClaim] = await store.claimReadyEffects(
            { maxCount: 1 },
            decodeOutboundTestPayload
        );
        vi.setSystemTime(nowMs + 10_001);
        const [newClaim] = await store.claimReadyEffects(
            { maxCount: 1 },
            decodeOutboundTestPayload
        );

        await store.completeEffect(oldClaim.entry);
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBe(newClaim.leaseUntilMs);
        await store.rescheduleEffect({
            reservation: oldClaim.entry,
            retryAtMs: nowMs + 50_000
        });
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBe(newClaim.leaseUntilMs);
        await store.completeEffect(newClaim.entry);
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
    });

    it('keeps Temporal entry values across persistence, lease, reschedule and runtime restart', async () => {
        const { store } = createAdmission();
        const msg = createOutboundMessage('queued');
        const runtime1 = createDefaultOutboundTestRuntime({
            stores: { admissionStore: createFlakyOutboundAdmissionStore(store, { claimReadyEffects: async () => [] }) },
            planOutgoingMessage: () => ({ persist: true, preparedMessages: [] }),
            sendPreparedMessage: async () => {
                throw new Error('No transport effect was planned');
            }
        });
        const enqueued = await runtime1.enqueueIfAbsent(msg);
        runtime1.dispose();

        const [claimed] = await store.claimReadyEffects(
            { maxCount: 1 },
            decodeOutboundTestPayload
        );
        expect(claimed.payload.kind).toBe('enqueue-outbox');
        await store.rescheduleEffect(
            { reservation: claimed.entry, retryAtMs: Date.now() }
        );

        const outbox = new InMemoryQueueBox(new Map());
        const runtime2 = createDefaultOutboundTestRuntime({
            stores: { admissionStore: store },
            outbox,
            planOutgoingMessage: () => {
                throw new Error('Saved queue effect must not replan');
            },
            sendPreparedMessage: async () => {
                throw new Error('Saved queue effect must not send');
            }
        });
        await runtime2.ready();
        const [replayed] = await reserveOutbox(outbox);
        expect(replayed.audit.date).toBeInstanceOf(Temporal.PlainTime);
        expect(replayed.audit.createdTs).toBeInstanceOf(Temporal.PlainDateTime);
        expect(replayed.audit.expiryTs).toBeInstanceOf(Temporal.Instant);
        expect(replayed.audit.expiryTs.toString()).toBe(enqueued.entry?.audit.expiryTs.toString());
        expect(replayed.resource).toBe(JSON.stringify(msg));
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
    });

    it.each(['memory', 'indexeddb'] as const)('finishes exhausted QueueBox work without advertising another retry in %s', async (storage) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { store, backend } = createAdmission(storage);
        await store.commitBundle({
            senderId: 'self',
            mutations: [],
            durableEffects: [{ effectId: 'exhausted', payload: { kind: 'ack-timeout', msgId: 'exhausted' } }]
        }, decodeOutboundTestPayload);

        for (let attempt = 1; attempt <= DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts; attempt += 1) {
            const [claimed] = await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload);
            expect(claimed.attempts).toBe(attempt);
            await store.rescheduleEffect({ reservation: claimed.entry, retryAtMs: Date.now() });
            vi.setSystemTime(Date.now() + 1);
        }

        const [key] = await backend.workQueue.getAllKeys();
        expect(await backend.workQueue.getItem(key)).toMatchObject({
            status: EntityStatus.FAILED,
            dequeueAudit: { attempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts }
        });
        expect(await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload)).toEqual([]);
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
    });

    it.each(['memory', 'indexeddb'] as const)('finalizes the last crashed attempt without sending again in %s', async (storage) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { store, backend } = createAdmission(storage);
        await store.commitBundle({
            senderId: 'self',
            mutations: [],
            durableEffects: [{ effectId: 'crashed-last-attempt', payload: { kind: 'ack-timeout', msgId: 'crashed-last-attempt' } }]
        }, decodeOutboundTestPayload);
        for (let attempt = 1; attempt <= 20; attempt += 1) {
            const [claimed] = await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload);
            expect(claimed.attempts).toBe(attempt);
            if (attempt < 20) {
                await store.rescheduleEffect({ reservation: claimed.entry, retryAtMs: Date.now() });
                vi.setSystemTime(Date.now() + 1);
            }
        }
        vi.setSystemTime(Date.now() + 10_001);

        expect(await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload)).toEqual([]);
        const [key] = await backend.workQueue.getAllKeys();
        expect(await backend.workQueue.getItem(key)).toMatchObject({ status: EntityStatus.FAILED });
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
    });

    it('keeps fallback entry timestamps across a persisted lease and rejects old empty timestamp objects', async () => {
        const { backend, store } = createAdmission();
        const msg = createOutboundMessage('fallback');
        const originalEntry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox');
        const timestamp = Temporal.Now.instant();
        const entry = {
            ...originalEntry,
            dequeueAudit: { ...originalEntry.dequeueAudit, startTs: timestamp, endTs: timestamp, nextTs: timestamp }
        };
        await store.commitBundle({
            senderId: msg.id.senderId,
            mutations: [],
            durableEffects: [{ effectId: 'fallback', payload: { kind: 'fallback-dispatch', msg, entry } }]
        }, decodeOutboundTestPayload);
        const [claimed] = await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload);
        if (claimed.payload.kind !== 'fallback-dispatch') {
            throw new Error('Expected the durable fallback effect');
        }
        expect(claimed.payload.entry.dequeueAudit.startTs?.toString()).toBe(timestamp.toString());
        expect(claimed.payload.entry.dequeueAudit.endTs?.toString()).toBe(timestamp.toString());
        expect(claimed.payload.entry.dequeueAudit.nextTs?.toString()).toBe(timestamp.toString());
        expect(await store.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBe(claimed.leaseUntilMs);
        await store.completeEffect(claimed.entry);

        const corrupt = {
            ...claimed.entry,
            resource: JSON.stringify({
                ...JSON.parse(claimed.entry.resource),
                payload: { kind: 'fallback-dispatch', msg, entry: { ...entry, audit: { ...entry.audit, expiryTs: {} } } }
            })
        };
        await backend.workQueue.setItem(corrupt.key, corrupt, { expireAtTimestamp: claimed.expireAtTimestamp });
        await expect(store.peekNextEffectReadyAt(decodeOutboundTestPayload)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });
});

function createAdmission(storage: 'memory' | 'indexeddb' = 'indexeddb') {
    const backend = storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend(`outbound-replay-${crypto.randomUUID()}`, 'admission', Date.now);
    const store = createALOutboundAdmissionStore({
        namespace: 'outbound',
        backend,
        supersedenceTrackTtlMs: 1_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { backend, store };
}
