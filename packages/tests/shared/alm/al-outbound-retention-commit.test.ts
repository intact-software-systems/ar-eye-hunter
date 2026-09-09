import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_REVISION_KEY, openIndexedDbAdmissionDatabase } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { captureALOutboundPolicy } from '@shared/alm/outbound/al-outbound-admission-validation.ts';
import { captureALOutboundCreationExpiry, toALOutboundMessageReference } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { readIndexedDbRequest } from '@shared/persistence/indexed-db-request.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import '../../setup-browser-indexeddb.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import {
    computeOutboundTestAdmission,
    createOutboundCanonicalEntry,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

afterEach(() => vi.restoreAllMocks());

it.each(['get', 'put'] as const)('does not admit or retain outbound ownership across native %s expiry', async (method) => {
    for (const pending of [false, true]) {
        for (const offset of [-1, 0, 1]) {
            let nowMs = 1_800_000_000_000;
            vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
            const dbName = `outbound-write-deadline-${crypto.randomUUID()}`;
            const backend = new IndexedDbAdmissionBackend({
                dbName: dbName,
                storeName: 'entries',
                nowMs: () => nowMs,
                newWriteToken: crypto.randomUUID.bind(crypto),
                observer: createPassThroughIndexedDbOperationObserver()
            });
            const store = createALOutboundAdmissionStore({
                nowMs: Date.now,
                canonicalScope: 'outbound',
                decodePrepared: decodeOutboundTestPayload,
                namespace: 'outbound',
                backend,
                supersedenceTrackTtlMs: 60_000,
                retention: normalizeALRuntimeStoreRetention()
            });
            const input = pendingInput(store);
            const message = createOutboundMessage('initial', { ttlMs: 1_000 });
            const bundle = await computeOutboundTestAdmission(store, message);
            const deadline = message.constraints!.expiresAtMs!;
            const original = IDBObjectStore.prototype[method];
            let crossed = false;
            const spy = vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, value: IDBValidKey | IDBKeyRange) {
                const request = original.call(this, value);
                if (this.transaction.mode === 'readwrite' && this.name === (pending ? 'alm-work' : 'entries')) {
                    request.addEventListener('success', () => {
                        nowMs = deadline + offset;
                        crossed = true;
                    });
                }
                return request;
            });
            const result = pending
                ? await store.retainPendingAdmission(input)
                : await store.commitBundle(bundle);
            expect(result).toBe(offset < 0 ? (pending ? 'pending' : 'committed') : 'expired');
            expect(crossed).toBe(true);
            spy.mockRestore();
            const db = await openIndexedDbAdmissionDatabase(dbName, 'entries');
            try {
                const transaction = db.transaction(['entries', 'alm-work'], 'readonly');
                const [metadata, work] = await Promise.all([
                    readIndexedDbRequest(transaction.objectStore('entries').getAll()),
                    readIndexedDbRequest(transaction.objectStore('alm-work').getAll())
                ]);
                expect(metadata.filter((row) => row.key !== AL_ADMISSION_REVISION_KEY).length > 0).toBe(offset < 0 && !pending);
                expect(work.length > 0).toBe(offset < 0);
            }
            finally {
                db.close();
                vi.restoreAllMocks();
            }
        }
    }
});

it.each([EntityStatus.COMPLETED, EntityStatus.NON_RETRYABLE])('does not call a terminal %s descriptor pending or reactivate it', async (status) => {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    const store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'terminal',
        decodePrepared: decodeOutboundTestPayload,
        namespace: 'terminal',
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const input = pendingInput(store);
    expect(await store.retainPendingAdmission(input)).toBe('pending');
    const rows = await Promise.all((await backend.workQueue.getAllKeys()).map((key) => backend.workQueue.getItem(key)));
    const pending = rows.find((row) => row?.resource.includes('"kind":"admit-message"'))!;
    await backend.workQueue.enqueue({ ...pending, status });
    expect(await store.retainPendingAdmission(input)).toBe('conflict');
    expect((await backend.workQueue.getItem(pending.key))?.status).toBe(status);
    expect(await store.readSentMessage(input.payload.message.msgId)).toBeUndefined();
});

function pendingInput(store: ALOutboundAdmissionStore<OutboundTestPayload>) {
    const message = createOutboundMessage('pending', { ttlMs: 1_000 });
    const canonicalEntry = createOutboundCanonicalEntry(store, message);
    return {
        canonicalEntry,
        creationExpiry: captureALOutboundCreationExpiry(message),
        decodePrepared: decodeOutboundTestPayload,
        payload: {
            kind: 'admit-message' as const,
            message: toALOutboundMessageReference(store.canonicalScope, canonicalEntry, message),
            policy: captureALOutboundPolicy({ msg: message, persist: false, preparedMessages: [{ peer: 'captured' }] }),
            preparedMessages: [{ peer: 'captured' }]
        }
    };
}

it.each([EntityStatus.RETRY, EntityStatus.COMPLETED, EntityStatus.NON_RETRYABLE])(
    'verifies raced %s ownership after the real queue observation conflicts',
    async (status) => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'raced-terminal',
            decodePrepared: decodeOutboundTestPayload,
            namespace: 'raced-terminal',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const input = pendingInput(store);
        expect(await store.retainPendingAdmission(input)).toBe('pending');
        const rows = await Promise.all((await backend.workQueue.getAllKeys()).map((key) => backend.workQueue.getItem(key)));
        const pending = rows.find((row) => row?.resource.includes('"kind":"admit-message"'))!;
        const write = backend.write.bind(backend);
        vi.spyOn(backend, 'write').mockImplementation((operation, deadline) =>
            write(async (tx) => {
                const result = await operation(tx);
                await backend.workQueue.enqueue({ ...pending, status });
                return result;
            }, deadline)
        );
        expect(await store.retainPendingAdmission(input)).toBe(status === EntityStatus.RETRY ? 'pending' : 'conflict');
        expect((await backend.workQueue.getItem(pending.key))?.status).toBe(status);
        expect(await store.readSentMessage(input.payload.message.msgId)).toBeUndefined();
    }
);
