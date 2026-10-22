import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import { createPSqlAdmissionTestStorage, type PSqlAdmissionTestStorage } from './create-p-sql-admission-test-storage.ts';

const NAMESPACE = 'psql-marker-cap';
const MARKER_CAP = 3;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 22, 12));
});

afterEach(() => {
    vi.useRealTimers();
});

it('keeps the shared server store at its configured marker cap, evicting the oldest, and states the count', async () => {
    const stated: number[] = [];
    const storage = await createPSqlAdmissionTestStorage();
    const fixture = await createCappedServerRuntime(storage, (markers) => stated.push(markers));

    for (let track = 0; track <= MARKER_CAP; track += 1) {
        await admitAtNextMs(fixture, createTrackMessage(track, 1));
    }

    expect(await readMarkerHeld(fixture, 0)).toBe(false);
    expect(await Promise.all([1, 2, 3].map(async (track) => await readMarkerHeld(fixture, track))))
        .toEqual([true, true, true]);
    expect(stated).toEqual([1, 2, 3, MARKER_CAP]);
});

it('still answers every retained marker\'s delivered sequence as completed over PostgreSQL', async () => {
    const storage = await createPSqlAdmissionTestStorage();
    const fixture = await createCappedServerRuntime(storage, undefined);

    for (let track = 0; track <= MARKER_CAP; track += 1) {
        await admitAtNextMs(fixture, createTrackMessage(track, 1));
        await expect.poll(() => fixture.delivered.length).toBe(track + 1);
    }

    const store = fixture.stores.admissionStore;
    for (const track of [1, 2, 3]) {
        expect(await store.readOrderedDelivery(toTrackKey(track), 1)).toEqual({
            completedThrough: 1,
            predecessor: undefined
        });
    }
});

async function createCappedServerRuntime(
    storage: PSqlAdmissionTestStorage,
    reportDeliveredMarkers: ((markers: number) => void) | undefined
): Promise<InboundTestRuntime> {
    const fixture = createInboundTestRuntime({
        stores: createPSqlALInboundRuntimeStores({
            nowMs: Date.now,
            repository: storage.repository,
            namespace: NAMESPACE,
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: undefined,
            maxDeliveredMarkers: MARKER_CAP,
            reportDeliveredMarkers
        }),
        carrier: 'ws',
        effectWorkerId: 'al-inbound:psql-marker-cap'
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

function toTrackKey(track: number): string {
    return toALOrderingTrackKey(createTrackMessage(track, 1))!;
}

/** A store without a track's marker answers its next delivery as needing a resynchronization. */
async function readMarkerHeld(fixture: InboundTestRuntime, track: number): Promise<boolean> {
    const read = await fixture.stores.admissionStore.readOrderedDelivery(toTrackKey(track), 1);
    return read.predecessor === undefined;
}
