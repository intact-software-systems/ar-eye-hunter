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
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import {
    IndexedDbStringPersistenceProvider,
    newALUnicastMessage,
    type ALMessage,
    type ALOutboundAdmissionStore,
    type ALOutboundSentMessageSnapshot
} from '@shared/mod.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

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
        const currentAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(currentSessionId).admissionStore;
        const oldAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(oldSessionId).admissionStore;
        const unrelatedAdmissionStore = createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { retention }).admissionStore;
        const currentExpiredMsgId = 'current-expired';
        const currentFreshMsgId = 'current-fresh';
        const oldExpiredMsgId = 'old-expired';
        const unrelatedExpiredMsgId = 'unrelated-expired';

        await persistSentMessage(currentAdmissionStore, currentExpiredMsgId);
        await persistSentMessage(oldAdmissionStore, oldExpiredMsgId);
        await persistSentMessage(unrelatedAdmissionStore, unrelatedExpiredMsgId);
        await vi.advanceTimersByTimeAsync(21);
        await persistSentMessage(currentAdmissionStore, currentFreshMsgId);

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

        expect(await readSentMessageIds(currentAdmissionStore)).toEqual([currentFreshMsgId]);
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
        const freshSessionAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(freshSessionId).admissionStore;

        expect(await readSentMessageIds(freshSessionAdmissionStore)).toEqual([]);
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
        const firstSessionAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore;
        const persistedMsgId = 'restore-unexpired';

        await persistSentMessage(firstSessionAdmissionStore, persistedMsgId);

        const reusedSessionAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore;
        const replacementSessionAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(replacementSessionId).admissionStore;

        expect(await readSentMessageIds(reusedSessionAdmissionStore)).toEqual([persistedMsgId]);
        expect(await readSentMessageIds(replacementSessionAdmissionStore)).toEqual([]);
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
        const currentAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(currentSessionId).admissionStore;
        const oldAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(oldSessionId).admissionStore;
        const unrelatedAdmissionStore = createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { retention }).admissionStore;
        const nonBrowserProvider = new IndexedDbStringPersistenceProvider<{ value: string; }>({
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            keyPrefix: 'custom:outside-browser-al-runtime'
        });

        await persistSentMessage(currentAdmissionStore, 'current-expired');
        await persistSentMessage(oldAdmissionStore, 'old-expired');
        await persistSentMessage(unrelatedAdmissionStore, 'unrelated-expired');
        await nonBrowserProvider.setItem(
            'expired',
            { value: 'keep' },
            { expireAtTimestamp: Date.now() + 20 }
        );

        await vi.advanceTimersByTimeAsync(21);
        await persistSentMessage(currentAdmissionStore, 'current-fresh');
        await persistSentMessage(oldAdmissionStore, 'old-fresh');

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
            scanned: 8,
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
        const targetAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId).admissionStore;
        const otherAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(otherSessionId).admissionStore;

        await persistSentMessage(targetAdmissionStore, 'target-expired');
        await persistSentMessage(otherAdmissionStore, 'other-expired');
        await vi.advanceTimersByTimeAsync(21);
        await persistSentMessage(targetAdmissionStore, 'target-fresh');
        await persistSentMessage(otherAdmissionStore, 'other-fresh');

        const targetSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(targetSessionId)
        );
        const otherSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(otherSessionId)
        );

        const result = await deleteExpiredBrowserALRuntimeEntriesForSession(targetSessionId);

        expect(result.scanned).toBe(3);
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
        }, decodeALOutboundPreparedMessage);

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
        const targetWsAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId).admissionStore;
        const targetOverlayAdmissionStore = resolveBrowserRtcOverlayALOutboundRuntimeStores(targetSessionId).admissionStore;
        const otherAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(otherSessionId).admissionStore;
        const targetRtcRxProvider = new IndexedDbStringPersistenceProvider<{ value: string; }>({
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            keyPrefix: `${
                toBrowserALRuntimeEntryKeyPrefix(
                    toBrowserRtcRxALRuntimeStoreId(targetSessionId)
                )
            }inbound:admission`
        });

        await persistSentMessage(targetWsAdmissionStore, 'target-ws');
        await persistSentMessage(targetOverlayAdmissionStore, 'target-overlay');
        await targetRtcRxProvider.setItem(
            'target-rx',
            { value: 'target-rx' },
            { expireAtTimestamp: Date.now() + 60_000 }
        );
        await persistSentMessage(otherAdmissionStore, 'other-ws');

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

        expect(result.scanned).toBe(5);
        expect(result.deleted).toBe(5);
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
        const admissionStore = createBrowserALOutboundRuntimeStores(runtimeName, { retention }).admissionStore;
        const sentPrefix = toBrowserOutboundSentPrefix(runtimeName);

        await persistSentMessage(admissionStore, 'initial-expired');
        await vi.advanceTimersByTimeAsync(21);

        await initBrowserALRuntimeExpiryEviction(50);

        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([]);

        await persistSentMessage(admissionStore, 'interval-expired');
        await vi.advanceTimersByTimeAsync(21);
        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([
            `${sentPrefix}:interval-expired`
        ]);

        await vi.advanceTimersByTimeAsync(29);

        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([]);
    });
});

async function readSentMessageIds(
    admissionStore: ALOutboundAdmissionStore
): Promise<readonly string[]> {
    const snapshots = await admissionStore.getAllSentMessages();

    return snapshots.map((snapshot) => snapshot.msgId).sort();
}

async function persistSentMessage(
    admissionStore: ALOutboundAdmissionStore,
    msgId: string
): Promise<void> {
    const snapshot = createSentSnapshot(msgId);
    const read = await admissionStore.readOutgoingMessage(
        snapshot.msg,
        () => ({ persist: true, preparedMessages: [] })
    );
    const status = await admissionStore.commitBundle({
        senderId: snapshot.msg.id.senderId,
        expectedVersion: read.clientRecord?.version,
        mutations: [{ kind: 'set-sent-message', snapshot }],
        durableEffects: []
    }, decodeALOutboundPreparedMessage);

    if (status !== 'committed') {
        throw new Error(`Failed to persist sent message ${msgId}`);
    }
}

function createSentSnapshot(msgId: string): ALOutboundSentMessageSnapshot {
    const msg = createOutboundUnicastMessage(msgId);
    return {
        msgId,
        msg: { ...msg, id: { ...msg.id, msgId } }
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
    return `${toBrowserALRuntimeEntryKeyPrefix(runtimeStoreName)}outbound:admission:sent`;
}

async function readBrowserALRuntimeEntryKeys(
    keyPrefix: string
): Promise<readonly string[]> {
    const db = await openBrowserALRuntimeDatabase();

    try {
        return await new Promise<readonly string[]>((resolve, reject) => {
            const tx = db.transaction(
                BROWSER_AL_RUNTIME_STORE_NAME,
                'readonly'
            );
            const store = tx.objectStore(BROWSER_AL_RUNTIME_STORE_NAME);
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

                const key = cursor.primaryKey;
                if (typeof key !== 'string') {
                    reject(new TypeError('Expected a string browser-runtime key'));
                    tx.abort();
                    return;
                }
                if (key.startsWith(keyPrefix)) {
                    keys.push(key);
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
