import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { toALInboundPendingAdmissionId } from '@shared/alm/inbound/al-inbound-pending-admission.ts';
import { computeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
// @vitest-environment happy-dom

import '../../setup-browser-indexeddb.ts';

import {
    deleteBrowserALRuntimeEntriesForSession,
    deleteExpiredBrowserALRuntimeEntries,
    initBrowserALRuntimeExpiryEviction
} from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { BROWSER_AL_RUNTIME_DB_NAME, BROWSER_AL_RUNTIME_STORE_NAME } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    resolveBrowserWsClientALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { AL_ADMISSION_WORK_STORE_NAME, openIndexedDbAdmissionDatabase } from '@shared/alm/open-indexed-db-admission-database.ts';
import { decodeALOutboundIdentityFact, toALOutboundIdentityKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { readIndexedDbRequest, readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createDefaultOutboundTestRuntime, createOutboundMessage } from '../../shared/alm/outbound-runtime-test-fixture.ts';

interface RawWorkRow {
    readonly keyString: string;
    readonly resource: string;
    readonly typeId: string;
}

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
});

async function admitForSession(sessionId: string, ttlMs: number) {
    configureBrowserALRuntimeStores(sessionId);
    const store = resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore;
    const before = new Set((await readRawWorkRows()).map((row) => row.keyString));
    const runtime = createDefaultOutboundTestRuntime({
        queueEngine: new InboxOutboxEngine(),
        stores: { admissionStore: store },
        planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ kind: 'send' }] }),
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
    const db = await openIndexedDbAdmissionDatabase(BROWSER_AL_RUNTIME_DB_NAME, BROWSER_AL_RUNTIME_STORE_NAME);
    try {
        const tx = db.transaction(AL_ADMISSION_WORK_STORE_NAME, 'readonly');
        return await readIndexedDbTransaction(tx, async () => await readIndexedDbRequest(tx.objectStore(AL_ADMISSION_WORK_STORE_NAME).getAll()));
    }
    finally {
        db.close();
    }
}

async function retainPendingForSession(sessionId: string, ttlMs: number) {
    configureBrowserALRuntimeStores(sessionId);
    const store = resolveBrowserWsClientALInboundRuntimeStores(sessionId).admissionStore;
    await store.ready();
    const msg = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'pending', contextId: 'room' }, sessionId, 'chat', {}, { ttlMs });
    const work = computeALInboundWorkEntry({
        namespace: store.namespace,
        effectId: toALInboundPendingAdmissionId(msg),
        payload: { kind: 'admit-message', msg, source: { kind: 'trusted-server' } },
        observedAtMs: Date.now(),
        expireAtTimestamp: msg.constraints!.expiresAtMs!
    });
    await store.workQueue.enqueueIfAbsent(work.entry);
    return { queue: store.workQueue, resource: work.entry.resource };
}
