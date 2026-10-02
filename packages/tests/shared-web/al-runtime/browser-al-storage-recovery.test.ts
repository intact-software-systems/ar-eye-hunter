// @vitest-environment happy-dom
import '../../setup-browser-indexeddb.ts';

import { expect, it } from 'vitest';

import {
    BROWSER_AL_RUNTIME_STORE_NAME,
    toBrowserALRuntimeDbName,
    toBrowserSessionALInboundRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import type { ALStorageEvent, ALStorageRecoveryOutcome } from '@shared/alm/storage/al-storage-event.ts';
import type { StateScope } from '@shared/api/state-types.ts';

// The phases share one scope's browser database, so they run in order in one test.
it('names each browser store on the storage port: an eviction as failing health for each store of its connect, then a restore', async () => {
    const scope: StateScope = { applicationId: 'recovery-app', workspaceId: crypto.randomUUID() };
    const dbName = toBrowserALRuntimeDbName(scope);
    const events: ALStorageEvent[] = [];
    const diagnosticsPorts = toRallarDiagnosticsPorts({ storage: (event) => events.push(event) });
    (await openIndexedDbAdmissionDatabase({
        dbName,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    })).close();
    await deleteDatabase(dbName);

    const evictedSession = `evicted-${crypto.randomUUID()}`;
    configureBrowserALRuntimeStores(evictedSession, { scope, diagnosticsPorts });
    const evicted = resolveBrowserWsClientALOutboundRuntimeStores(evictedSession);
    await evicted.admissionStore.ready();
    evicted.storageRecovery?.reportFirstBatch(0);
    const evictedInbound = resolveBrowserSessionALInboundRuntimeStores(evictedSession);
    await evictedInbound.admissionStore.ready();
    evictedInbound.createStorageRecovery?.({ name: 'ws', workTypeId: 'unused' }).reportFirstBatch(0);

    const laterSession = `later-${crypto.randomUUID()}`;
    configureBrowserALRuntimeStores(laterSession, { scope, diagnosticsPorts });
    const later = resolveBrowserSessionALInboundRuntimeStores(laterSession);
    await later.admissionStore.ready();
    later.createStorageRecovery?.({ name: 'ws', workTypeId: 'unused' }).reportFirstBatch(0);

    configureBrowserALRuntimeStores(evictedSession, { scope, diagnosticsPorts });
    const restored = resolveBrowserWsClientALOutboundRuntimeStores(evictedSession);
    await restored.admissionStore.ready();
    restored.storageRecovery?.reportFirstBatch(0);

    expect(events).toEqual([
        toEvictedHealthEvent(toBrowserWsClientALRuntimeStoreId(evictedSession)),
        toEvictedHealthEvent(toBrowserSessionALInboundRuntimeStoreId(evictedSession)),
        {
            kind: 'recovery',
            storeId: `${toBrowserSessionALInboundRuntimeStoreId(laterSession)}/ws`,
            outcome: { kind: 'restored', claimed: 0, expired: 0 }
        },
        {
            kind: 'recovery',
            storeId: toBrowserWsClientALRuntimeStoreId(evictedSession),
            outcome: { kind: 'restored', claimed: 0, expired: 0 }
        }
    ]);
});

// A creation is the fact of the connect that found it: a later session of the document reads the database as it is.
it('reports restored for each store of a later session after an earlier session created the database', async () => {
    const scope: StateScope = { applicationId: 'recovery-app', workspaceId: crypto.randomUUID() };
    await openSessionStores(scope, `first-${crypto.randomUUID()}`);

    const outcomes = await openSessionStores(scope, `later-${crypto.randomUUID()}`);

    expect(outcomes).toEqual([
        ['browser-session-inbound/ws', { kind: 'restored', claimed: 0, expired: 0 }],
        ['browser-ws-client', { kind: 'restored', claimed: 0, expired: 0 }],
        ['browser-rtc-overlay', { kind: 'restored', claimed: 0, expired: 0 }]
    ]);
});

// The three stores of a session share one database: the open that created it is not the only store it is new to.
it('reports storage-created for each store of a session whose connect created the database', async () => {
    const scope: StateScope = { applicationId: 'recovery-app', workspaceId: crypto.randomUUID() };

    const outcomes = await openSessionStores(scope, `created-${crypto.randomUUID()}`);

    expect(outcomes).toEqual([
        ['browser-session-inbound/ws', { kind: 'storage-created' }],
        ['browser-ws-client', { kind: 'storage-created' }],
        ['browser-rtc-overlay', { kind: 'storage-created' }]
    ]);
});

it('reports storage-reset for each store of a session whose connect reset the database', async () => {
    const scope: StateScope = { applicationId: 'recovery-app', workspaceId: crypto.randomUUID() };
    (await openIndexedDbAdmissionDatabase({
        dbName: toBrowserALRuntimeDbName(scope),
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        schemaId: 'an-older-schema',
        onStorageReset: () => {}
    })).close();

    const outcomes = await openSessionStores(scope, `reset-${crypto.randomUUID()}`);

    expect(outcomes).toEqual([
        ['browser-session-inbound/ws', { kind: 'storage-reset', reason: 'schema-id-mismatch' }],
        ['browser-ws-client', { kind: 'storage-reset', reason: 'schema-id-mismatch' }],
        ['browser-rtc-overlay', { kind: 'storage-reset', reason: 'schema-id-mismatch' }]
    ]);
});

async function openSessionStores(
    scope: StateScope,
    sessionId: string
): Promise<readonly (readonly [string, ALStorageRecoveryOutcome])[]> {
    const events: ALStorageEvent[] = [];
    configureBrowserALRuntimeStores(sessionId, {
        scope,
        diagnosticsPorts: toRallarDiagnosticsPorts({ storage: (event) => events.push(event) })
    });
    const inbound = resolveBrowserSessionALInboundRuntimeStores(sessionId);
    const wsClient = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
    const rtcOverlay = resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId);
    for (const stores of [inbound, wsClient, rtcOverlay]) {
        await stores.admissionStore.ready();
    }
    inbound.createStorageRecovery?.({ name: 'ws', workTypeId: 'unused' }).reportFirstBatch(0);
    for (const stores of [wsClient, rtcOverlay]) {
        stores.storageRecovery?.reportFirstBatch(0);
    }
    return events.flatMap((event) => event.kind === 'recovery' ? [[event.storeId.replace(`:${sessionId}`, ''), event.outcome] as const] : []);
}

function toEvictedHealthEvent(storeId: string): ALStorageEvent {
    return {
        kind: 'health',
        storeId,
        status: 'failing',
        lastFailure: { cause: 'evicted', detail: expect.any(String) },
        lastRecoveryPointAtMs: undefined
    };
}

async function deleteDatabase(dbName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}
