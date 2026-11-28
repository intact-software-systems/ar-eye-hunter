import { expect } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';

import {
    readInboundTestAdmission,
    type InboundTestBackendStores
} from '../../../../shared/alm/inbound-runtime-test-fixture.ts';

/** The inbound runtime's store pair over `sql` in `namespace`, and the backend it is built over, as the server composes them. */
export function createPostgresInboundBackendStores(sql: PSqlSql, namespace: string): InboundTestBackendStores {
    const backend = new PSqlAdmissionWorkBackend({ sql, namespace, nowMs: Date.now });
    return {
        backend,
        stores: {
            admissionStore: createALInboundAdmissionStore({
                nowMs: Date.now,
                namespace,
                backend,
                orderingTrackTtlMs: 60_000,
                supersedenceTrackTtlMs: 60_000,
                retention: normalizeALRuntimeStoreRetention(),
                maxOrderingTracks: undefined,
                maxDeliveredMarkers: undefined
            }),
            workQueue: backend.workQueue
        }
    };
}

/** The inbound runtime's store pair over `sql` in `namespace`, as the server composes it; pairs of one namespace share rows. */
export function createPostgresInboundRuntimeStores(sql: PSqlSql, namespace: string): ALInboundRuntimeStores {
    return createPostgresInboundBackendStores(sql, namespace).stores;
}

/** An inbound admission store over `sql` in `namespace`, as the server composes one; stores of one namespace share rows. */
export function createPostgresInboundAdmissionStore(sql: PSqlSql, namespace: string): ALInboundAdmissionStore {
    return createPostgresInboundRuntimeStores(sql, namespace).admissionStore;
}

/** Admits `message` through the store's real read and bundle, and requires its write to commit. */
export async function admitPostgresInboundTestMessage(store: ALInboundAdmissionStore, message: ALMessage): Promise<void> {
    expect(await store.commitBundle(await readInboundTestAdmission(store, message))).toBe('committed');
}
