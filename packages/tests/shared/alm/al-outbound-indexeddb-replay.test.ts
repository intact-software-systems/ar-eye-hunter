// @vitest-environment happy-dom

import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_WORK_STORE_NAME, openIndexedDbAdmissionDatabase } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { IndexedDbConnection } from '@shared/persistence/open-indexed-db.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import '../../setup-browser-indexeddb.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import {
    createDefaultOutboundTestRuntime,
    createFlakyOutboundAdmissionStore,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound IndexedDB durable queue replay', () => {
    it.each(['memory', 'indexeddb'] as const)('retains malformed work as non-retryable and releases unrelated work in %s', async (storage) => {
        const { store, backend } = createAdmission(storage);
        await store.commitBundle({
            senderId: 'self',
            mutations: [],
            durableEffects: ['malformed', 'valid'].map((msgId) => ({
                effectId: msgId,
                payload: { kind: 'ack-timeout', msgId }
            }))
        }, decodeOutboundTestPayload);
        const malformedKey = toALOutboundWorkKey('outbound', 'malformed');
        const original = await backend.workQueue.getItem(malformedKey);
        if (original === undefined) {
            throw new Error('Expected persisted malformed-work fixture');
        }
        await backend.workQueue.setItem(malformedKey, { ...original, resource: '{invalid-json' }, {
            expireAtTimestamp: Number(original.audit.expiryTs.epochMilliseconds)
        });

        const claimed = await store.claimReadyEffects({ maxCount: 3 }, decodeOutboundTestPayload);

        expect(claimed.map((effect) => effect.payload)).toEqual([{ kind: 'ack-timeout', msgId: 'valid' }]);
        expect(await backend.workQueue.getItem(malformedKey)).toMatchObject({
            resource: '{invalid-json',
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 1, nextTs: undefined }
        });
        await store.completeEffect(claimed[0]!.entry);
        expect(await store.peekNextEffectReadyAt()).toBeUndefined();
        expect(await store.claimReadyEffects({ maxCount: 3 }, decodeOutboundTestPayload)).toEqual([]);
    });

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
                msg: msg,
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
        expect(await store.readPendingAck(messages[0].id.msgId)).toBeUndefined();
        expect(await store.readReceiptState(messages[0].id.msgId)).toMatchObject({
            expectedPeerIds: ['peer-1', 'peer-2'],
            ackedPeerIds: ['peer-1', 'peer-2']
        });
        expect(await store.readPendingAck(messages[1].id.msgId)).toMatchObject({
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
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [{ text: 'engine-owned' }] }),
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
            backend: new IndexedDbAdmissionBackend({
                dbName: dbName,
                storeName: 'admission',
                nowMs: Date.now,
                newWriteToken: crypto.randomUUID.bind(crypto),
                observer: createPassThroughIndexedDbOperationObserver()
            }),
            supersedenceTrackTtlMs: 1_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore: store },
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [{ text: 'retained' }] }),
            sendPreparedMessage: async () => ({ status: 'queued', settled: new Promise(() => {}) })
        });
        const msg = createOutboundMessage('queue-owned-send');
        expect((await runtime.enqueueIfAbsent(msg)).status).toBe('accepted');
        const database = await openIndexedDbAdmissionDatabase(dbName, 'admission');
        onTestFinished(() => database.close());
        const queue = new IndexedDbQueueBox({
            connection: new IndexedDbConnection(async () => database),
            storeName: AL_ADMISSION_WORK_STORE_NAME,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const keys = await queue.getAllKeys();
        expect(keys).toHaveLength(3);
        const reserved = await queue.getItem(keys.find((key) => key.topicId === 'AL_OUTBOUND')!);
        expect(reserved).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });
        expect(JSON.parse(reserved!.resource)).toMatchObject({
            payload: { kind: 'send-prepared', message: { msgId: msg.id.msgId } }
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
        expect(await store.peekNextEffectReadyAt()).toBe(newClaim.leaseUntilMs);
        await store.rescheduleEffect({
            reservation: oldClaim.entry,
            retryAtMs: nowMs + 50_000
        });
        expect(await store.peekNextEffectReadyAt()).toBe(newClaim.leaseUntilMs);
        await store.completeEffect(newClaim.entry);
        expect(await store.peekNextEffectReadyAt()).toBeUndefined();
    });

    it('keeps canonical and action Temporal values across persistence, lease, reschedule and runtime restart', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { store, backend } = createAdmission();
        const msg = createOutboundMessage('queued');
        const runtime1 = createDefaultOutboundTestRuntime({
            stores: { admissionStore: createFlakyOutboundAdmissionStore(store, { claimReadyEffects: async () => [] }) },
            planOutgoingMessage: (message) => ({ msg: message, persist: true, preparedMessages: [{ text: 'captured-recipient' }] }),
            sendPreparedMessage: async () => {
                throw new Error('Claims are held until restart');
            }
        });
        const enqueued = await runtime1.enqueueIfAbsent(msg);
        runtime1.dispose();
        const [claimed] = await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload);
        expect(claimed.payload.kind).toBe('send-prepared');
        expect(claimed.canonicalMessage).toEqual(msg);
        expect(claimed.entry.audit.date).toBeInstanceOf(Temporal.PlainTime);
        expect(claimed.entry.audit.createdTs).toBeInstanceOf(Temporal.PlainDateTime);
        expect(claimed.entry.audit.expiryTs).toBeInstanceOf(Temporal.Instant);
        expect(claimed.entry.dequeueAudit.startTs).toBeInstanceOf(Temporal.Instant);
        await store.rescheduleEffect({ reservation: claimed.entry, retryAtMs: Date.now() });
        const retryAt = await store.peekNextEffectReadyAt();
        expect(retryAt).toBeDefined();
        vi.setSystemTime(retryAt!);
        const sent: string[] = [];
        const runtime2 = createDefaultOutboundTestRuntime({
            stores: { admissionStore: store },
            planOutgoingMessage: () => {
                throw new Error('Saved prepared attempt must not replan');
            },
            sendPreparedMessage: async (prepared, _phase, lifecycle) => {
                sent.push(prepared.text!);
                expect(lifecycle.canonicalMessage).toEqual(msg);
                return { status: 'sent' };
            }
        });
        await runtime2.ready();
        expect(sent).toEqual(['captured-recipient']);
        const canonical = await backend.workQueue.getItem(enqueued.entry!.key);
        expect(canonical?.status).toBe(EntityStatus.COMPLETED);
        expect(canonical?.audit.expiryTs).toBeInstanceOf(Temporal.Instant);
        expect(canonical?.audit.expiryTs.toString()).toBe(enqueued.entry?.audit.expiryTs.toString());
        expect(canonical?.resource).toBe(JSON.stringify(msg));
        expect(await store.peekNextEffectReadyAt()).toBeUndefined();
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
        expect(await store.peekNextEffectReadyAt()).toBeUndefined();
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
        expect(await store.peekNextEffectReadyAt()).toBeUndefined();
    });

    it('rejects a changed canonical deadline after an IndexedDB restart without resetting the action', async () => {
        const { backend, store } = createAdmission();
        const message = createOutboundMessage('changed-canonical-deadline');
        const runtime1 = createDefaultOutboundTestRuntime({
            stores: { admissionStore: createFlakyOutboundAdmissionStore(store, { claimReadyEffects: async () => [] }) },
            planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ text: 'captured' }] }),
            sendPreparedMessage: async () => {
                throw new Error('Claims are held');
            }
        });
        const admitted = await runtime1.enqueueIfAbsent(message);
        runtime1.dispose();
        const canonical = await backend.workQueue.getItem(admitted.entry!.key);
        const corrupted = {
            ...canonical!,
            resource: JSON.stringify({ ...message, constraints: { ...message.constraints, expiresAtMs: message.constraints!.expiresAtMs! + 1 } })
        };
        await backend.workQueue.setItem(corrupted.key, corrupted, { expireAtTimestamp: Number(corrupted.audit.expiryTs.epochMilliseconds) });
        expect(await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload)).toEqual([]);
        const keys = await backend.workQueue.getAllKeys();
        const action = await backend.workQueue.getItem(keys.find((key) => key.topicId === 'AL_OUTBOUND')!);
        expect(action?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect((await backend.workQueue.getItem(corrupted.key))?.resource).toBe(corrupted.resource);
        expect(await store.peekNextEffectReadyAt()).toBeUndefined();
    });
});

function createAdmission(storage: 'memory' | 'indexeddb' = 'indexeddb') {
    const backend = storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend({
            dbName: `outbound-replay-${crypto.randomUUID()}`,
            storeName: 'admission',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
    const store = createALOutboundAdmissionStore({
        namespace: 'outbound',
        backend,
        supersedenceTrackTtlMs: 1_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { backend, store };
}
