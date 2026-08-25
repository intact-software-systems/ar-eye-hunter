// @vitest-environment happy-dom

import '../../setup-browser-indexeddb.ts';

import {
    deleteBrowserALRuntimeEntriesForSession,
    deleteExpiredBrowserALRuntimeEntries,
    deleteExpiredBrowserALRuntimeEntriesForSession,
    initBrowserALRuntimeExpiryEviction
} from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import {
    BROWSER_AL_RUNTIME_DB_NAME,
    BROWSER_AL_RUNTIME_STORE_NAME,
    toBrowserALRuntimeEntryKeyPrefix,
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserRtcRxALRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    createBrowserALOutboundRuntimeStores,
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import {
    IndexedDbStringPersistenceProvider,
    newALUnicastMessage,
    type ALMessage,
    type ALOutboundRuntimeStateStore,
    type ALOutboundRuntimeStores,
    type ALOutboundSentMessageSnapshot
} from '@shared/mod.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RawBrowserALRuntimeEntry = Readonly<{
    key: string;
    expireAtTimestamp: number;
}>;

describe('Browser AL runtime IndexedDB stores', () => {
    beforeEach(async () => {
        vi.useRealTimers();
        await deleteBrowserALRuntimeDatabase();
    });

    afterEach(async () => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        await deleteBrowserALRuntimeDatabase();
    });

    it('evicts expired rows only for the scanned browser session prefix', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const retention = {
            sentMessageTtlMs: 20
        };
        const currentSessionId = `current-${crypto.randomUUID()}`;
        const oldSessionId = `old-${crypto.randomUUID()}`;
        const unrelatedRuntimeName = `unrelated-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(currentSessionId, { retention });
        configureBrowserALRuntimeStores(oldSessionId, { retention });
        const currentStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(currentSessionId)
        );
        const oldStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(oldSessionId)
        );
        const unrelatedStateStore = requireOutboundStateStore(
            createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { retention })
        );
        const currentExpiredMsgId = 'current-expired';
        const currentFreshMsgId = 'current-fresh';
        const oldExpiredMsgId = 'old-expired';
        const unrelatedExpiredMsgId = 'unrelated-expired';

        await currentStateStore.setSentMessage(createSentSnapshot(currentExpiredMsgId));
        await oldStateStore.setSentMessage(createSentSnapshot(oldExpiredMsgId));
        await unrelatedStateStore.setSentMessage(createSentSnapshot(unrelatedExpiredMsgId));
        await vi.advanceTimersByTimeAsync(21);
        await currentStateStore.setSentMessage(createSentSnapshot(currentFreshMsgId));

        const currentSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(currentSessionId)
        );
        const oldSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(oldSessionId)
        );
        const unrelatedSentPrefix = toBrowserOutboundSentPrefix(unrelatedRuntimeName);

        expect(await readBrowserALRuntimeEntryKeys(currentSentPrefix)).toEqual([
            `${currentSentPrefix}:${currentExpiredMsgId}`,
            `${currentSentPrefix}:${currentFreshMsgId}`
        ]);
        expect(await readBrowserALRuntimeEntryKeys(oldSentPrefix)).toEqual([
            `${oldSentPrefix}:${oldExpiredMsgId}`
        ]);
        expect(await readBrowserALRuntimeEntryKeys(unrelatedSentPrefix)).toEqual([
            `${unrelatedSentPrefix}:${unrelatedExpiredMsgId}`
        ]);

        expect(await readSentMessageIds(currentStateStore)).toEqual([currentFreshMsgId]);
        expect(await readBrowserALRuntimeEntryKeys(currentSentPrefix)).toEqual([
            `${currentSentPrefix}:${currentFreshMsgId}`
        ]);
        expect(await readBrowserALRuntimeEntryKeys(oldSentPrefix)).toEqual([
            `${oldSentPrefix}:${oldExpiredMsgId}`
        ]);
        expect(await readBrowserALRuntimeEntryKeys(unrelatedSentPrefix)).toEqual([
            `${unrelatedSentPrefix}:${unrelatedExpiredMsgId}`
        ]);

        const freshSessionId = `fresh-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(freshSessionId, { retention });
        const freshSessionStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(freshSessionId)
        );

        expect(await readSentMessageIds(freshSessionStateStore)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(oldSentPrefix)).toEqual([
            `${oldSentPrefix}:${oldExpiredMsgId}`
        ]);
    });

    it('restores unexpired state only when the browser session id is reused', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const retention = {
            sentMessageTtlMs: 60_000
        };
        const sessionId = `restore-${crypto.randomUUID()}`;
        const replacementSessionId = `replacement-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, { retention });
        configureBrowserALRuntimeStores(replacementSessionId, { retention });
        const firstSessionStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(sessionId)
        );
        const persistedMsgId = 'restore-unexpired';

        await firstSessionStateStore.setSentMessage(createSentSnapshot(persistedMsgId));

        const reusedSessionStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(sessionId)
        );
        const replacementSessionStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(replacementSessionId)
        );

        expect(await readSentMessageIds(reusedSessionStateStore)).toEqual([persistedMsgId]);
        expect(await readSentMessageIds(replacementSessionStateStore)).toEqual([]);
    });

    it('deletes expired rows across browser runtime prefixes without touching non-browser rows', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const retention = {
            sentMessageTtlMs: 20
        };
        const currentSessionId = `cleanup-current-${crypto.randomUUID()}`;
        const oldSessionId = `cleanup-old-${crypto.randomUUID()}`;
        const unrelatedRuntimeName = `cleanup-unrelated-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(currentSessionId, { retention });
        configureBrowserALRuntimeStores(oldSessionId, { retention });
        const currentStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(currentSessionId)
        );
        const oldStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(oldSessionId)
        );
        const unrelatedStateStore = requireOutboundStateStore(
            createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { retention })
        );
        const nonBrowserProvider = new IndexedDbStringPersistenceProvider<{ value: string; }>({
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            keyPrefix: 'custom:outside-browser-al-runtime'
        });

        await currentStateStore.setSentMessage(createSentSnapshot('current-expired'));
        await oldStateStore.setSentMessage(createSentSnapshot('old-expired'));
        await unrelatedStateStore.setSentMessage(createSentSnapshot('unrelated-expired'));
        await nonBrowserProvider.setItem(
            'expired',
            { value: 'keep' },
            { expireAtTimestamp: Date.now() + 20 }
        );

        await vi.advanceTimersByTimeAsync(21);
        await currentStateStore.setSentMessage(createSentSnapshot('current-fresh'));
        await oldStateStore.setSentMessage(createSentSnapshot('old-fresh'));

        const currentSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(currentSessionId)
        );
        const oldSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(oldSessionId)
        );
        const unrelatedSentPrefix = toBrowserOutboundSentPrefix(unrelatedRuntimeName);

        const result = await deleteExpiredBrowserALRuntimeEntries();

        expect(result).toMatchObject({
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            storeName: BROWSER_AL_RUNTIME_STORE_NAME,
            keyPrefixes: ['browser:'],
            scanned: 5,
            deleted: 3
        });
        expect(await readBrowserALRuntimeEntryKeys(currentSentPrefix)).toEqual([
            `${currentSentPrefix}:current-fresh`
        ]);
        expect(await readBrowserALRuntimeEntryKeys(oldSentPrefix)).toEqual([
            `${oldSentPrefix}:old-fresh`
        ]);
        expect(await readBrowserALRuntimeEntryKeys(unrelatedSentPrefix)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys('custom:outside-browser-al-runtime')).toEqual([
            'custom:outside-browser-al-runtime:expired'
        ]);
    });

    it('can delete expired rows only for one browser session', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const retention = {
            sentMessageTtlMs: 20
        };
        const targetSessionId = `expired-target-${crypto.randomUUID()}`;
        const otherSessionId = `expired-other-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(targetSessionId, { retention });
        configureBrowserALRuntimeStores(otherSessionId, { retention });
        const targetStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId)
        );
        const otherStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(otherSessionId)
        );

        await targetStateStore.setSentMessage(createSentSnapshot('target-expired'));
        await otherStateStore.setSentMessage(createSentSnapshot('other-expired'));
        await vi.advanceTimersByTimeAsync(21);
        await targetStateStore.setSentMessage(createSentSnapshot('target-fresh'));
        await otherStateStore.setSentMessage(createSentSnapshot('other-fresh'));

        const targetSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(targetSessionId)
        );
        const otherSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(otherSessionId)
        );

        const result = await deleteExpiredBrowserALRuntimeEntriesForSession(targetSessionId);

        expect(result.scanned).toBe(2);
        expect(result.deleted).toBe(1);
        expect(await readBrowserALRuntimeEntryKeys(targetSentPrefix)).toEqual([
            `${targetSentPrefix}:target-fresh`
        ]);
        expect(await readBrowserALRuntimeEntryKeys(otherSentPrefix)).toEqual([
            `${otherSentPrefix}:other-expired`,
            `${otherSentPrefix}:other-fresh`
        ]);
    });

    it('deletes outbound message-owner rows after their explicit expiry', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const sessionId = `owner-retention-${crypto.randomUUID()}`;
        const msgId = 'browser-owner-short-lived';
        const expireAtTimestamp = Date.now() + 15_000;
        configureBrowserALRuntimeStores(sessionId);
        const stores = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
        if (!stores.admissionStore) {
            throw new Error('Expected outbound admission store');
        }

        await stores.admissionStore.commitBundle({
            senderId: sessionId,
            expectedVersion: undefined,
            mutations: [
                {
                    kind: 'set-msg-owner',
                    msgId,
                    senderId: sessionId,
                    expireAtTimestamp
                }
            ],
            durableEffects: []
        });

        const ownerPrefix = `${
            toBrowserALRuntimeEntryKeyPrefix(
                toBrowserWsClientALRuntimeStoreId(sessionId)
            )
        }outbound:admission:msg-owner`;

        expect(await readBrowserALRuntimeEntryKeys(ownerPrefix)).toEqual([
            `${ownerPrefix}:${msgId}`
        ]);

        await vi.advanceTimersByTimeAsync(15_001);

        const result = await deleteExpiredBrowserALRuntimeEntriesForSession(sessionId);

        expect(result.deleted).toBe(1);
        expect(await readBrowserALRuntimeEntryKeys(ownerPrefix)).toEqual([]);
    });

    it('can purge every browser AL runtime row for one session', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const retention = {
            sentMessageTtlMs: 60_000
        };
        const targetSessionId = `purge-target-${crypto.randomUUID()}`;
        const otherSessionId = `purge-other-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(targetSessionId, { retention });
        configureBrowserALRuntimeStores(otherSessionId, { retention });
        const targetWsStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId)
        );
        const targetOverlayStateStore = requireOutboundStateStore(
            resolveBrowserRtcOverlayALOutboundRuntimeStores(targetSessionId)
        );
        const otherStateStore = requireOutboundStateStore(
            resolveBrowserWsClientALOutboundRuntimeStores(otherSessionId)
        );
        const targetRtcRxProvider = new IndexedDbStringPersistenceProvider<{ value: string; }>({
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            keyPrefix: `${
                toBrowserALRuntimeEntryKeyPrefix(
                    toBrowserRtcRxALRuntimeStoreId(targetSessionId)
                )
            }inbound:admission`
        });

        await targetWsStateStore.setSentMessage(createSentSnapshot('target-ws'));
        await targetOverlayStateStore.setSentMessage(createSentSnapshot('target-overlay'));
        await targetRtcRxProvider.setItem(
            'target-rx',
            { value: 'target-rx' },
            { expireAtTimestamp: Date.now() + 60_000 }
        );
        await otherStateStore.setSentMessage(createSentSnapshot('other-ws'));

        const targetWsSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(targetSessionId)
        );
        const targetRtcRxPrefix = toBrowserALRuntimeEntryKeyPrefix(
            toBrowserRtcRxALRuntimeStoreId(targetSessionId)
        );
        const targetOverlaySentPrefix = toBrowserOutboundSentPrefix(
            toBrowserRtcOverlayALRuntimeStoreId(targetSessionId)
        );
        const otherSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(otherSessionId)
        );

        const result = await deleteBrowserALRuntimeEntriesForSession(targetSessionId);

        expect(result.scanned).toBe(3);
        expect(result.deleted).toBe(3);
        expect(await readBrowserALRuntimeEntryKeys(targetWsSentPrefix)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(targetRtcRxPrefix)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(targetOverlaySentPrefix)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(otherSentPrefix)).toEqual([
            `${otherSentPrefix}:other-ws`
        ]);
    });

    it('initialises repeated browser AL runtime expiry eviction', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        const retention = {
            sentMessageTtlMs: 20
        };
        const runtimeName = `interval-runtime-${crypto.randomUUID()}`;
        const stateStore = requireOutboundStateStore(
            createBrowserALOutboundRuntimeStores(runtimeName, { retention })
        );
        const sentPrefix = toBrowserOutboundSentPrefix(runtimeName);

        await stateStore.setSentMessage(createSentSnapshot('initial-expired'));
        await vi.advanceTimersByTimeAsync(21);

        await initBrowserALRuntimeExpiryEviction(50);

        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([]);

        await stateStore.setSentMessage(createSentSnapshot('interval-expired'));
        await vi.advanceTimersByTimeAsync(21);
        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([
            `${sentPrefix}:interval-expired`
        ]);

        await vi.advanceTimersByTimeAsync(29);

        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([]);
    });
});

function requireOutboundStateStore(
    stores: ALOutboundRuntimeStores
): ALOutboundRuntimeStateStore {
    if (!stores.stateStore) {
        throw new Error('Expected outbound state store');
    }

    return stores.stateStore;
}

async function readSentMessageIds(
    stateStore: ALOutboundRuntimeStateStore
): Promise<readonly string[]> {
    const snapshots = await stateStore.getAllSentMessages();

    return snapshots.map((snapshot) => snapshot.msgId).sort();
}

function createSentSnapshot(msgId: string): ALOutboundSentMessageSnapshot {
    return {
        msgId,
        msg: createOutboundUnicastMessage(msgId)
    };
}

function createOutboundUnicastMessage(resourceId: string): ALMessage {
    return newALUnicastMessage(
        'self',
        {
            topicId: 'chat',
            resourceId,
            contextId: 'conversation-1'
        },
        'peer-1',
        'chat.private-text.v1',
        {
            text: resourceId
        }
    );
}

function toBrowserOutboundSentPrefix(runtimeStoreName: string): string {
    return `${toBrowserALRuntimeEntryKeyPrefix(runtimeStoreName)}outbound:sent`;
}

async function readBrowserALRuntimeEntryKeys(
    keyPrefix: string
): Promise<readonly string[]> {
    const entries = await readBrowserALRuntimeEntries(keyPrefix);

    return entries.map((entry) => entry.key).sort();
}

async function readBrowserALRuntimeEntries(
    keyPrefix: string
): Promise<readonly RawBrowserALRuntimeEntry[]> {
    const db = await openBrowserALRuntimeDatabase();

    try {
        return await new Promise<readonly RawBrowserALRuntimeEntry[]>((resolve, reject) => {
            const tx = db.transaction(
                BROWSER_AL_RUNTIME_STORE_NAME,
                'readonly'
            );
            const store = tx.objectStore(BROWSER_AL_RUNTIME_STORE_NAME);
            const request = store.openCursor();
            const entries: RawBrowserALRuntimeEntry[] = [];

            tx.oncomplete = () => resolve(entries);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB read failed'));
            request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    return;
                }

                const entry = cursor.value as RawBrowserALRuntimeEntry;
                if (entry.key.startsWith(keyPrefix)) {
                    entries.push(entry);
                }

                cursor.continue();
            };
        });
    }
    finally {
        db.close();
    }
}

async function openBrowserALRuntimeDatabase(): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(BROWSER_AL_RUNTIME_DB_NAME);

        request.onerror = () =>
            reject(
                request.error ?? new Error('Browser AL runtime IndexedDB open failed')
            );
        request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(BROWSER_AL_RUNTIME_STORE_NAME)) {
                db.close();
                reject(new Error('Browser AL runtime entries store is missing'));
                return;
            }

            resolve(db);
        };
    });
}

async function deleteBrowserALRuntimeDatabase(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(BROWSER_AL_RUNTIME_DB_NAME);

        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(
                request.error ?? new Error('Browser AL runtime IndexedDB delete failed')
            );
        request.onblocked = () =>
            reject(
                new Error('Browser AL runtime IndexedDB delete blocked')
            );
    });
}
