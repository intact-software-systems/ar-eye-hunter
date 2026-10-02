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
    resolveBrowserSessionALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import type { StateScope } from '@shared/api/state-types.ts';

// The two phases share one scope's browser database, so they run in order in one test.
it('names each browser store on the storage port: an eviction as failing health, then a restore', async () => {
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

    const restoredSession = `restored-${crypto.randomUUID()}`;
    configureBrowserALRuntimeStores(restoredSession, { scope, diagnosticsPorts });
    const restored = resolveBrowserSessionALInboundRuntimeStores(restoredSession);
    await restored.admissionStore.ready();
    restored.storageRecovery?.reportFirstBatch(0);

    expect(events).toEqual([
        {
            kind: 'health',
            storeId: toBrowserWsClientALRuntimeStoreId(evictedSession),
            status: 'failing',
            lastFailure: { cause: 'evicted', detail: expect.any(String) },
            lastRecoveryPointAtMs: undefined
        },
        {
            kind: 'recovery',
            storeId: toBrowserSessionALInboundRuntimeStoreId(restoredSession),
            outcome: { kind: 'restored', claimed: 0, expired: 0 }
        }
    ]);
});

async function deleteDatabase(dbName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}
