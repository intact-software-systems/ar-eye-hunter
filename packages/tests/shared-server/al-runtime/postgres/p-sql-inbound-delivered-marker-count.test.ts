import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { AL_INBOUND_MAX_DELIVERED_MARKERS } from '@shared/alm/inbound/admission/evict-al-inbound-delivered-markers-past-cap.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import { createPSqlAdmissionTestStorage } from './create-p-sql-admission-test-storage.ts';

const TRACK_TTL_MS = 60_000;
/** Past the browser's cap, so a server store that capped its markers would already have evicted one. */
const OPENED_TRACKS = AL_INBOUND_MAX_DELIVERED_MARKERS + 4;
/** Three hundred PGlite admissions, each opening a track, take several seconds under load. */
const CHURN_TIMEOUT_MS = 60_000;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
});

afterEach(() => {
    vi.useRealTimers();
});

it('keeps every marker of the shared server store until its expiry, counts them, and counts none after it', async () => {
    const fixture = await createServerRuntime();
    const store = fixture.stores.admissionStore;

    for (let track = 0; track < OPENED_TRACKS; track += 1) {
        await admitAtNextMs(fixture, createTrackMessage(track, 1));
    }

    expect(await store.readDeliveredMarkerCount(Date.now())).toBe(OPENED_TRACKS);
    expect(await store.readOrderedDelivery(toALOrderingTrackKey(createTrackMessage(0, 1))!, 1))
        .toMatchObject({ predecessor: undefined });
    expect(await store.readDeliveredMarkerCount(Date.now() + TRACK_TTL_MS)).toBe(0);
}, CHURN_TIMEOUT_MS);

async function createServerRuntime(): Promise<InboundTestRuntime> {
    const { repository } = await createPSqlAdmissionTestStorage();
    const fixture = createInboundTestRuntime({
        stores: createPSqlALInboundRuntimeStores({
            nowMs: Date.now,
            repository,
            namespace: 'psql-marker-count',
            orderingTrackTtlMs: TRACK_TTL_MS,
            supersedenceTrackTtlMs: TRACK_TTL_MS,
            retention: undefined
        }),
        carrier: 'ws',
        effectWorkerId: 'al-inbound:psql-marker-count'
    });
    await fixture.runtime.ready();
    return fixture;
}

async function admitAtNextMs(fixture: InboundTestRuntime, message: ALMessage): Promise<void> {
    vi.setSystemTime(Date.now() + 1);
    expect((await fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right).toEqual({
        kind: 'admitted'
    });
}

function createTrackMessage(track: number, seq: number): ALMessage {
    const message = createInboundTestMessage({ msgId: `track-${track}-${seq}`, seq });
    return { ...message, ordering: { orderingKey: `track-${track}`, seq } };
}
