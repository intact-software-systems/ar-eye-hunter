import 'fake-indexeddb/auto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { AL_INBOUND_MAX_ORDERING_TRACKS } from '@shared/alm/inbound/admission/al-inbound-ordering-track-cap.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    readInboundTestDecisionSurface,
    type InboundTestRuntime,
    type InboundTestStorage
} from '../inbound-runtime-test-fixture.ts';

const START_MS = Date.UTC(2026, 9, 8, 12);
const NAMESPACE = 'ordering-cap';
const ORDERING_PREFIX = `${NAMESPACE}:ordering:`;
const DELIVERED_PREFIX = `${NAMESPACE}:delivered:`;
const CHURNED_TRACKS = 300;
/** Three hundred IndexedDB admissions, each opening a track, take about five seconds under a loaded machine. */
const CHURN_TIMEOUT_MS = 30_000;

interface OrderingCapFixture {
    readonly backend: ALAdmissionWorkBackend;
    readonly inbound: InboundTestRuntime;
}

describe('the inbound store\'s ordering tracks', () => {
    it('holds every track up to the cap', async () => {
        const fixture = await createOrderingCapFixture('memory');

        await admitFirstSequences(fixture, AL_INBOUND_MAX_ORDERING_TRACKS);

        expect(await readHeldTracks(fixture.backend)).toHaveLength(AL_INBOUND_MAX_ORDERING_TRACKS);
    });

    it('evicts the least recently updated track, not the first opened, for the next new track', async () => {
        const fixture = await createOrderingCapFixture('memory');
        await admitFirstSequences(fixture, AL_INBOUND_MAX_ORDERING_TRACKS);
        await admitAtNextMs(fixture, createTrackMessage(0, 2));

        await admitAtNextMs(fixture, createTrackMessage(AL_INBOUND_MAX_ORDERING_TRACKS, 1));

        const held = await readHeldTracks(fixture.backend);
        expect(held).toHaveLength(AL_INBOUND_MAX_ORDERING_TRACKS);
        expect(held).toContain('track-0');
        expect(held).not.toContain('track-1');
        expect(held).toContain(`track-${AL_INBOUND_MAX_ORDERING_TRACKS}`);
    });

    it('reads the evicted track\'s next arrival as a fresh track\'s first one', async () => {
        const fixture = await createOrderingCapFixture('memory');
        await admitFirstSequences(fixture, AL_INBOUND_MAX_ORDERING_TRACKS + 1);

        const evicted = await readOrderingObservation(fixture, createTrackMessage(0, 2));
        const fresh = await readOrderingObservation(fixture, createTrackMessage(AL_INBOUND_MAX_ORDERING_TRACKS + 1, 2));
        const held = await readOrderingObservation(fixture, createTrackMessage(1, 2));

        expect(evicted).toMatchObject({ status: 'gap', expectedSeq: 1, missingRanges: [{ from: 1, to: 1 }] });
        expect({ ...evicted, trackKey: undefined }).toEqual({ ...fresh, trackKey: undefined });
        expect(held).toMatchObject({ status: 'in-order', expectedSeq: 3 });
    });

    it('keeps a track a same-millisecond update reached after the eviction read it', async () => {
        const fixture = await createOrderingCapFixture('memory');
        await admitFirstSequences(fixture, AL_INBOUND_MAX_ORDERING_TRACKS);
        const sharedMs = START_MS + 1;
        const readWithin = fixture.backend.readWithin.bind(fixture.backend);
        let interleaved = false;
        vi.spyOn(fixture.backend, 'readWithin').mockImplementation(async (read) => {
            const result = await readWithin(read);
            if (!interleaved && Array.isArray(result) && result.length > AL_INBOUND_MAX_ORDERING_TRACKS) {
                interleaved = true;
                const openedAtMs = Date.now();
                vi.setSystemTime(sharedMs);
                await fixture.inbound.runtime.admitIncomingMessage(createTrackMessage(0, 2), INBOUND_TEST_SOURCE);
                vi.setSystemTime(openedAtMs);
            }
            return result;
        });

        await admitAtNextMs(fixture, createTrackMessage(AL_INBOUND_MAX_ORDERING_TRACKS, 1));

        expect(interleaved).toBe(true);
        expect(await readHeldTracks(fixture.backend)).toContain('track-0');
        expect(await readOrderingObservation(fixture, createTrackMessage(0, 3)))
            .toMatchObject({ status: 'in-order', expectedSeq: 4 });
    });

    it('counts a snapshot a rival pass already removed as gone, so the count never reads past the cap', async () => {
        const stated: number[] = [];
        const fixture = await createOrderingCapFixture('memory', (tracks) => stated.push(tracks));
        await admitFirstSequences(fixture, AL_INBOUND_MAX_ORDERING_TRACKS);
        const oldest = (await fixture.backend.list(ORDERING_PREFIX, (value) => value))
            .find((entry) => entry.key.slice(ORDERING_PREFIX.length).split(':')[0] === 'track-0')!;
        const readWithin = fixture.backend.readWithin.bind(fixture.backend);
        let removedByRival = false;
        vi.spyOn(fixture.backend, 'readWithin').mockImplementation(async (read) => {
            const result = await readWithin(read);
            if (!removedByRival && Array.isArray(result) && result.length > AL_INBOUND_MAX_ORDERING_TRACKS) {
                removedByRival = true;
                await fixture.backend.write(async (transaction) => {
                    await transaction.remove(oldest.key);
                });
            }
            return result;
        });
        stated.length = 0;

        await admitAtNextMs(fixture, createTrackMessage(AL_INBOUND_MAX_ORDERING_TRACKS, 1));

        expect(removedByRival).toBe(true);
        expect(stated).toEqual([AL_INBOUND_MAX_ORDERING_TRACKS]);
        expect(await readHeldTracks(fixture.backend)).toHaveLength(AL_INBOUND_MAX_ORDERING_TRACKS);
    });

    it('keeps the evicted track\'s delivered marker', async () => {
        const fixture = await createOrderingCapFixture('memory');
        const trackKey = toALOrderingTrackKey(createTrackMessage(0, 1))!;
        await admitAtNextMs(fixture, createTrackMessage(0, 1));
        await expect.poll(async () => (await fixture.inbound.stores.admissionStore.readOrderedDelivery(trackKey, 2)).completedThrough)
            .toBe(1);

        await admitFirstSequences(fixture, AL_INBOUND_MAX_ORDERING_TRACKS + 1, 1);

        expect(await readHeldTracks(fixture.backend)).not.toContain('track-0');
        expect(await readDeliveredTracks(fixture.backend)).toContain(trackKey);
    });

    it('reads a gap\'s release on an evicted track as resync-required', async () => {
        const fixture = await createOrderingCapFixture('memory');
        const trackKey = toALOrderingTrackKey(createTrackMessage(0, 1))!;
        const store = fixture.inbound.stores.admissionStore;
        await admitAtNextMs(fixture, createTrackMessage(0, 1));
        await expect.poll(async () => (await fixture.inbound.stores.admissionStore.readOrderedDelivery(trackKey, 2)).completedThrough)
            .toBe(1);
        await admitAtNextMs(fixture, createTrackMessage(0, 3));
        expect(await store.readOrderedDelivery(trackKey, 3)).toEqual({
            completedThrough: 1,
            predecessor: { kind: 'effect' }
        });

        await admitFirstSequences(fixture, AL_INBOUND_MAX_ORDERING_TRACKS + 1, 1);

        expect(await readHeldTracks(fixture.backend)).not.toContain('track-0');
        expect(await store.readOrderedDelivery(trackKey, 3)).toEqual({
            completedThrough: 1,
            predecessor: { kind: 'resync-required' }
        });
    });

    it('states how many snapshots it holds after each new track\'s eviction pass, and nothing for a known track', async () => {
        const stated: number[] = [];
        const fixture = await createOrderingCapFixture('memory', (tracks) => stated.push(tracks));

        await admitFirstSequences(fixture, AL_INBOUND_MAX_ORDERING_TRACKS + 2);
        await admitAtNextMs(fixture, createTrackMessage(AL_INBOUND_MAX_ORDERING_TRACKS + 1, 2));

        expect(stated).toHaveLength(AL_INBOUND_MAX_ORDERING_TRACKS + 2);
        expect(stated.slice(0, 3)).toEqual([1, 2, 3]);
        expect(stated.slice(-3)).toEqual([256, 256, 256]);
    });
});

describe.each<InboundTestStorage>(['memory', 'indexeddb'])('the %s inbound pair under track churn', (storage) => {
    it('stays at the cap, and states it, after one sender opens 300 tracks of one message each', async () => {
        const stated: number[] = [];
        const fixture = await createOrderingCapFixture(storage, (tracks) => stated.push(tracks));

        await admitFirstSequences(fixture, CHURNED_TRACKS);

        const held = await readHeldTracks(fixture.backend);
        expect(held).toHaveLength(AL_INBOUND_MAX_ORDERING_TRACKS);
        expect(stated.at(-1)).toBe(AL_INBOUND_MAX_ORDERING_TRACKS);
        expect(held).toContain(`track-${CHURNED_TRACKS - 1}`);
        expect(held).not.toContain(`track-${CHURNED_TRACKS - AL_INBOUND_MAX_ORDERING_TRACKS - 1}`);
    }, CHURN_TIMEOUT_MS);
});

async function createOrderingCapFixture(
    storage: InboundTestStorage,
    reportOrderingTracks?: (tracks: number) => void
): Promise<OrderingCapFixture> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START_MS);
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const { backend, stores } = createInboundTestBackendStores({
        namespace: NAMESPACE,
        storage,
        observer: createPassThroughIndexedDbOperationObserver(),
        reportOrderingTracks
    });
    const inbound = createInboundTestRuntime({ carrier: 'ws', stores, effectWorkerId: 'al-inbound:ordering-cap' });
    await inbound.runtime.ready();
    return { backend, inbound };
}

/** One first sequence on each of `count` tracks, a millisecond apart, so each track's update time is its own. */
async function admitFirstSequences(fixture: OrderingCapFixture, count: number, first = 0): Promise<void> {
    for (let track = first; track < first + count; track += 1) {
        await admitAtNextMs(fixture, createTrackMessage(track, 1));
    }
}

async function admitAtNextMs(fixture: OrderingCapFixture, message: ALMessage): Promise<void> {
    vi.setSystemTime(Date.now() + 1);
    expect((await fixture.inbound.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
        .toEqual({ kind: 'admitted' });
}

function createTrackMessage(track: number, seq: number): ALMessage {
    const message = createInboundTestMessage({ msgId: `track-${track}-${seq}`, seq });
    return { ...message, ordering: { orderingKey: `track-${track}`, seq } };
}

/** The ordering key of every track the store holds a snapshot for. */
async function readHeldTracks(backend: ALAdmissionWorkBackend): Promise<readonly string[]> {
    const held = await backend.list(ORDERING_PREFIX, (value) => value);
    return held.map((entry) => entry.key.slice(ORDERING_PREFIX.length).split(':')[0]);
}

/** The track key of every ordered delivery marker the store holds. */
async function readDeliveredTracks(backend: ALAdmissionWorkBackend): Promise<readonly string[]> {
    const held = await backend.list(DELIVERED_PREFIX, (value) => value);
    return held.map((entry) => entry.key.slice(DELIVERED_PREFIX.length));
}

async function readOrderingObservation(fixture: OrderingCapFixture, message: ALMessage) {
    const read = await readInboundTestDecisionSurface(fixture.inbound.stores.admissionStore, message);
    return computeALInboundPlanningObservations(read).orderingObservation;
}
