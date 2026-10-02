import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { computeOutboundTestAdmission } from '../../shared/alm/outbound-runtime-test-fixture.ts';
// @vitest-environment happy-dom

import '../../setup-browser-indexeddb.ts';

import {
    deleteBrowserALRuntimeEntriesForSession,
    deleteExpiredBrowserALRuntimeEntries,
    deleteExpiredBrowserALRuntimeEntriesForSession,
    initBrowserALRuntimeExpiryEviction
} from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import {
    BROWSER_AL_RUNTIME_STORE_NAME,
    toBrowserALRuntimeDbName,
    toBrowserALRuntimeEntryKeyPrefix,
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserSessionALInboundRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    createBrowserALOutboundRuntimeStores,
    createBrowserALVolatileInboundRuntimeStores,
    createBrowserALVolatileOutboundRuntimeStores,
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import {
    createPassThroughALInboundRuntimeDiagnosticsSink,
    createPassThroughALOutboundRuntimeDiagnosticsSink,
    toRallarDiagnosticsPorts
} from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
    newALUnicastMessage,
    type ALMessage,
    type ALOutboundAdmissionStore,
    type ALOutboundSentMessageSnapshot
} from '@shared/mod.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createDefaultVolatileSessionBudget } from '../default-volatile-session-budget.ts';

const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);
const SCOPE = defaultStateScope();
const OTHER_SCOPE: StateScope = { applicationId: 'other-app', workspaceId: 'other-workspace' };
// The names are spelled out so a change to the naming scheme fails here first.
const SCOPE_DB_NAME = 'rallar-al-runtime:rallar-server:default';
const OTHER_SCOPE_DB_NAME = 'rallar-al-runtime:other-app:other-workspace';
const LEGACY_DB_NAME = 'ar-eye-hunter-al-runtime';

describe('Browser AL runtime IndexedDB stores', () => {
    beforeEach(async () => {
        vi.useRealTimers();
        await deleteEveryIndexedDbDatabase();
    });

    afterEach(async () => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        showIndexedDbDatabaseListing();
        await deleteEveryIndexedDbDatabase();
    });

    it('evicts expired rows only for the scanned browser session prefix', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const retention = {
            sentMessageTtlMs: 20,
            controlHistoryTtlMs: 20,
            msgOwnerTtlMs: 20
        };
        const currentSessionId = `current-${crypto.randomUUID()}`;
        const oldSessionId = `old-${crypto.randomUUID()}`;
        const unrelatedRuntimeName = `unrelated-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(currentSessionId, { scope: SCOPE, retention, diagnosticsPorts });
        configureBrowserALRuntimeStores(oldSessionId, { scope: SCOPE, retention, diagnosticsPorts });
        const currentAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(currentSessionId).admissionStore;
        const oldAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(oldSessionId).admissionStore;
        const unrelatedAdmissionStore = createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { dbName: SCOPE_DB_NAME, retention }).admissionStore;
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
        configureBrowserALRuntimeStores(freshSessionId, { scope: SCOPE, retention, diagnosticsPorts });
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
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, retention, diagnosticsPorts });
        configureBrowserALRuntimeStores(replacementSessionId, { scope: SCOPE, retention, diagnosticsPorts });
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
            sentMessageTtlMs: 20,
            controlHistoryTtlMs: 20,
            msgOwnerTtlMs: 20
        };
        const currentSessionId = `cleanup-current-${crypto.randomUUID()}`;
        const oldSessionId = `cleanup-old-${crypto.randomUUID()}`;
        const unrelatedRuntimeName = `cleanup-unrelated-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(currentSessionId, { scope: SCOPE, retention, diagnosticsPorts });
        configureBrowserALRuntimeStores(oldSessionId, { scope: SCOPE, retention, diagnosticsPorts });
        const currentAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(currentSessionId).admissionStore;
        const oldAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(oldSessionId).admissionStore;
        const unrelatedAdmissionStore = createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { dbName: SCOPE_DB_NAME, retention }).admissionStore;
        const nonBrowserKey = 'custom:outside-browser-al-runtime:expired';

        await persistSentMessage(currentAdmissionStore, 'current-expired');
        await persistSentMessage(oldAdmissionStore, 'old-expired');
        await persistSentMessage(unrelatedAdmissionStore, 'unrelated-expired');
        await putRawBrowserALRuntimeEntry({
            key: nonBrowserKey,
            value: { value: 'keep' },
            expireAtTimestamp: Date.now() + 20,
            writeToken: crypto.randomUUID(),
            revision: 1
        });

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

        const result = await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });

        expect(result).toMatchObject({
            dbNames: [SCOPE_DB_NAME],
            storeName: BROWSER_AL_RUNTIME_STORE_NAME,
            keyPrefixes: ['browser:'],
            // AL_OUTBOUND work rows are expired via the QueueBox's own cleanupAsync sweep now,
            // so this scanned/deleted count reflects the plain admission metadata rows only.
            scanned: 6,
            deleted: 6
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

    it('reads metadata expiry candidates through the expiry index and visits canonical work separately', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const runtimeName = `indexed-cleanup-${crypto.randomUUID()}`;
        const admissionStore = createBrowserALOutboundRuntimeStores(runtimeName, {
            dbName: SCOPE_DB_NAME,
            retention: { sentMessageTtlMs: 20, controlHistoryTtlMs: 20, msgOwnerTtlMs: 20 }
        }).admissionStore;
        await persistSentMessage(admissionStore, 'expired');
        await vi.advanceTimersByTimeAsync(21);
        await persistSentMessage(admissionStore, 'fresh');
        vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => {
            throw new Error('Periodic expiry cleanup must not scan the complete object store');
        });

        const result = await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });

        // The AL_OUTBOUND work row's own expiry now goes through cleanupAsync, off this count.
        expect(result.deleted).toBe(2);
    });

    it.each([
        { label: 'missing expiry', expireAtTimestamp: undefined },
        { label: 'non-finite expiry', expireAtTimestamp: Number.NaN },
        { label: 'negative expiry', expireAtTimestamp: -1 },
        { label: 'negative-zero expiry', expireAtTimestamp: -0 }
    ])('preserves a corrupt browser admission row with $label', async ({ expireAtTimestamp }) => {
        const sessionId = `corrupt-cleanup-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
        await resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore.ready();
        const key = `${toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId))}:corrupt`;
        await putRawBrowserALRuntimeEntry({
            key,
            value: { msgId: 'corrupt' },
            ...(expireAtTimestamp === undefined ? {} : { expireAtTimestamp })
        });

        await expect(
            deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
                currentScope: SCOPE,
                storage: diagnosticsPorts.storage
            })
        ).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect(await readBrowserALRuntimeEntryKeys(key)).toEqual([key]);
    });

    it('can delete expired rows only for one browser session', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const retention = {
            sentMessageTtlMs: 20,
            controlHistoryTtlMs: 20,
            msgOwnerTtlMs: 20
        };
        const targetSessionId = `expired-target-${crypto.randomUUID()}`;
        const otherSessionId = `expired-other-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(targetSessionId, { scope: SCOPE, retention, diagnosticsPorts });
        configureBrowserALRuntimeStores(otherSessionId, { scope: SCOPE, retention, diagnosticsPorts });
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

        const result = await deleteExpiredBrowserALRuntimeEntriesForSession(targetSessionId, {
            currentScope: SCOPE,
            storage: diagnosticsPorts.storage
        });

        // The AL_OUTBOUND work rows' own expiry now goes through cleanupAsync, off this count.
        expect(result.scanned).toBe(5);
        expect(result.deleted).toBe(2);
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
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, retention: { msgOwnerTtlMs: 15_000, controlHistoryTtlMs: 15_000 }, diagnosticsPorts });
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

        const result = await deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
            currentScope: SCOPE,
            storage: diagnosticsPorts.storage
        });

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
        configureBrowserALRuntimeStores(targetSessionId, { scope: SCOPE, retention, diagnosticsPorts });
        configureBrowserALRuntimeStores(otherSessionId, { scope: SCOPE, retention, diagnosticsPorts });
        const targetWsAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId).admissionStore;
        const targetOverlayAdmissionStore = resolveBrowserRtcOverlayALOutboundRuntimeStores(targetSessionId).admissionStore;
        const otherAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(otherSessionId).admissionStore;
        const targetInboundKey = `${
            toBrowserALRuntimeEntryKeyPrefix(
                toBrowserSessionALInboundRuntimeStoreId(targetSessionId)
            )
        }inbound:admission:target-inbound`;

        await persistSentMessage(targetWsAdmissionStore, 'target-ws');
        await persistSentMessage(targetOverlayAdmissionStore, 'target-overlay');
        await putRawBrowserALRuntimeEntry({
            key: targetInboundKey,
            value: { value: 'target-inbound' },
            expireAtTimestamp: Date.now() + 60_000,
            writeToken: crypto.randomUUID(),
            revision: 1
        });
        await persistSentMessage(otherAdmissionStore, 'other-ws');

        const targetWsSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(targetSessionId)
        );
        const targetInboundPrefix = toBrowserALRuntimeEntryKeyPrefix(
            toBrowserSessionALInboundRuntimeStoreId(targetSessionId)
        );
        const targetOverlaySentPrefix = toBrowserOutboundSentPrefix(
            toBrowserRtcOverlayALRuntimeStoreId(targetSessionId)
        );
        const otherSentPrefix = toBrowserOutboundSentPrefix(
            toBrowserWsClientALRuntimeStoreId(otherSessionId)
        );

        const result = await deleteBrowserALRuntimeEntriesForSession(targetSessionId, {
            currentScope: SCOPE,
            storage: diagnosticsPorts.storage
        });

        expect(result.scanned).toBe(11);
        expect(result.deleted).toBe(11);
        expect(await readBrowserALRuntimeEntryKeys(targetWsSentPrefix)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(targetInboundPrefix)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(targetOverlaySentPrefix)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(otherSentPrefix)).toEqual([
            `${otherSentPrefix}:other-ws`
        ]);
    });

    it('names one database per scope', () => {
        expect(toBrowserALRuntimeDbName(SCOPE)).toBe(SCOPE_DB_NAME);
        expect(toBrowserALRuntimeDbName(OTHER_SCOPE)).toBe(OTHER_SCOPE_DB_NAME);
    });

    // Scope ids carry no pattern, so a colon inside one must not let two scopes share a database.
    it('encodes each scope part, so a colon inside an id names a database of its own', () => {
        expect(toBrowserALRuntimeDbName({ applicationId: 'a:b', workspaceId: 'c' })).toBe('rallar-al-runtime:a%3Ab:c');
        expect(toBrowserALRuntimeDbName({ applicationId: 'a', workspaceId: 'b:c' })).toBe('rallar-al-runtime:a:b%3Ac');
    });

    it('keeps two scopes of one session in disjoint databases', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const sessionId = `two-scopes-${crypto.randomUUID()}`;
        const sentPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId));
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'first-scope');

        configureBrowserALRuntimeStores(sessionId, { scope: OTHER_SCOPE, diagnosticsPorts });
        const otherScopeStore = resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore;
        expect(await otherScopeStore.readSentMessage('first-scope')).toBeUndefined();
        await persistSentMessage(otherScopeStore, 'other-scope');

        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
        const firstScopeStore = resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore;
        expect(await firstScopeStore.readSentMessage('first-scope')).toBeDefined();
        expect(await firstScopeStore.readSentMessage('other-scope')).toBeUndefined();
        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([`${sentPrefix}:first-scope`]);
        expect(await readBrowserALRuntimeEntryKeys(sentPrefix, OTHER_SCOPE_DB_NAME)).toEqual([
            `${sentPrefix}:other-scope`
        ]);
    });

    it('purges one session\'s rows from every scope\'s database', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const targetSessionId = `scoped-purge-target-${crypto.randomUUID()}`;
        const otherSessionId = `scoped-purge-other-${crypto.randomUUID()}`;
        const targetPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(targetSessionId));
        const otherPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(otherSessionId));
        configureBrowserALRuntimeStores(otherSessionId, { scope: SCOPE, diagnosticsPorts });
        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(otherSessionId).admissionStore, 'other');
        configureBrowserALRuntimeStores(targetSessionId, { scope: SCOPE, diagnosticsPorts });
        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId).admissionStore, 'first');
        configureBrowserALRuntimeStores(targetSessionId, { scope: OTHER_SCOPE, diagnosticsPorts });
        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId).admissionStore, 'second');

        const result = await deleteBrowserALRuntimeEntriesForSession(targetSessionId, {
            currentScope: SCOPE,
            storage: diagnosticsPorts.storage
        });

        expect([...result.dbNames].sort()).toEqual([OTHER_SCOPE_DB_NAME, SCOPE_DB_NAME]);
        expect(await readBrowserALRuntimeEntryKeys(targetPrefix)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(targetPrefix, OTHER_SCOPE_DB_NAME)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(otherPrefix)).toEqual([`${otherPrefix}:other`]);
    });

    it('purges the current scope\'s database only where the browser cannot list its databases', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        hideIndexedDbDatabaseListing();
        const sessionId = `unlisted-purge-${crypto.randomUUID()}`;
        const sentPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId));
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'first');
        configureBrowserALRuntimeStores(sessionId, { scope: OTHER_SCOPE, diagnosticsPorts });
        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'second');

        const result = await deleteBrowserALRuntimeEntriesForSession(sessionId, {
            currentScope: OTHER_SCOPE,
            storage: diagnosticsPorts.storage
        });

        expect(result.dbNames).toEqual([OTHER_SCOPE_DB_NAME]);
        expect(await readBrowserALRuntimeEntryKeys(sentPrefix, OTHER_SCOPE_DB_NAME)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([`${sentPrefix}:first`]);
    });

    it('leaves the legacy database and its rows where they are', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const sessionId = `legacy-${crypto.randomUUID()}`;
        const legacyKey = `${toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId))}:legacy`;
        const legacyDb = await openIndexedDbAdmissionDatabase({
            dbName: LEGACY_DB_NAME,
            storeName: BROWSER_AL_RUNTIME_STORE_NAME,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        legacyDb.close();
        const legacyRow = { key: legacyKey, value: { msgId: 'legacy' }, expireAtTimestamp: 1, writeToken: 'legacy', revision: 1 };
        await putRawBrowserALRuntimeEntry(legacyRow, LEGACY_DB_NAME);
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'scoped');

        await deleteBrowserALRuntimeEntriesForSession(sessionId, {
            currentScope: SCOPE,
            storage: diagnosticsPorts.storage
        });
        await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });

        expect(await readIndexedDbDatabaseNames()).toEqual([LEGACY_DB_NAME, SCOPE_DB_NAME]);
        expect(await readBrowserALRuntimeEntry(legacyKey, LEGACY_DB_NAME)).toEqual(legacyRow);
    });

    it('sweeps every scope\'s database before it reports the first failure', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const sessionId = `failing-scope-${crypto.randomUUID()}`;
        const sentPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId));
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
        await resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore.ready();
        await putRawBrowserALRuntimeEntry({ key: `${sentPrefix}:corrupt`, value: { msgId: 'corrupt' } });
        configureBrowserALRuntimeStores(sessionId, {
            scope: OTHER_SCOPE,
            retention: { sentMessageTtlMs: 20, controlHistoryTtlMs: 20, msgOwnerTtlMs: 20 },
            diagnosticsPorts
        });
        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'expired');
        await vi.advanceTimersByTimeAsync(21);

        await expect(
            deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
                currentScope: SCOPE,
                storage: diagnosticsPorts.storage
            })
        ).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        expect(await readBrowserALRuntimeEntryKeys(sentPrefix, OTHER_SCOPE_DB_NAME)).toEqual([]);
        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([`${sentPrefix}:corrupt`]);
    });

    it('does not delete a generic persistence row refreshed after cleanup reads it', async () => {
        const sessionId = `cleanup-race-${crypto.randomUUID()}`;
        const keyPrefix = `${toBrowserALRuntimeEntryKeyPrefix(toBrowserSessionALInboundRuntimeStoreId(sessionId))}inbound:admission`;
        const key = `${keyPrefix}:refreshed`;
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
        await resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore.ready();
        await putRawBrowserALRuntimeEntry({
            key,
            value: { value: 'expired' },
            expireAtTimestamp: 1,
            writeToken: 'initial',
            revision: 1
        });
        const originalTransaction = IDBDatabase.prototype.transaction;
        let injectedRefresh = false;
        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
            this: IDBDatabase,
            storeNames: string | Iterable<string>,
            mode?: IDBTransactionMode,
            options?: IDBTransactionOptions
        ) {
            if (mode === 'readwrite' && !injectedRefresh) {
                injectedRefresh = true;
                originalTransaction.call(this, storeNames, 'readwrite', options)
                    .objectStore(BROWSER_AL_RUNTIME_STORE_NAME)
                    .put({
                        key,
                        value: { value: 'refreshed' },
                        expireAtTimestamp: Date.now() + 60_000,
                        writeToken: 'concurrent-refresh',
                        revision: 2
                    });
            }
            return originalTransaction.call(this, storeNames, mode, options);
        });

        await expect(
            deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
                nowMs: 100,
                currentScope: SCOPE,
                storage: diagnosticsPorts.storage
            })
        ).rejects.toThrow('cleanup conflicted');

        expect(await readBrowserALRuntimeEntry(key)).toMatchObject({
            key,
            value: { value: 'refreshed' },
            writeToken: 'concurrent-refresh'
        });
    });

    it('initialises repeated browser AL runtime expiry eviction over every scope\'s database', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const retention = {
            sentMessageTtlMs: 20,
            controlHistoryTtlMs: 20,
            msgOwnerTtlMs: 20
        };
        const runtimeName = `interval-runtime-${crypto.randomUUID()}`;
        const admissionStore = createBrowserALOutboundRuntimeStores(runtimeName, { dbName: SCOPE_DB_NAME, retention }).admissionStore;
        const otherScopeAdmissionStore = createBrowserALOutboundRuntimeStores(runtimeName, {
            dbName: OTHER_SCOPE_DB_NAME,
            retention
        }).admissionStore;
        const sentPrefix = toBrowserOutboundSentPrefix(runtimeName);

        await persistSentMessage(admissionStore, 'initial-expired');
        await persistSentMessage(otherScopeAdmissionStore, 'other-scope-expired');
        await vi.advanceTimersByTimeAsync(21);

        const stop = await initBrowserALRuntimeExpiryEviction({
            currentScope: SCOPE,
            storage: diagnosticsPorts.storage,
            intervalMs: 50
        });
        try {
            expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([]);
            expect(await readBrowserALRuntimeEntryKeys(sentPrefix, OTHER_SCOPE_DB_NAME)).toEqual([]);

            await persistSentMessage(admissionStore, 'interval-expired');
            await vi.advanceTimersByTimeAsync(21);
            expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([
                `${sentPrefix}:interval-expired`
            ]);

            await vi.advanceTimersByTimeAsync(29);
            await vi.waitFor(async () => expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([]));
        }
        finally {
            stop();
        }
    });

    it('routes IndexedDB operations to the configured observer', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const sessionId = `observer-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, {
            scope: SCOPE,
            diagnosticsPorts: {
                submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
                transportFaultPort: createPassThroughTransportFaultPort(),
                indexedDbOperationObserver: observer,
                outboundDiagnostics: createPassThroughALOutboundRuntimeDiagnosticsSink(),
                inboundDiagnostics: createPassThroughALInboundRuntimeDiagnosticsSink(),
                storage: () => {}
            }
        });
        const stores = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
        await stores.admissionStore.ready();
        await stores.admissionStore.readSentMessage('never-persisted');

        expect(observer.getCounts().total).toBeGreaterThan(0);
    });

    // Each store states its reset and its health under its own id, and every resolve of it shares one health.
    it('names each store on the reset and the health it states through the storage port', async () => {
        const seeded = await openIndexedDbAdmissionDatabase({
            dbName: SCOPE_DB_NAME,
            storeName: BROWSER_AL_RUNTIME_STORE_NAME,
            schemaId: 'rallar-alm-previous',
            onStorageReset: () => {}
        });
        seeded.close();
        const events: ALStorageEvent[] = [];
        const sessionId = `storage-port-${crypto.randomUUID()}`;
        const wsClientId = toBrowserWsClientALRuntimeStoreId(sessionId);
        configureBrowserALRuntimeStores(sessionId, {
            scope: SCOPE,
            diagnosticsPorts: toRallarDiagnosticsPorts({ storage: (event) => events.push(event) })
        });
        const stores = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);

        await stores.admissionStore.ready();
        expect(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).storageHealth).toBe(stores.storageHealth);
        expect(resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId).storageHealth).not.toBe(stores.storageHealth);
        stores.storageHealth?.recordFailure({ cause: 'quota', detail: 'QuotaExceededError: full' });

        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(events).toEqual([
            {
                kind: 'reset',
                storeId: wsClientId,
                event: {
                    dbName: SCOPE_DB_NAME,
                    previousSchemaId: 'rallar-alm-previous',
                    schemaId: AL_ADMISSION_SCHEMA_ID,
                    reason: 'schema-id-mismatch'
                }
            },
            {
                kind: 'health',
                storeId: wsClientId,
                status: 'failing',
                lastFailure: { cause: 'quota', detail: 'QuotaExceededError: full' },
                lastRecoveryPointAtMs: undefined
            }
        ]);
    });

    it('gives every carrier a fresh, empty memory pair that shares nothing with IndexedDB', async () => {
        const first = createBrowserALVolatileOutboundRuntimeStores('browser-ws-client:session-1', createDefaultVolatileSessionBudget());
        const second = createBrowserALVolatileOutboundRuntimeStores('browser-ws-client:session-1', createDefaultVolatileSessionBudget());

        expect(first.workQueue).toBeInstanceOf(InMemoryQueueBox);
        expect(second.workQueue).not.toBe(first.workQueue);
        expect(await second.workQueue.getAllKeys()).toEqual([]);
    });

    it('carries the one session budget it is handed on every memory pair (C3)', () => {
        const budget = new ALVolatileSessionBudget({
            maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        });
        const outbound = createBrowserALVolatileOutboundRuntimeStores(
            'browser-ws-client:session-budget',
            budget
        );
        const overlay = createBrowserALVolatileOutboundRuntimeStores(
            'browser-rtc-overlay:session-budget',
            budget
        );
        const inbound = createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId('session-budget'),
            budget
        );

        expect(outbound.budget).toBe(budget);
        expect(overlay.budget).toBe(budget);
        expect(inbound.budget).toBe(budget);
    });

    it('keeps the session inbound memory pair out of IndexedDB, so session cleanup never reaches it', async () => {
        const sessionId = `inbound-memory-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
        const volatile = createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(sessionId),
            createDefaultVolatileSessionBudget()
        );
        const message = createOutboundUnicastMessage('inbound-memory');
        await volatile.workQueue.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox'));

        expect(volatile.workQueue).toBeInstanceOf(InMemoryQueueBox);
        expect(volatile.admissionStore.namespace).toBe(
            `browser:${toBrowserSessionALInboundRuntimeStoreId(sessionId)}:volatile:inbound:admission`
        );
        await deleteBrowserALRuntimeEntriesForSession(sessionId, { currentScope: SCOPE, storage: diagnosticsPorts.storage });
        expect(await volatile.workQueue.getAllKeys()).toHaveLength(1);
    });
});

async function readSentMessageIds(
    admissionStore: ALOutboundAdmissionStore<ALOutboundTransportMessage>
): Promise<readonly string[]> {
    const prefix = `${admissionStore.namespace}:sent:`;
    const keys = await readBrowserALRuntimeEntryKeys(prefix);
    const snapshots = await Promise.all(keys.map((key) => admissionStore.readSentMessage(key.slice(prefix.length))));
    return snapshots.filter((snapshot) => snapshot !== undefined).map((snapshot) => snapshot.msgId).sort();
}

async function persistSentMessage(
    admissionStore: ALOutboundAdmissionStore<ALOutboundTransportMessage>,
    msgId: string
): Promise<void> {
    const snapshot = createSentSnapshot(msgId);
    const bundle = await computeOutboundTestAdmission(admissionStore, snapshot.msg);
    const status = await admissionStore.commitBundle(bundle);

    if (status !== 'committed') {
        throw new Error(`Failed to persist sent message ${msgId}`);
    }
}

function createSentSnapshot(msgId: string): ALOutboundSentMessageSnapshot {
    const msg = createOutboundUnicastMessage(msgId);
    return {
        msgId,
        msg: { ...msg, id: { ...msg.id, msgId } },
        outboxKey: null,
        supersedenceKey: null
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
        },
        { ttlMs: 20 }
    );
}

function toBrowserOutboundSentPrefix(runtimeStoreName: string): string {
    return `${toBrowserALRuntimeEntryKeyPrefix(runtimeStoreName)}outbound:admission:sent`;
}

async function readBrowserALRuntimeEntryKeys(
    keyPrefix: string,
    dbName = SCOPE_DB_NAME
): Promise<readonly string[]> {
    const db = await openBrowserALRuntimeDatabase(dbName);

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

async function putRawBrowserALRuntimeEntry(entry: object, dbName = SCOPE_DB_NAME): Promise<void> {
    const db = await openBrowserALRuntimeDatabase(dbName);
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(BROWSER_AL_RUNTIME_STORE_NAME, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB raw write aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB raw write failed'));
            tx.objectStore(BROWSER_AL_RUNTIME_STORE_NAME).put(entry);
        });
    }
    finally {
        db.close();
    }
}

async function readBrowserALRuntimeEntry(key: string, dbName = SCOPE_DB_NAME): Promise<IDBRequest['result']> {
    const db = await openBrowserALRuntimeDatabase(dbName);
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(BROWSER_AL_RUNTIME_STORE_NAME, 'readonly');
            const request = tx.objectStore(BROWSER_AL_RUNTIME_STORE_NAME).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB raw read failed'));
        });
    }
    finally {
        db.close();
    }
}

async function openBrowserALRuntimeDatabase(dbName: string): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);

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

async function deleteEveryIndexedDbDatabase(): Promise<void> {
    for (const { name } of await indexedDB.databases()) {
        if (name !== undefined) {
            await deleteIndexedDbDatabase(name);
        }
    }
}

async function deleteIndexedDbDatabase(dbName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);

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

/** Hides `indexedDB.databases()`, as a browser without it would, until the suite's `afterEach` shows it again. */
function hideIndexedDbDatabaseListing(): void {
    Object.defineProperty(indexedDB, 'databases', { configurable: true, value: undefined });
}

function showIndexedDbDatabaseListing(): void {
    Reflect.deleteProperty(indexedDB, 'databases');
}

async function readIndexedDbDatabaseNames(): Promise<readonly string[]> {
    const databases = await indexedDB.databases();
    return databases.flatMap(({ name }) => name === undefined ? [] : [name]).sort();
}
