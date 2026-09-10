import { Temporal } from '@js-temporal/polyfill';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_ADMISSION_WORK_COMPLETED_RETENTION } from '@shared/alm/al-admission-work-backend.ts';
import { toALInboundPendingAdmissionId } from '@shared/alm/inbound/al-inbound-pending-admission.ts';
import { computeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import {
    decodeALOutboundTransportMessage,
    toALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
// @vitest-environment happy-dom

import '../../setup-browser-indexeddb.ts';

import {
    deleteBrowserALRuntimeEntriesForSession,
    deleteExpiredBrowserALRuntimeEntries,
    deleteExpiredBrowserALRuntimeEntriesForSession,
    initBrowserALRuntimeExpiryEviction
} from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { BROWSER_AL_RUNTIME_DB_NAME, BROWSER_AL_RUNTIME_STORE_NAME } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    resolveBrowserWsClientALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { readBrowserALWorkCleanupRows } from '@shared-web/browser/al-runtime/browser-al-work-cleanup.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    AL_ADMISSION_WORK_STORE_NAME,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { decodeALOutboundIdentityFact, toALOutboundIdentityKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { readIndexedDbRequest, readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import { IndexedDbConnection } from '@shared/persistence/open-indexed-db.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { toKeyAsString, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createOutboundMessage, createOutboundTestRuntimeFor } from '../../shared/alm/outbound-runtime-test-fixture.ts';

interface RawWorkRow {
    readonly keyString: string;
    readonly resource: string;
    readonly typeId: string;
}

const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);

describe('browser canonical outbound cleanup', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('evicts expired and session-owned pending admission from the actual shared work store', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2031-08-01T00:00:00Z'));
        const targetSession = `pending-target-${crypto.randomUUID()}`;
        const expired = await retainPendingForSession(`pending-expired-${crypto.randomUUID()}`, 10);
        const target = await retainPendingForSession(targetSession, 60_000);
        const other = await retainPendingForSession(`pending-other-${crypto.randomUUID()}`, 60_000);
        const unrelated = toResourceEntryWithKey({ topicId: 'unrelated', contextId: 'test', resourceId: crypto.randomUUID() }, 'unrelated', {});
        await other.queue.enqueueIfAbsent(unrelated);
        vi.setSystemTime(Date.now() + 11);
        await deleteExpiredBrowserALRuntimeEntries();
        let rows = await readRawWorkRows();
        expect(rows.some((row) => row.resource === expired.resource)).toBe(false);
        expect(rows.some((row) => row.resource === target.resource)).toBe(true);
        expect(rows.some((row) => row.resource === other.resource)).toBe(true);
        await deleteBrowserALRuntimeEntriesForSession(targetSession);
        rows = await readRawWorkRows();
        expect(rows.some((row) => row.resource === target.resource)).toBe(false);
        expect(rows.some((row) => row.resource === other.resource)).toBe(true);
        expect(rows.some((row) => row.keyString.includes(unrelated.key.resourceId))).toBe(true);
    });

    it('evicts expired canonical payload, identity and action rows through the owned cleanup', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));
        const expired = await admitForSession(`expired-${crypto.randomUUID()}`, 10);
        const fresh = await admitForSession(`fresh-${crypto.randomUUID()}`, 60_000);
        const unrelated = toResourceEntryWithKey({ topicId: 'unrelated', contextId: 'test', resourceId: crypto.randomUUID() }, 'unrelated', {});
        await fresh.store.workQueue.enqueueIfAbsent(unrelated);
        await vi.advanceTimersByTimeAsync(11);

        await deleteExpiredBrowserALRuntimeEntries();
        const remaining = await readRawWorkRows();

        expect(remaining.filter((row) => expired.keys.has(row.keyString))).toEqual([]);
        expect(remaining.filter((row) => fresh.keys.has(row.keyString))).toHaveLength(fresh.keys.size);
        expect(remaining.some((row) => row.keyString.includes(unrelated.key.resourceId))).toBe(true);
        await deleteExpiredBrowserALRuntimeEntries();
        expect(await readRawWorkRows()).toEqual(remaining);
    });

    it('evicts an expired canonical payload after a getter has already evicted its identity fact', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));
        const expired = await admitForSession(`orphan-${crypto.randomUUID()}`, 10);
        const identity = (await readRawWorkRows()).find((row) => expired.keys.has(row.keyString) && row.typeId === 'AL_OUTBOUND_IDENTITY')!;
        const reference = decodeALOutboundIdentityFact(JSON.parse(identity.resource)).reference;
        await vi.advanceTimersByTimeAsync(11);
        expect(await expired.store.workQueue.getItem(toALOutboundIdentityKey(reference.key))).toBeUndefined();
        expect((await readRawWorkRows()).filter((row) => expired.keys.has(row.keyString))).toHaveLength(2);

        await deleteExpiredBrowserALRuntimeEntries();

        expect((await readRawWorkRows()).filter((row) => expired.keys.has(row.keyString))).toEqual([]);
    });

    it('excludes a namespace whose resource id is only a string prefix of the owned one', async () => {
        const db = await openIndexedDbAdmissionDatabase({
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            storeName: BROWSER_AL_RUNTIME_STORE_NAME,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        try {
            const ownerNamespace = `rngown${Math.random().toString(36).slice(2, 8)}`;
            const impostorNamespace = `${ownerNamespace}99`;
            const ownerKey = await retainPendingUnderNamespace(db, ownerNamespace, 'x');
            const impostorKey = await retainPendingUnderNamespace(db, impostorNamespace, 'y');

            const rows = await readBrowserALWorkCleanupRows(db, {
                namespacePrefixes: [ownerNamespace],
                canonicalScopes: []
            });

            const foundKeys = new Set(rows.map((row) => row.keyString));
            expect(foundKeys.has(ownerKey)).toBe(true);
            expect(foundKeys.has(impostorKey)).toBe(false);
        }
        finally {
            db.close();
        }
    });

    it('sweeps another session\'s expired AL work rows too, because AL work-row expiry is store-wide', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2033-08-01T00:00:00Z'));
        const targetSession = `expiry-scope-target-${crypto.randomUUID()}`;
        const otherExpiredSession = `expiry-scope-other-expired-${crypto.randomUUID()}`;
        const otherLiveSession = `expiry-scope-other-live-${crypto.randomUUID()}`;
        const otherExpired = await admitForSession(otherExpiredSession, 10);
        await vi.advanceTimersByTimeAsync(11);
        const otherLive = await admitForSession(otherLiveSession, 60_000);

        await deleteExpiredBrowserALRuntimeEntriesForSession(targetSession);

        const remaining = await readRawWorkRows();
        expect(remaining.filter((row) => otherExpired.keys.has(row.keyString))).toEqual([]);
        expect(remaining.filter((row) => otherLive.keys.has(row.keyString))).toHaveLength(otherLive.keys.size);
    });

    // Everything below this point runs after `initBrowserALRuntimeExpiryEviction` has started a
    // real, never-cancelled background sweep (see that test): a later test calling the 'expired'
    // policy can race it for a write conflict. Keep 'expired'-policy assertions above this line.
    it('runs repeated timer eviction against the shared outbound work store', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(new Date('2030-08-01T00:00:00Z'));
        const first = await admitForSession(`timer-first-${crypto.randomUUID()}`, 20);
        await initBrowserALRuntimeExpiryEviction(10);
        await vi.advanceTimersByTimeAsync(25);
        await vi.waitFor(async () => expect((await readRawWorkRows()).filter((row) => first.keys.has(row.keyString))).toEqual([]));
        const second = await admitForSession(`timer-second-${crypto.randomUUID()}`, 20);
        await vi.advanceTimersByTimeAsync(25);
        await vi.waitFor(async () => expect((await readRawWorkRows()).filter((row) => second.keys.has(row.keyString))).toEqual([]));
    });

    it('removes one session canonical and action rows while keeping another session and unrelated work', async () => {
        const targetSession = `target-${crypto.randomUUID()}`;
        const target = await admitForSession(targetSession, 60_000);
        const other = await admitForSession(`other-${crypto.randomUUID()}`, 60_000);
        const unrelated = toResourceEntryWithKey({ topicId: 'unrelated', contextId: 'test', resourceId: crypto.randomUUID() }, 'unrelated', {});
        await other.store.workQueue.enqueueIfAbsent(unrelated);

        await deleteBrowserALRuntimeEntriesForSession(targetSession);
        const remaining = await readRawWorkRows();

        expect(remaining.filter((row) => target.keys.has(row.keyString))).toEqual([]);
        expect(remaining.filter((row) => other.keys.has(row.keyString))).toHaveLength(other.keys.size);
        expect(remaining.some((row) => row.keyString.includes(unrelated.key.resourceId))).toBe(true);
    });

    it('deletes one session\'s AL work rows through bounded per-owner cursor ranges', async () => {
        const targetSession = `ranged-target-${crypto.randomUUID()}`;
        const otherSession = `ranged-other-${crypto.randomUUID()}`;
        const targetOutbound = await admitForSession(targetSession, 60_000);
        const targetInbound = await retainPendingForSession(targetSession, 60_000);
        const otherOutbound = await admitForSession(otherSession, 60_000);
        const otherInbound = await retainPendingForSession(otherSession, 60_000);

        const capturedRanges: IDBKeyRange[] = [];
        const originalOpenCursor = IDBObjectStore.prototype.openCursor;
        const openCursorSpy = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (
            this: IDBObjectStore,
            range?: IDBValidKey | IDBKeyRange | null,
            direction?: IDBCursorDirection
        ) {
            if (this.name === AL_ADMISSION_WORK_STORE_NAME && range instanceof IDBKeyRange) {
                capturedRanges.push(range);
            }
            return originalOpenCursor.call(this, range ?? undefined, direction);
        });

        await deleteBrowserALRuntimeEntriesForSession(targetSession);
        openCursorSpy.mockRestore();

        expect(capturedRanges.length).toBeGreaterThan(0);
        for (const range of capturedRanges) {
            const lower = range.lower as string;
            expect(
                lower.startsWith('AL_INBOUND/') ||
                    lower.startsWith('AL_OUTBOUND/') ||
                    lower.startsWith('AL_OUTBOUND_MESSAGE/scope-') ||
                    lower.startsWith('AL_OUTBOUND_IDENTITY/scope-')
            ).toBe(true);
        }

        const remaining = await readRawWorkRows();
        expect(remaining.filter((row) => targetOutbound.keys.has(row.keyString))).toEqual([]);
        expect(remaining.some((row) => row.keyString === targetInbound.keyString)).toBe(false);
        expect(remaining.filter((row) => otherOutbound.keys.has(row.keyString))).toHaveLength(otherOutbound.keys.size);
        expect(remaining.some((row) => row.keyString === otherInbound.keyString)).toBe(true);
    });
});

async function admitForSession(sessionId: string, ttlMs: number) {
    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
    const store = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
    const before = new Set((await readRawWorkRows()).map((row) => row.keyString));
    const runtime = createOutboundTestRuntimeFor({
        queueEngine: new InboxOutboxEngine(),
        stores: store,
        decodePreparedMessage: decodeALOutboundTransportMessage,
        planOutgoingMessage: (msg) => ({
            msg,
            persist: true,
            preparedMessages: [toALOutboundTransportMessage(msg)]
        }),
        sendPreparedMessage: async () => ({ status: 'not-ready', retryAfterMs: 60_000 })
    });
    const result = await runtime.enqueueIfAbsent(createOutboundMessage(sessionId, { ttlMs }));
    expect(result.status).toBe('enqueued');
    runtime.dispose();
    const keys = new Set((await readRawWorkRows()).map((row) => row.keyString).filter((key) => !before.has(key)));
    expect(keys.size).toBe(3);
    return { store, keys };
}

async function readRawWorkRows(): Promise<readonly RawWorkRow[]> {
    const db = await openIndexedDbAdmissionDatabase({
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    });
    try {
        const tx = db.transaction(AL_ADMISSION_WORK_STORE_NAME, 'readonly');
        return await readIndexedDbTransaction(tx, async () => await readIndexedDbRequest(tx.objectStore(AL_ADMISSION_WORK_STORE_NAME).getAll()));
    }
    finally {
        db.close();
    }
}

async function retainPendingForSession(sessionId: string, ttlMs: number) {
    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
    const stores = resolveBrowserWsClientALInboundRuntimeStores(sessionId);
    const store = stores.admissionStore;
    await store.ready();
    const msg = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'pending', contextId: 'room' }, sessionId, 'chat', {}, { ttlMs });
    const work = computeALInboundWorkEntry({
        namespace: store.namespace,
        effectId: toALInboundPendingAdmissionId(msg),
        payload: { kind: 'admit-message', msg, source: { kind: 'trusted-server' } },
        observedAtMs: Date.now(),
        expireAtTimestamp: msg.constraints!.expiresAtMs!
    });
    await stores.workQueue.enqueueIfAbsent(work.entry);
    return { queue: stores.workQueue, resource: work.entry.resource, keyString: toKeyAsString(work.entry.key) };
}

/** Retains a pending AL_INBOUND row under a caller-chosen namespace, bypassing session wiring. */
async function retainPendingUnderNamespace(db: IDBDatabase, namespace: string, effectId: string): Promise<string> {
    const workQueue = new IndexedDbQueueBox({
        connection: new IndexedDbConnection(async () => db),
        storeName: AL_ADMISSION_WORK_STORE_NAME,
        completedRetention: AL_ADMISSION_WORK_COMPLETED_RETENTION,
        now: () => Temporal.Instant.fromEpochMilliseconds(Date.now()),
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const msg = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'pending', contextId: 'room' }, 'recipient', 'chat', {}, { ttlMs: 60_000 });
    const work = computeALInboundWorkEntry({
        namespace,
        effectId,
        payload: { kind: 'admit-message', msg, source: { kind: 'trusted-server' } },
        observedAtMs: Date.now(),
        expireAtTimestamp: msg.constraints!.expiresAtMs!
    });
    await workQueue.enqueueIfAbsent(work.entry);
    return toKeyAsString(work.entry.key);
}
