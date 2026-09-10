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
import {
    AL_ADMISSION_SCHEMA_ID,
    AL_ADMISSION_WORK_STORE_NAME,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundWorkKey, toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { IndexedDbConnection } from '@shared/persistence/open-indexed-db.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import '../../setup-browser-indexeddb.ts';
import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    peekOutboundWorkReadyAt
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound IndexedDB durable queue replay', () => {
    it.each(['memory', 'indexeddb'] as const)('retains malformed work as non-retryable and releases unrelated work in %s', async (storage) => {
        const { admissionStore, stores, backend, port, peek } = createAdmission(storage);
        await admissionStore.commitBundle({
            senderId: 'self',
            mutations: [],
            durableEffects: ['malformed', 'valid'].map((msgId) => ({
                effectId: msgId,
                payload: { kind: 'ack-timeout', msgId }
            }))
        });
        const malformedKey = toALOutboundWorkKey('outbound', 'malformed');
        const original = await backend.workQueue.getItem(malformedKey);
        if (original === undefined) {
            throw new Error('Expected persisted malformed-work fixture');
        }
        await backend.workQueue.setItem(malformedKey, { ...original, resource: '{invalid-json' }, {
            expireAtTimestamp: Number(original.audit.expiryTs.epochMilliseconds)
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: (msg) => ({ msg, persist: false, preparedMessages: [] }),
            sendPreparedMessage: async () => ({ status: 'sent' })
        });

        await runtime.ready();

        // The corrupt row cannot name the work it owes, so the attempt rejects it instead of retrying.
        expect(await backend.workQueue.getItem(malformedKey)).toMatchObject({
            resource: '{invalid-json',
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 1, nextTs: undefined }
        });
        expect(await backend.workQueue.getItem(toALOutboundWorkKey('outbound', 'valid')))
            .toMatchObject({ status: EntityStatus.COMPLETED });
        expect(await peek()).toBeUndefined();
        expect(await port.claim({ maxCount: 3, observedEntries: undefined })).toEqual([]);
    });

    it.each(['memory', 'indexeddb'] as const)('skips a complete audience after restart while replaying an incomplete audience in %s', async (storage) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { admissionStore, stores } = createAdmission(storage);
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
            stores,
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
            // The send holds its claim (it never settles), so the acknowledgements below race nothing.
            await runtime1.drainWork();
            const respondents = msg.route.resourceId === 'complete' ? ['peer-1', 'peer-2'] : ['peer-1'];
            for (const fromPeerId of respondents) {
                await runtime1.acceptControlMessage(newALAckControlMessage(
                    { v: 2, msgId: crypto.randomUUID(), ts: Date.now(), senderId: fromPeerId },
                    { ackedMsgId: msg.id.msgId, fromPeerId, toPeerId: 'self', status: 'accepted', observedAtEpochMs: Date.now() }
                ));
                await runtime1.drainWork();
            }
        }
        runtime1.dispose();
        vi.setSystemTime(Date.now() + 10_001);

        const sent: string[] = [];
        const runtime2 = createDefaultOutboundTestRuntime({
            queueEngine: new InboxOutboxEngine(),
            stores,
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
        expect(await admissionStore.readPendingAck(messages[0].id.msgId)).toBeUndefined();
        expect(await admissionStore.readReceiptState(messages[0].id.msgId)).toMatchObject({
            expectedPeerIds: ['peer-1', 'peer-2'],
            ackedPeerIds: ['peer-1', 'peer-2']
        });
        expect(await admissionStore.readPendingAck(messages[1].id.msgId)).toMatchObject({
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
        await vi.advanceTimersByTimeAsync(0);
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
        const backend = new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: dbName,
            storeName: 'admission',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const admissionStore = createALOutboundAdmissionStore({
            canonicalScope: 'outbound',
            decodePrepared: decodeOutboundTestPayload,
            namespace: 'outbound',
            backend,
            supersedenceTrackTtlMs: 1_000,
            nowMs: Date.now,
            retention: normalizeALRuntimeStoreRetention()
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore, workQueue: backend.workQueue },
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [{ text: 'retained' }] }),
            sendPreparedMessage: async () => ({ status: 'queued', settled: new Promise(() => {}) })
        });
        const msg = createOutboundMessage('queue-owned-send');
        expect((await runtime.enqueueIfAbsent(msg)).status).toBe('accepted');
        const database = await openIndexedDbAdmissionDatabase({
            dbName: dbName,
            storeName: 'admission',
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        onTestFinished(() => database.close());
        const queue = new IndexedDbQueueBox({
            connection: new IndexedDbConnection(async () => database),
            storeName: AL_ADMISSION_WORK_STORE_NAME,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const keys = await queue.getAllKeys();
        expect(keys).toHaveLength(3);
        const workKey = keys.find((key) => key.topicId === 'AL_OUTBOUND')!;
        await expect.poll(async () => (await queue.getItem(workKey))?.status).toBe(EntityStatus.RESERVED);
        const reserved = await queue.getItem(workKey);
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
        const { admissionStore, port, peek } = createAdmission(storage);
        const msg = createOutboundMessage('lease-fence');
        const nowMs = Date.now();
        await admissionStore.commitBundle({
            senderId: msg.id.senderId,
            mutations: [],
            durableEffects: [{ effectId: 'lease-fence', retryAtMs: nowMs, payload: { kind: 'ack-timeout', msgId: msg.id.msgId } }]
        });
        const [oldClaim] = await claimOne(port);
        vi.setSystemTime(nowMs + 10_001);
        const [newClaim] = await claimOne(port);

        const leaseAt = await peek();
        expect(leaseAt).toBeGreaterThanOrEqual(newClaim!.leaseUntilMs);

        await port.release(oldClaim!, { status: 'completed' });
        expect(await peek()).toBe(leaseAt);
        await port.release(oldClaim!, { status: 'not-ready', readyAtMs: nowMs + 50_000 });
        expect(await peek()).toBe(leaseAt);
        await port.release(newClaim!, { status: 'completed' });
        expect(await peek()).toBeUndefined();
    });

    it('keeps canonical and action Temporal values across persistence, lease, reschedule and runtime restart', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { admissionStore, stores, backend, port, peek } = createAdmission();
        const msg = createOutboundMessage('queued');
        const runtime1 = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: (message) => ({ msg: message, persist: true, preparedMessages: [{ text: 'captured-recipient' }] }),
            // A send that never settles keeps its claim, so the row survives the runtime as a reservation.
            sendPreparedMessage: async () => ({ status: 'queued', settled: new Promise(() => {}) })
        });
        const enqueued = await runtime1.enqueueIfAbsent(msg);
        const workKey = await readOutboundWorkKey(backend.workQueue);
        await expect.poll(async () => (await backend.workQueue.getItem(workKey))?.status)
            .toBe(EntityStatus.RESERVED);
        runtime1.dispose();
        vi.setSystemTime(Date.now() + 10_001);
        const [claimed] = await claimOne(port);
        const work = await admissionStore.readWorkSnapshot(claimed!.entry);
        expect(work.payload.kind).toBe('send-prepared');
        expect(work.canonicalMessage).toEqual(msg);
        expect(claimed!.entry.audit.date).toBeInstanceOf(Temporal.PlainTime);
        expect(claimed!.entry.audit.createdTs).toBeInstanceOf(Temporal.PlainDateTime);
        expect(claimed!.entry.audit.expiryTs).toBeInstanceOf(Temporal.Instant);
        expect(claimed!.entry.dequeueAudit.startTs).toBeInstanceOf(Temporal.Instant);
        await port.release(claimed!, { status: 'not-ready', readyAtMs: Date.now() });
        const retryAt = await peek();
        expect(retryAt).toBeDefined();
        vi.setSystemTime(retryAt!);
        const sent: string[] = [];
        const runtime2 = createDefaultOutboundTestRuntime({
            stores,
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
        expect(await peek()).toBeUndefined();
    });

    it.each(['memory', 'indexeddb'] as const)('finishes exhausted QueueBox work without advertising another retry in %s', async (storage) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { admissionStore, backend, port, peek } = createAdmission(storage);
        await admissionStore.commitBundle({
            senderId: 'self',
            mutations: [],
            durableEffects: [{ effectId: 'exhausted', payload: { kind: 'ack-timeout', msgId: 'exhausted' } }]
        });

        for (let attempt = 1; attempt <= DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts; attempt += 1) {
            const [claimed] = await claimOne(port);
            expect(claimed!.attempts).toBe(attempt);
            await port.release(claimed!, { status: 'retry' });
            vi.setSystemTime(await readNextRetryAtMs(backend.workQueue, claimed!) ?? Date.now() + 1);
        }

        const [key] = await backend.workQueue.getAllKeys();
        expect(await backend.workQueue.getItem(key)).toMatchObject({
            status: EntityStatus.FAILED,
            dequeueAudit: { attempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts }
        });
        expect(await port.claim({ maxCount: 1, observedEntries: undefined })).toEqual([]);
        expect(await peek()).toBeUndefined();
    });

    it.each(['memory', 'indexeddb'] as const)('finalizes the last crashed attempt without sending again in %s', async (storage) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { admissionStore, backend, port, peek } = createAdmission(storage);
        const attemptLimit = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts;
        await admissionStore.commitBundle({
            senderId: 'self',
            mutations: [],
            durableEffects: [{ effectId: 'crashed-last-attempt', payload: { kind: 'ack-timeout', msgId: 'crashed-last-attempt' } }]
        });
        for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
            const [claimed] = await claimOne(port);
            expect(claimed!.attempts).toBe(attempt);
            if (attempt < attemptLimit) {
                await port.release(claimed!, { status: 'retry' });
                vi.setSystemTime(await readNextRetryAtMs(backend.workQueue, claimed!) ?? Date.now() + 1);
            }
        }
        vi.setSystemTime(Date.now() + 10_001);

        // The last attempt died holding its reservation: only exhaustion finalization can end it.
        expect(await port.claim({ maxCount: 1, observedEntries: undefined })).toEqual([]);
        const [finalized] = await port.finalizeExhausted(1);
        await port.release(finalized!, { status: 'non-retryable' });
        const [key] = await backend.workQueue.getAllKeys();
        expect(await backend.workQueue.getItem(key)).toMatchObject({ status: EntityStatus.NON_RETRYABLE });
        expect(await peek()).toBeUndefined();
    });

    it('rejects a changed canonical deadline after an IndexedDB restart without resetting the action', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const { backend, stores, peek } = createAdmission();
        const message = createOutboundMessage('changed-canonical-deadline');
        const runtime1 = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ text: 'captured' }] }),
            sendPreparedMessage: async () => ({ status: 'queued', settled: new Promise(() => {}) })
        });
        const admitted = await runtime1.enqueueIfAbsent(message);
        const workKey = await readOutboundWorkKey(backend.workQueue);
        await expect.poll(async () => (await backend.workQueue.getItem(workKey))?.status)
            .toBe(EntityStatus.RESERVED);
        runtime1.dispose();
        vi.setSystemTime(Date.now() + 10_001);
        const canonical = await backend.workQueue.getItem(admitted.entry!.key);
        const corrupted = {
            ...canonical!,
            resource: JSON.stringify({ ...message, constraints: { ...message.constraints, expiresAtMs: message.constraints!.expiresAtMs! + 1 } })
        };
        await backend.workQueue.setItem(corrupted.key, corrupted, { expireAtTimestamp: Number(corrupted.audit.expiryTs.epochMilliseconds) });

        const sent: string[] = [];
        const runtime2 = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ text: 'replanned' }] }),
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared.text ?? '');
                return { status: 'sent' };
            }
        });
        await runtime2.ready();
        await expect.poll(async () => (await backend.workQueue.getItem(workKey))?.status)
            .toBe(EntityStatus.NON_RETRYABLE);

        expect(sent).toEqual([]);
        expect((await backend.workQueue.getItem(corrupted.key))?.resource).toBe(corrupted.resource);
        expect(await peek()).toBeUndefined();
    });
});

async function claimOne(port: ALWorkQueuePort): Promise<readonly ALWorkClaim[]> {
    return await port.claim({ maxCount: 1, observedEntries: undefined });
}

async function readNextRetryAtMs(
    workQueue: ALOutboundRuntimeStores<OutboundTestPayload>['workQueue'],
    claim: ALWorkClaim
): Promise<number | undefined> {
    const entry = await workQueue.getItem(claim.entry.key);
    const nextTs = entry?.dequeueAudit.nextTs?.epochMilliseconds;
    return nextTs === undefined ? undefined : Number(nextTs) + 1;
}

/** The single outbound work row an admitted message committed. */
async function readOutboundWorkKey(
    workQueue: ALOutboundRuntimeStores<OutboundTestPayload>['workQueue']
): Promise<Key> {
    const key = (await workQueue.getAllKeys()).find((candidate) => candidate.topicId === 'AL_OUTBOUND');
    if (key === undefined) {
        throw new Error('Expected the admission to commit outbound work');
    }
    return key;
}

function createAdmission(storage: 'memory' | 'indexeddb' = 'indexeddb') {
    const backend = storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `outbound-replay-${crypto.randomUUID()}`,
            storeName: 'admission',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
    const admissionStore = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'outbound',
        decodePrepared: decodeOutboundTestPayload,
        namespace: 'outbound',
        backend,
        supersedenceTrackTtlMs: 1_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const stores = { admissionStore, workQueue: backend.workQueue };
    return {
        backend,
        stores,
        admissionStore,
        port: createTestALOutboundWorkPort({ ...stores, nowMs: Date.now }),
        peek: async () => await peekOutboundWorkReadyAt(backend.workQueue, admissionStore.namespace)
    };
}
