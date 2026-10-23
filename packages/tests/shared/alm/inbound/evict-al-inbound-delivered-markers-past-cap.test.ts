import 'fake-indexeddb/auto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { AL_INBOUND_MAX_DELIVERED_MARKERS } from '@shared/alm/inbound/admission/evict-al-inbound-delivered-markers-past-cap.ts';
import { AL_INBOUND_MAX_ORDERING_TRACKS } from '@shared/alm/inbound/admission/evict-al-inbound-ordering-tracks-past-cap.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime,
    type InboundTestStorage
} from '../inbound-runtime-test-fixture.ts';

const START_MS = Date.UTC(2026, 9, 22, 12);
const NAMESPACE = 'marker-cap';
const DELIVERED_PREFIX = `${NAMESPACE}:delivered:`;
const ORDERING_PREFIX = `${NAMESPACE}:ordering:`;
const CHURNED_TRACKS = 300;
const OTHER_SENDER = 'other-sender';
/** The fixture store's ordering-track TTL, which every admission moves a marker's expiry past. */
const MARKER_TRACK_TTL_MS = 60_000;
/** Three hundred IndexedDB admissions, each opening a track, take about five seconds under a loaded machine. */
const CHURN_TIMEOUT_MS = 30_000;
/** The rounds that deliver the cap's first sequences run 16 a round. */
const DELIVERY_TIMEOUT_MS = 10_000;

interface MarkerCapFixture {
    readonly backend: ALAdmissionWorkBackend;
    readonly inbound: InboundTestRuntime;
}

interface MarkerCapFixtureInput {
    readonly storage: InboundTestStorage;
    readonly reportDeliveredMarkers?: (markers: number) => void;
    /** Absent, the store keeps every ordering snapshot, so only the marker cap removes anything. */
    readonly maxOrderingTracks?: number;
}

describe('the inbound store\'s delivered markers', () => {
    it('holds every marker up to the cap', async () => {
        const fixture = await createMarkerCapFixture({ storage: 'memory' });

        await admitFirstSequences(fixture, AL_INBOUND_MAX_DELIVERED_MARKERS);

        expect(await readMarkedTracks(fixture.backend)).toHaveLength(AL_INBOUND_MAX_DELIVERED_MARKERS);
    });

    it('evicts the oldest marker, not the first opened, for the next new track past the cap', async () => {
        const fixture = await createMarkerCapFixture({ storage: 'memory' });
        await admitFirstSequences(fixture, AL_INBOUND_MAX_DELIVERED_MARKERS);
        await admitAtNextMs(fixture, createTrackMessage(0, 2));

        await admitAtNextMs(fixture, createTrackMessage(AL_INBOUND_MAX_DELIVERED_MARKERS, 1));

        const marked = await readMarkedTracks(fixture.backend);
        expect(marked).toHaveLength(AL_INBOUND_MAX_DELIVERED_MARKERS);
        expect(marked).toContain(toTrackKey(0));
        expect(marked).not.toContain(toTrackKey(1));
        expect(marked).toContain(toTrackKey(AL_INBOUND_MAX_DELIVERED_MARKERS));
    });

    it('counts every sender\'s markers against the store\'s one cap, evicting another sender\'s older marker', async () => {
        const stated: number[] = [];
        const fixture = await createMarkerCapFixture({
            storage: 'memory',
            reportDeliveredMarkers: (markers) => stated.push(markers)
        });
        await admitAtNextMs(fixture, createTrackMessage(0, 1, OTHER_SENDER));
        await admitFirstSequences(fixture, AL_INBOUND_MAX_DELIVERED_MARKERS - 1);

        await admitAtNextMs(fixture, createTrackMessage(AL_INBOUND_MAX_DELIVERED_MARKERS, 1));

        const marked = await readMarkedTracks(fixture.backend);
        expect(marked).toHaveLength(AL_INBOUND_MAX_DELIVERED_MARKERS);
        expect(marked).not.toContain(toTrackKey(0, OTHER_SENDER));
        expect(marked).toContain(toTrackKey(0));
        expect(stated.at(-1)).toBe(AL_INBOUND_MAX_DELIVERED_MARKERS);
    });

    it('stops counting a sender that opens no more tracks once its markers expire', async () => {
        const stated: number[] = [];
        const fixture = await createMarkerCapFixture({
            storage: 'memory',
            reportDeliveredMarkers: (markers) => stated.push(markers)
        });
        for (let track = 0; track < 3; track += 1) {
            await admitAtNextMs(fixture, createTrackMessage(track, 1, OTHER_SENDER));
        }
        vi.setSystemTime(Date.now() + MARKER_TRACK_TTL_MS);

        await admitAtNextMs(fixture, createTrackMessage(0, 1));

        expect(stated).toEqual([1, 2, 3, 1]);
    });

    it('still answers every retained marker\'s delivered sequence as completed, and the evicted one as unknown', async () => {
        const fixture = await createMarkerCapFixture({ storage: 'memory' });
        await admitFirstSequences(fixture, AL_INBOUND_MAX_DELIVERED_MARKERS);
        await deliverAll(fixture, AL_INBOUND_MAX_DELIVERED_MARKERS);

        await admitAtNextMs(fixture, createTrackMessage(AL_INBOUND_MAX_DELIVERED_MARKERS, 1));
        await deliverAll(fixture, AL_INBOUND_MAX_DELIVERED_MARKERS + 1);

        const store = fixture.inbound.stores.admissionStore;
        const marked = await readMarkedTracks(fixture.backend);
        const answers = await Promise.all(marked.map(async (trackKey) => await store.readOrderedDelivery(trackKey, 1)));
        expect(marked).toHaveLength(AL_INBOUND_MAX_DELIVERED_MARKERS);
        expect(answers).toEqual(marked.map(() => ({ completedThrough: 1, predecessor: undefined })));
        expect(await store.readOrderedDelivery(toTrackKey(0), 1)).toEqual({
            completedThrough: 0,
            predecessor: { kind: 'resync-required' }
        });
    }, CHURN_TIMEOUT_MS);

    it('keeps the oldest marker while its track buffers a release, and evicts the next oldest instead', async () => {
        const fixture = await createMarkerCapFixture({ storage: 'memory' });
        await admitAtNextMs(fixture, createTrackMessage(0, 2));
        await admitFirstSequences(fixture, AL_INBOUND_MAX_DELIVERED_MARKERS - 1, 1);

        await admitAtNextMs(fixture, createTrackMessage(AL_INBOUND_MAX_DELIVERED_MARKERS, 1));

        const marked = await readMarkedTracks(fixture.backend);
        expect(marked).toHaveLength(AL_INBOUND_MAX_DELIVERED_MARKERS);
        expect(marked).toContain(toTrackKey(0));
        expect(marked).not.toContain(toTrackKey(1));
    });

    it('states how many markers it holds after each new marker\'s pass, and nothing for a known track', async () => {
        const stated: number[] = [];
        const fixture = await createMarkerCapFixture({
            storage: 'memory',
            reportDeliveredMarkers: (markers) => stated.push(markers)
        });

        await admitFirstSequences(fixture, AL_INBOUND_MAX_DELIVERED_MARKERS + 2);
        await admitAtNextMs(fixture, createTrackMessage(AL_INBOUND_MAX_DELIVERED_MARKERS + 1, 2));

        expect(stated).toHaveLength(AL_INBOUND_MAX_DELIVERED_MARKERS + 2);
        expect(stated.slice(0, 3)).toEqual([1, 2, 3]);
        expect(stated.slice(-3)).toEqual([
            AL_INBOUND_MAX_DELIVERED_MARKERS,
            AL_INBOUND_MAX_DELIVERED_MARKERS,
            AL_INBOUND_MAX_DELIVERED_MARKERS
        ]);
    });
});

describe('the marker pass after a committed admission', () => {
    it('leaves the eviction to the next new track when its removal write fails, and the opening track is still delivered', async () => {
        const stated: number[] = [];
        const fixture = await createMarkerCapFixture({
            storage: 'memory',
            reportDeliveredMarkers: (markers) => stated.push(markers)
        });
        await admitFirstSequences(fixture, AL_INBOUND_MAX_DELIVERED_MARKERS);
        failDeliveredMarkerRemovals(fixture.backend);
        const opening = createTrackMessage(AL_INBOUND_MAX_DELIVERED_MARKERS, 1);
        stated.length = 0;

        await admitAtNextMs(fixture, opening);

        await expect.poll(async () => {
            await fixture.inbound.queueEngine.executeOnce();
            return (await fixture.inbound.stores.admissionStore.readOrderedDelivery(toALOrderingTrackKey(opening)!, 2))
                .completedThrough;
        }, { timeout: DELIVERY_TIMEOUT_MS }).toBe(1);
        expect(stated).toEqual([]);
        expect(await readMarkedTracks(fixture.backend)).toHaveLength(AL_INBOUND_MAX_DELIVERED_MARKERS + 1);
    }, CHURN_TIMEOUT_MS);

    it('admits and delivers the opening track when the count\'s listener throws', async () => {
        const fixture = await createMarkerCapFixture({
            storage: 'memory',
            reportDeliveredMarkers: () => {
                throw new Error('The count listener failed');
            }
        });

        await admitAtNextMs(fixture, createTrackMessage(0, 1));

        await expect.poll(() => fixture.inbound.delivered.length).toBe(1);
    });
});

describe.each<InboundTestStorage>(['memory', 'indexeddb'])('the %s inbound pair under track churn', (storage) => {
    it('keeps markers and snapshots at their caps, and states the marker count, after 300 one-message tracks', async () => {
        const stated: number[] = [];
        const fixture = await createMarkerCapFixture({
            storage,
            reportDeliveredMarkers: (markers) => stated.push(markers),
            maxOrderingTracks: AL_INBOUND_MAX_ORDERING_TRACKS
        });

        await admitFirstSequences(fixture, CHURNED_TRACKS);

        const marked = await readMarkedTracks(fixture.backend);
        expect(marked).toHaveLength(AL_INBOUND_MAX_DELIVERED_MARKERS);
        expect(await fixture.backend.list(ORDERING_PREFIX, (value) => value)).toHaveLength(
            AL_INBOUND_MAX_ORDERING_TRACKS
        );
        expect(stated.at(-1)).toBe(AL_INBOUND_MAX_DELIVERED_MARKERS);
        expect(marked).toContain(toTrackKey(CHURNED_TRACKS - 1));
        expect(marked).not.toContain(toTrackKey(CHURNED_TRACKS - AL_INBOUND_MAX_DELIVERED_MARKERS - 1));
    }, CHURN_TIMEOUT_MS);
});

async function createMarkerCapFixture(input: MarkerCapFixtureInput): Promise<MarkerCapFixture> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START_MS);
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const { backend, stores } = createInboundTestBackendStores({
        namespace: NAMESPACE,
        storage: input.storage,
        observer: createPassThroughIndexedDbOperationObserver(),
        maxOrderingTracks: input.maxOrderingTracks,
        maxDeliveredMarkers: AL_INBOUND_MAX_DELIVERED_MARKERS,
        reportDeliveredMarkers: input.reportDeliveredMarkers
    });
    const inbound = createInboundTestRuntime({ carrier: 'ws', stores, effectWorkerId: 'al-inbound:marker-cap' });
    await inbound.runtime.ready();
    return { backend, inbound };
}

/** Fails every write that removes a delivered marker, as a storage error would: only the marker pass removes one. */
function failDeliveredMarkerRemovals(backend: ALAdmissionWorkBackend): void {
    const write = backend.write.bind(backend);
    vi.spyOn(backend, 'write').mockImplementation(async (operation, executionExpiresAtMs) =>
        await write(async (context) => {
            const remove = context.remove.bind(context);
            context.remove = async (key) => {
                if (key.startsWith(DELIVERED_PREFIX)) {
                    throw new Error('The storage refused the removal');
                }
                await remove(key);
            };
            return await operation(context);
        }, executionExpiresAtMs)
    );
}

/** One first sequence on each of `count` tracks, a millisecond apart, so each marker's expiry is its own. */
async function admitFirstSequences(fixture: MarkerCapFixture, count: number, first = 0): Promise<void> {
    for (let track = first; track < first + count; track += 1) {
        await admitAtNextMs(fixture, createTrackMessage(track, 1));
    }
}

async function admitAtNextMs(fixture: MarkerCapFixture, message: ALMessage): Promise<void> {
    vi.setSystemTime(Date.now() + 1);
    const source = { ...INBOUND_TEST_SOURCE, peerId: message.id.senderId };
    expect((await fixture.inbound.runtime.admitIncomingMessage(message, source)).right).toEqual({ kind: 'admitted' });
}

async function deliverAll(fixture: MarkerCapFixture, count: number): Promise<void> {
    await expect.poll(async () => {
        await fixture.inbound.queueEngine.executeOnce();
        return fixture.inbound.delivered.length;
    }, { timeout: DELIVERY_TIMEOUT_MS }).toBe(count);
}

function createTrackMessage(track: number, seq: number, senderId = INBOUND_TEST_SENDER_PEER_ID): ALMessage {
    const message = createInboundTestMessage({ msgId: `${senderId}-track-${track}-${seq}`, seq, senderId });
    return { ...message, ordering: { orderingKey: `track-${track}`, seq } };
}

function toTrackKey(track: number, senderId = INBOUND_TEST_SENDER_PEER_ID): string {
    return toALOrderingTrackKey(createTrackMessage(track, 1, senderId))!;
}

/** The track key of every delivered marker the store holds. */
async function readMarkedTracks(backend: ALAdmissionWorkBackend): Promise<readonly string[]> {
    const held = await backend.list(DELIVERED_PREFIX, (value) => value);
    return held.map((entry) => entry.key.slice(DELIVERED_PREFIX.length));
}
