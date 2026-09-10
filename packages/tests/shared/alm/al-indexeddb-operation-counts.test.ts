import 'fake-indexeddb/auto';
import { Temporal } from '@js-temporal/polyfill';
import { decodeALAdmissionString } from '@shared/alm/al-admission-value-validation.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    AL_OUTBOUND_WORK_PAGE_SIZE,
    readALOutboundWorkReadyAt,
    type ALOutboundDequeueDeferral
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import type { IndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { toResourceEntryWithKey, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const NOW_MS = 1_700_000_000_000;
const WORK_TYPES = ['AL_OUTBOUND:counts', 'WS_OUTBOX'] as const;
const NO_DEFERRAL: ALOutboundDequeueDeferral = { types: new Set<string>(), readyAtMs: undefined };

describe('AL-owned IndexedDB operation counts', () => {
    it('counts admission reads, writes, and work operations through the backend', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const backend = new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `al-counts-${crypto.randomUUID()}`,
            storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
            nowMs: () => 1_000,
            newWriteToken: () => crypto.randomUUID(),
            observer
        });
        await backend.ready();

        await backend.read('missing', decodeALAdmissionString);
        await backend.write(async (tx) => {
            await tx.set('present', 'value');
        });
        await backend.workQueue.readWorkPage({
            typeId: 'AL_OUTBOUND:test',
            status: 'NEW',
            maxToRead: 4,
            cursor: null
        });

        const counts = observer.getCounts();
        expect(counts.byOwner['al-admission']).toBe(2);
        expect(counts.byKind.read).toBe(1);
        expect(counts.byKind.write).toBe(1);
        expect(counts.byKind['work-page']).toBe(1);
        expect(counts.byOwner['al-work']).toBe(1);
    });
});

describe('outbound work owner IndexedDB scan volume', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('spends one work-page operation, in one readonly transaction, on one readiness probe', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const port = createOutboundWorkPort(observer);
        await port.retainIfAbsent(newOutboundWorkEntry(WORK_TYPES[0], 'due-now'));
        const opened = countReadonlyTransactions();
        const before = observer.getCounts().byKind['work-page'] ?? 0;

        const readyAtMs = await readALOutboundWorkReadyAt(port, NOW_MS, NO_DEFERRAL);

        expect(readyAtMs).toBe(NOW_MS);
        expect((observer.getCounts().byKind['work-page'] ?? 0) - before).toBe(1);
        expect(opened.count()).toBe(1);
    });

    it('answers from every scanned status and every work type, exactly as the status-by-status scan did', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const port = createOutboundWorkPort(observer);

        expect(await readALOutboundWorkReadyAt(port, NOW_MS, NO_DEFERRAL)).toBeUndefined();

        // Only the second work type holds a row: a probe that stopped at the first type would miss it.
        await port.retainIfAbsent(newOutboundWorkEntry(WORK_TYPES[1], 'second-type'));
        expect(await readALOutboundWorkReadyAt(port, NOW_MS, NO_DEFERRAL)).toBe(NOW_MS);
        expect(await readALOutboundWorkReadyAt(port, NOW_MS, { types: new Set(WORK_TYPES), readyAtMs: NOW_MS + 60_000 }))
            .toBe(NOW_MS + 60_000);

        // Claiming moves the row to RESERVED, which the scan still reads: it now answers at the lease end.
        expect(await port.claim({ maxCount: AL_OUTBOUND_WORK_PAGE_SIZE, observedEntries: undefined })).toHaveLength(1);
        expect(await readALOutboundWorkReadyAt(port, NOW_MS, NO_DEFERRAL)).toBe(NOW_MS + AL_OUTBOUND_WORK_LEASE_MS);
    });

    it('costs four work-page operations over ten idle seconds of engine passes', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const port = createOutboundWorkPort(observer);
        let nowMs = NOW_MS;
        const engine = new InboxOutboxEngine();
        const handler = new ALWorkHandler({
            workerId: 'al-outbound:counts',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: (probed) => readALOutboundWorkReadyAt(probed, nowMs, NO_DEFERRAL),
            selectReady: async (claimed, size) => ({
                claims: await claimed.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();
        const before = observer.getCounts().byKind['work-page'] ?? 0;

        // A hundred engine passes at the engine's fixed 100 ms delay: ten idle seconds of an owner
        // with nothing to do, which is the shape the hosted runner spent 61 % of its storage on.
        for (let pass = 0; pass < 100; pass += 1) {
            await engine.executeOnce();
            nowMs += 100;
        }

        expect((observer.getCounts().byKind['work-page'] ?? 0) - before).toBe(4);
        handler.dispose();
    });
});

function createOutboundWorkPort(observer: IndexedDbOperationObserver): ALWorkQueuePort {
    return createALWorkQueuePort({
        queue: new IndexedDbQueueBox({
            dbName: `al-work-counts-${crypto.randomUUID()}`,
            storeName: IndexedDbQueueBox.DEFAULT_STORE_NAME,
            observer,
            now: () => Temporal.Instant.fromEpochMilliseconds(NOW_MS)
        }),
        workTypes: new Set(WORK_TYPES),
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        nowMs: () => NOW_MS,
        random: () => 0.5
    });
}

/** A retained row whose readiness the frozen clock owns, so a probe's answer is a fixed timestamp. */
function newOutboundWorkEntry(typeId: string, effectId: string): ResourceEntry {
    const entry = toResourceEntryWithKey(
        { topicId: 'AL_OUTBOUND', resourceId: 'ns', contextId: effectId },
        typeId,
        { effectId },
        Temporal.Instant.fromEpochMilliseconds(NOW_MS + 600_000)
    );
    const createdAt = Temporal.Instant.fromEpochMilliseconds(NOW_MS).toZonedDateTimeISO('UTC');
    return {
        ...entry,
        audit: { ...entry.audit, createdTs: createdAt.toPlainDateTime(), date: createdAt.toPlainTime() },
        dequeueAudit: { ...entry.dequeueAudit, nextTs: Temporal.Instant.fromEpochMilliseconds(NOW_MS) }
    };
}

/** Counts the readonly transactions one probe opens; one per probe is the contract. */
function countReadonlyTransactions(): { count(): number; } {
    let opened = 0;
    const openTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
    ) {
        if (mode === undefined || mode === 'readonly') {
            opened += 1;
        }
        return openTransaction.call(this, storeNames, mode, options);
    });
    return { count: () => opened };
}
