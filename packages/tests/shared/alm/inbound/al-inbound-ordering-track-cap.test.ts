import 'fake-indexeddb/auto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { AL_INBOUND_MAX_ORDERING_TRACKS } from '@shared/alm/inbound/al-inbound-admission-store.ts';
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
});

describe.each<InboundTestStorage>(['memory', 'indexeddb'])('the %s inbound pair under track churn', (storage) => {
    it('stays at the cap after one sender opens 300 tracks of one message each', async () => {
        const fixture = await createOrderingCapFixture(storage);

        await admitFirstSequences(fixture, CHURNED_TRACKS);

        const held = await readHeldTracks(fixture.backend);
        expect(held).toHaveLength(AL_INBOUND_MAX_ORDERING_TRACKS);
        expect(held).toContain(`track-${CHURNED_TRACKS - 1}`);
        expect(held).not.toContain(`track-${CHURNED_TRACKS - AL_INBOUND_MAX_ORDERING_TRACKS - 1}`);
    }, CHURN_TIMEOUT_MS);
});

async function createOrderingCapFixture(storage: InboundTestStorage): Promise<OrderingCapFixture> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START_MS);
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const { backend, stores } = createInboundTestBackendStores({
        namespace: NAMESPACE,
        storage,
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const inbound = createInboundTestRuntime({ carrier: 'ws', stores, effectWorkerId: 'al-inbound:ordering-cap' });
    await inbound.runtime.ready();
    return { backend, inbound };
}

/** One first sequence on each of `count` tracks, a millisecond apart, so each track's update time is its own. */
async function admitFirstSequences(fixture: OrderingCapFixture, count: number): Promise<void> {
    for (let track = 0; track < count; track += 1) {
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

async function readOrderingObservation(fixture: OrderingCapFixture, message: ALMessage) {
    const read = await readInboundTestDecisionSurface(fixture.inbound.stores.admissionStore, message);
    return computeALInboundPlanningObservations(read).orderingObservation;
}
