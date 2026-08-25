// @vitest-environment happy-dom

import '../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { BROWSER_AL_RUNTIME_DB_NAME } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    createBrowserQueueBox,
    deleteExpiredBrowserQueueBoxEntriesForSession,
    initBrowserQueueBoxExpiryEviction,
    toBrowserQueueBoxStoreName
} from '@shared-web/browser/queuebox/browser-queuebox-persistence.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RawQueueBoxEntry = Readonly<{
    keyString: string;
}>;

describe('Browser queuebox expiry eviction', () => {
    beforeEach(async () => {
        vi.useRealTimers();
        await deleteBrowserRuntimeDatabase();
    });

    afterEach(async () => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        await deleteBrowserRuntimeDatabase();
    });

    it('deletes expired queuebox rows for one browser session', async () => {
        const targetSessionId = `queue-target-${crypto.randomUUID()}`;
        const otherSessionId = `queue-other-${crypto.randomUUID()}`;
        const targetWsInboxStoreName = toBrowserQueueBoxStoreName(
            `ws-inbox-${targetSessionId}`
        );
        const otherWsInboxStoreName = toBrowserQueueBoxStoreName(
            `ws-inbox-${otherSessionId}`
        );
        const targetQueue = createBrowserQueueBox(`ws-inbox-${targetSessionId}`);
        const otherQueue = createBrowserQueueBox(`ws-inbox-${otherSessionId}`);

        await targetQueue.enqueue(createEntry('target-expired', expiredTs()));
        await targetQueue.enqueue(createEntry('target-fresh', NEVER_EXPIRE_TS));
        await otherQueue.enqueue(createEntry('other-expired', expiredTs()));

        const result = await deleteExpiredBrowserQueueBoxEntriesForSession(targetSessionId);

        expect(result.dbName).toBe(BROWSER_AL_RUNTIME_DB_NAME);
        expect(result.sessionId).toBe(targetSessionId);
        expect(result.deleted).toBe(1);
        expect(result.stores).toContainEqual({
            storeName: targetWsInboxStoreName,
            deleted: 1
        });
        expect(await readQueueBoxEntryKeys(targetWsInboxStoreName)).toEqual([
            'chat.message.v1/target-fresh/ctx-1'
        ]);
        expect(await readQueueBoxEntryKeys(otherWsInboxStoreName)).toEqual([
            'chat.message.v1/other-expired/ctx-1'
        ]);
    });

    it('initialises repeated browser queuebox expiry eviction for one session', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        const sessionId = `queue-interval-${crypto.randomUUID()}`;
        const storeName = toBrowserQueueBoxStoreName(`ws-inbox-${sessionId}`);
        const queue = createBrowserQueueBox(`ws-inbox-${sessionId}`);

        await queue.enqueue(createEntry('initial-expired', expiredTs()));

        await initBrowserQueueBoxExpiryEviction(50);

        expect(await readQueueBoxEntryKeys(storeName)).toEqual([]);

        await queue.enqueue(createEntry('interval-expired', expiredTs()));
        expect(await readQueueBoxEntryKeys(storeName)).toEqual([
            'chat.message.v1/interval-expired/ctx-1'
        ]);

        await vi.advanceTimersByTimeAsync(50);

        expect(await readQueueBoxEntryKeys(storeName)).toEqual([]);
    });
});

function createEntry(resourceId: string, expiryTs: Temporal.Instant): ResourceEntry {
    return {
        key: {
            topicId: 'chat.message.v1',
            resourceId,
            contextId: 'ctx-1'
        },
        resource: JSON.stringify({ resourceId }),
        typeId: 'chat.message.v1',
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: 'test',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs
        },
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0
        },
        db: undefined
    };
}

function expiredTs(): Temporal.Instant {
    return Temporal.Instant.from('2025-01-01T00:00:00Z');
}

async function readQueueBoxEntryKeys(
    storeName: string
): Promise<readonly string[]> {
    const db = await openBrowserRuntimeDatabase();

    try {
        if (!db.objectStoreNames.contains(storeName)) {
            return [];
        }

        return await new Promise<readonly string[]>((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.openCursor();
            const keys: string[] = [];

            tx.oncomplete = () => resolve(keys.sort());
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB read failed'));
            request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    return;
                }

                keys.push((cursor.value as RawQueueBoxEntry).keyString);
                cursor.continue();
            };
        });
    }
    finally {
        db.close();
    }
}

async function openBrowserRuntimeDatabase(): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(BROWSER_AL_RUNTIME_DB_NAME);

        request.onerror = () =>
            reject(
                request.error ?? new Error('Browser runtime IndexedDB open failed')
            );
        request.onsuccess = () => resolve(request.result);
    });
}

async function deleteBrowserRuntimeDatabase(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(BROWSER_AL_RUNTIME_DB_NAME);

        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(
                request.error ?? new Error('Browser runtime IndexedDB delete failed')
            );
        request.onblocked = () =>
            reject(
                new Error('Browser runtime IndexedDB delete blocked')
            );
    });
}
