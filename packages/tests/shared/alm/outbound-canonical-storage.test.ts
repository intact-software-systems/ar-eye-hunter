import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { toALOutboundIdentityKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import {
    EntityStatus,
    isKeysEqual,
    toKeyAsString,
    toResourceEntryWithKey
} from '@shared/queuebox/ResourceEntry.ts';
// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_WORK_STORE_NAME, openIndexedDbAdmissionDatabase } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { readIndexedDbRequest, readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

import '../../setup-browser-indexeddb.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createFlakyOutboundAdmissionStore,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';

describe('canonical outbound payload storage', () => {
    it('retains IndexedDB canonical facts through public QueueBox cleanup and restart', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        vi.setSystemTime(1_000);
        const dbName = `canonical-cleanup-${crypto.randomUUID()}`;
        const backend = new IndexedDbAdmissionBackend({
            dbName: dbName,
            storeName: 'entries',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const store = createALOutboundAdmissionStore({
            namespace: 'canonical-cleanup',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore: store },
            planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ peer: 'captured' }] }),
            sendPreparedMessage: async () => ({ status: 'sent' })
        });
        onTestFinished(() => runtime.dispose());
        const message = createOutboundMessage('public-cleanup', { ttlMs: 1_000 });
        const admitted = await runtime.enqueueIfAbsent(message);
        if (!admitted.entry) {
            throw new Error('Expected canonical admission');
        }
        const restarted = new IndexedDbAdmissionBackend({
            dbName: dbName,
            storeName: 'entries',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const otherStore = createALOutboundAdmissionStore({
            namespace: 'another-session:rtc',
            backend: restarted,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const otherRuntime = createDefaultOutboundTestRuntime({
            stores: { admissionStore: otherStore },
            planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ peer: 'other-session' }] }),
            sendPreparedMessage: async () => ({ status: 'sent' })
        });
        onTestFinished(() => otherRuntime.dispose());
        const otherMessage = createOutboundMessage('other-session-cleanup', { ttlMs: 2_000 });
        await otherRuntime.enqueueIfAbsent(otherMessage);
        const retainedRows = await readRawCanonicalWorkKeys(dbName);
        expect(retainedRows).toHaveLength(6);
        const unrelated = {
            ...toResourceEntryWithKey({ topicId: 'unrelated', resourceId: 'terminal', contextId: 'another-owner' }, 'unrelated', {}),
            status: EntityStatus.COMPLETED
        };
        await restarted.workQueue.enqueue(unrelated);

        await restarted.workQueue.cleanupAsync();

        expect(await readRawCanonicalWorkKeys(dbName)).toEqual(retainedRows);
        expect((await restarted.workQueue.getItem(admitted.entry.key))?.resource).toBe(admitted.entry.resource);
        expect(await restarted.workQueue.getItem(toALOutboundIdentityKey(admitted.entry.key))).toBeDefined();
        expect((await store.readSentMessage(message.id.msgId))?.msg).toEqual(message);
        vi.setSystemTime(2_000);
        const expiryQueue = new IndexedDbAdmissionBackend({
            dbName: dbName,
            storeName: 'entries',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        }).workQueue;
        await expiryQueue.cleanupAsync();
        const afterExpiry = await readRawCanonicalWorkKeys(dbName);
        expect(afterExpiry).toHaveLength(3);
        expect(afterExpiry).not.toContain(toKeyAsString(admitted.entry.key));
        expect(afterExpiry).not.toContain(toKeyAsString(toALOutboundIdentityKey(admitted.entry.key)));
        expect((await otherStore.readSentMessage(otherMessage.id.msgId))?.msg).toEqual(otherMessage);
    });

    it.each(['memory', 'indexeddb'] as const)('stores one payload for several durable recipient actions in %s', async (storage) => {
        const backend = storage === 'memory'
            ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
            : new IndexedDbAdmissionBackend({
                dbName: `canonical-${crypto.randomUUID()}`,
                storeName: 'entries',
                nowMs: Date.now,
                newWriteToken: crypto.randomUUID.bind(crypto),
                observer: createPassThroughIndexedDbOperationObserver()
            });
        const admissionStore = createALOutboundAdmissionStore({
            namespace: 'canonical-test',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const marker = 'canonical-payload-'.repeat(1024);
        const original = createOutboundMessage('shared-route');
        const message = { ...original, payload: { ...original.payload, resource: JSON.stringify({ marker }) } };
        const runtime = createDefaultOutboundTestRuntime({
            queueEngine: new InboxOutboxEngine(),
            stores: { admissionStore },
            planOutgoingMessage: (msg) => ({
                msg,
                persist: true,
                preparedMessages: [{ peer: 'first' }, { peer: 'second' }, { peer: 'third' }]
            }),
            sendPreparedMessage: async () => ({ status: 'not-ready', retryAfterMs: 60_000 })
        });
        onTestFinished(() => runtime.dispose());

        const result = await runtime.enqueueIfAbsent(message);
        expect(result.status).toBe('enqueued');
        const serializedRows = await readStoredRows(backend);
        expect(serializedRows.join('\n').split(marker)).toHaveLength(2);
        expect(serializedRows.filter((row) => row.includes(marker))).toHaveLength(1);
        const retained = await admissionStore.readSentMessage(message.id.msgId);
        expect(JSON.stringify(retained?.msg)).toBe(JSON.stringify(message));
    });
    it('keeps an admitted shorter deadline after payload eviction when the original creation envelope is retried', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        vi.setSystemTime(1_000);
        const store = createALOutboundAdmissionStore({
            namespace: 'expired-admission',
            backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now),
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        let selectedDeadline = 1_010;
        const sends: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore: store },
            planOutgoingMessage: (msg) => ({
                msg: { ...msg, constraints: { ...msg.constraints, expiresAtMs: selectedDeadline } },
                persist: false,
                preparedMessages: [{ peer: 'captured' }]
            }),
            sendPreparedMessage: async () => {
                sends.push('sent');
                return { status: 'sent' };
            }
        });
        const original = createOutboundMessage('shorter-admission', { ttlMs: 1_000 });
        const first = await runtime.enqueueIfAbsent(original);
        expect(first.status).toBe('accepted');
        expect(first.message.constraints?.expiresAtMs).toBe(1_010);
        vi.setSystemTime(1_010);
        selectedDeadline = 1_050;
        const duplicate = await runtime.enqueueIfAbsent(original);
        expect(duplicate.status).toBe('expired');
        expect(sends).toEqual(['sent']);
        expect(await store.workQueue.getItem(first.entry!.key)).toBeUndefined();
    });

    it.each([
        { operation: 'sent-read', crossedAt: 'payload' },
        { operation: 'sent-read', crossedAt: 'identity' },
        { operation: 'claim', crossedAt: 'payload' },
        { operation: 'claim', crossedAt: 'identity' },
        { operation: 'commit', crossedAt: 'identity' }
    ])('treats $operation crossing D during $crossedAt read as expiry', async ({ operation, crossedAt }) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
        });
        vi.setSystemTime(1_000);
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const store = createALOutboundAdmissionStore({
            namespace: 'cross-deadline',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore: createFlakyOutboundAdmissionStore(store, { claimReadyEffects: async () => [] }) },
            planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ peer: 'captured' }] }),
            sendPreparedMessage: async () => {
                throw new Error('Expired work must never send');
            }
        });
        const message = createOutboundMessage('crossing-deadline', { ttlMs: 10 });
        const candidate = operation === 'commit' ? await computeOutboundTestAdmission(store, message) : undefined;
        const admission = await runtime.enqueueIfAbsent(message);
        runtime.dispose();
        const crossedKey = crossedAt === 'payload' ? admission.entry!.key : toALOutboundIdentityKey(admission.entry!.key);
        const getItem = backend.workQueue.getItem.bind(backend.workQueue);
        vi.spyOn(backend.workQueue, 'getItem').mockImplementation(async (key) => {
            if (isKeysEqual(key, crossedKey)) {
                vi.setSystemTime(1_010);
            }
            return await getItem(key);
        });
        if (operation === 'sent-read') {
            expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        }
        else if (operation === 'commit') {
            expect(await store.commitBundle(candidate!, decodeOutboundTestPayload)).toBe('expired');
        }
        else {
            const release = vi.spyOn(backend.workQueue, 'releaseEntries');
            expect(await store.claimReadyEffects({ maxCount: 1 }, decodeOutboundTestPayload)).toEqual([]);
            expect(release).toHaveBeenCalledWith(expect.any(Array), { status: EntityStatus.COMPLETED, delayMs: null });
        }
    });

    it('rejects concurrent different senders reusing the globally addressed message id', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const store = createALOutboundAdmissionStore({
            namespace: 'sender-collision',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const first = createOutboundMessage('same-message-id');
        const second = { ...first, id: { ...first.id, senderId: 'different-sender' } };
        const firstAdmission = await computeOutboundTestAdmission(store, first);
        const secondAdmission = await computeOutboundTestAdmission(store, second);
        expect(await store.commitBundle(firstAdmission, decodeOutboundTestPayload)).toBe('committed');
        await expect(store.commitBundle(secondAdmission, decodeOutboundTestPayload)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect((await store.readSentMessage(first.id.msgId))?.msg.id.senderId).toBe(first.id.senderId);
        expect(await backend.read(`sender-collision:msg-owner:${first.id.msgId}`, (value) => value)).toBe(first.id.senderId);
        expect(await backend.workQueue.getItem(secondAdmission.canonicalEntry!.key)).toBeUndefined();
    });
    it('retains full scope and message identity behind bounded locators and refuses a conflicting observation', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const canonicalScope = 'local/session/' + 'scope-'.repeat(100);
        const admissionStore = createALOutboundAdmissionStore({
            namespace: 'long-identity',
            canonicalScope,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const original = createOutboundMessage('identity');
        const message = {
            ...original,
            id: { ...original.id, senderId: 'sender/'.repeat(30), msgId: 'message/'.repeat(30), sessionId: 'session/'.repeat(30), traceId: 'trace/'.repeat(30) }
        };
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            queueEngine: new InboxOutboxEngine(),
            stores: { admissionStore },
            planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ peer: 'receiver' }] }),
            sendPreparedMessage: async () => {
                sent.push('sent');
                return { status: 'sent' };
            }
        });
        const admitted = await runtime.enqueueIfAbsent(message);
        const rows = await Promise.all((await backend.workQueue.getAllKeys()).map((key) => backend.workQueue.getItem(key)));
        const identity = rows.find((row) => row?.typeId === 'AL_OUTBOUND_IDENTITY');
        expect(identity).toBeDefined();
        if (!identity || !admitted.entry) {
            throw new Error('Expected canonical payload and identity fact');
        }
        for (const row of rows) {
            if (!row) {
                continue;
            }
            expect(row.key.topicId.length).toBeLessThanOrEqual(36);
            expect(row.key.contextId.length).toBeLessThanOrEqual(128);
            expect(row.key.resourceId.length).toBeLessThanOrEqual(128);
        }
        expect(JSON.parse(identity.resource).reference).toMatchObject({
            scope: canonicalScope,
            identity: JSON.stringify([
                message.id.v,
                message.id.senderId,
                message.id.msgId,
                message.id.ts,
                message.id.sessionId,
                message.id.traceId
            ])
        });
        expect(identity.audit.expiryTs.epochMilliseconds).toBe(message.constraints?.expiresAtMs);
        const conflict = {
            ...identity,
            resource: JSON.stringify({
                ...JSON.parse(identity.resource),
                reference: { ...JSON.parse(identity.resource).reference, scope: 'another-local-session' }
            })
        };
        await backend.workQueue.setItem(conflict.key, conflict, { expireAtTimestamp: Number(conflict.audit.expiryTs.epochMilliseconds) });
        await expect(runtime.enqueueIfAbsent(message)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect((await backend.workQueue.getItem(identity.key))?.resource).toBe(conflict.resource);
        expect((await backend.workQueue.getItem(admitted.entry.key))?.resource).toBe(admitted.entry.resource);
        expect(rows.filter((row) => row?.status === EntityStatus.COMPLETED).length).toBeGreaterThan(0);
        expect(sent).toEqual(['sent']);
    });
    it('reuses equal canonical content across carriers while isolating sessions and rejecting identity conflicts', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const message = createOutboundMessage('cross-carrier');
        const makeRuntime = (namespace: string, canonicalScope: string) => {
            const admissionStore = createALOutboundAdmissionStore({
                namespace,
                canonicalScope,
                backend,
                supersedenceTrackTtlMs: 60_000,
                retention: normalizeALRuntimeStoreRetention()
            });
            const runtime = createDefaultOutboundTestRuntime({
                queueEngine: new InboxOutboxEngine(),
                stores: { admissionStore },
                planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ peer: namespace }] }),
                sendPreparedMessage: async () => ({ status: 'not-ready', retryAfterMs: 60_000 })
            });
            onTestFinished(() => runtime.dispose());
            return runtime;
        };
        const rtc = makeRuntime('session-a:rtc', 'session-a');
        const ws = makeRuntime('session-a:ws', 'session-a');
        const otherSession = makeRuntime('session-b:ws', 'session-b');
        const first = await rtc.enqueueIfAbsent(message);
        const fallback = await ws.enqueueIfAbsent(message);
        expect(fallback.entry?.key).toEqual(first.entry?.key);
        const isolated = await otherSession.enqueueIfAbsent(message);
        expect(isolated.entry?.key).not.toEqual(first.entry?.key);
        const conflicting = { ...message, payload: { ...message.payload, resource: JSON.stringify({ value: 'different authority content' }) } };
        await expect(ws.enqueueIfAbsent(conflicting)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });
});

async function readStoredRows(backend: ALAdmissionWorkBackend): Promise<readonly string[]> {
    const state = await backend.list('canonical-test:', (value) => JSON.stringify(value));
    const queue = await Promise.all((await backend.workQueue.getAllKeys()).map(async (key) => {
        const entry = await backend.workQueue.getItem(key);
        return entry?.resource ?? '';
    }));
    return [...state.map((entry) => entry.value), ...queue];
}

async function readRawCanonicalWorkKeys(dbName: string): Promise<readonly string[]> {
    const db = await openIndexedDbAdmissionDatabase(dbName, 'entries');
    try {
        const transaction = db.transaction(AL_ADMISSION_WORK_STORE_NAME, 'readonly');
        const keys = await readIndexedDbTransaction(
            transaction,
            () => readIndexedDbRequest(transaction.objectStore(AL_ADMISSION_WORK_STORE_NAME).getAllKeys())
        );
        return keys.map(String);
    }
    finally {
        db.close();
    }
}
