// @vitest-environment happy-dom

import '../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import {
    createBrowserQueueBox,
    deleteBrowserQueueBoxDatabasesForSession,
    initBrowserQueueBoxExpiryEviction
} from '@shared-web/browser/queuebox/browser-queuebox-persistence.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    it('initialises repeated browser queuebox expiry eviction for one session', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        const sessionId = `queue-interval-${crypto.randomUUID()}`;
        const queue = createBrowserQueueBox(`ws-inbox-${sessionId}`);

        await queue.enqueue(createEntry('initial-expired', expiredTs()));

        await initBrowserQueueBoxExpiryEviction(50);

        expect(await queue.getAllKeys()).toEqual([]);

        await queue.enqueue(
            createEntry(
                'interval-expired',
                Temporal.Instant.from('2026-01-01T00:00:00.025Z')
            )
        );
        expect(await queue.getAllKeys()).toEqual([
            {
                topicId: 'chat.message.v1',
                resourceId: 'interval-expired',
                contextId: 'ctx-1'
            }
        ]);

        await vi.advanceTimersByTimeAsync(50);

        await vi.waitFor(async () => {
            expect(await queue.getAllKeys()).toEqual([]);
        });
    });

    it('does not create absent session queue databases during cleanup', async () => {
        const sessionId = `queue-absent-${crypto.randomUUID()}`;
        const queue = createBrowserQueueBox(`ws-inbox-${sessionId}`);
        await queue.enqueue(createEntry('existing-expired', expiredTs()));
        const before = await readBrowserQueueBoxDatabaseNames();

        await deleteBrowserQueueBoxDatabasesForSession(`absent-${sessionId}`);

        expect(await readBrowserQueueBoxDatabaseNames()).toEqual(before);
    });

    it('removes every queue database when its browser session ends', async () => {
        const sessionId = `queue-empty-${crypto.randomUUID()}`;
        const queue = createBrowserQueueBox(`ws-inbox-${sessionId}`);
        await queue.enqueue(createEntry('retained-until-session-end', NEVER_EXPIRE_TS));
        const databaseName = (await readBrowserQueueBoxDatabaseNames())
            .find((name) => name.includes(sessionId));

        expect(databaseName).toBeDefined();
        if (!databaseName) {
            throw new Error('Expected the session queue database to exist');
        }

        await deleteBrowserQueueBoxDatabasesForSession(sessionId);

        expect(await readBrowserQueueBoxDatabaseNames()).not.toContain(databaseName);
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

async function deleteBrowserRuntimeDatabase(): Promise<void> {
    const databases = await indexedDB.databases();
    await Promise.all(
        databases
            .map(({ name }) => name)
            .filter((name): name is string => name?.includes(':queuebox:') ?? false)
            .map(deleteDatabase)
    );
}

async function readBrowserQueueBoxDatabaseNames(): Promise<readonly string[]> {
    return (await indexedDB.databases())
        .flatMap(({ name }) => name?.includes(':queuebox:') ? [name] : [])
        .sort();
}

async function deleteDatabase(name: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);

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
