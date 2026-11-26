import { expect } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';

import { readInboundTestAdmission } from '../../../../shared/alm/inbound-runtime-test-fixture.ts';
import type { PostgresSql } from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

/** An inbound admission store over `sql` in `namespace`, as the server composes one; stores of one namespace share rows. */
export function createPostgresInboundAdmissionStore(sql: PostgresSql, namespace: string): ALInboundAdmissionStore {
    return createALInboundAdmissionStore({
        nowMs: Date.now,
        namespace,
        backend: new PSqlAdmissionWorkBackend({ sql, namespace, nowMs: Date.now }),
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        maxOrderingTracks: undefined,
        maxDeliveredMarkers: undefined
    });
}

/** Admits `message` through the store's real read and bundle, and requires its write to commit. */
export async function admitPostgresInboundTestMessage(store: ALInboundAdmissionStore, message: ALMessage): Promise<void> {
    expect(await store.commitBundle(await readInboundTestAdmission(store, message))).toBe('committed');
}
