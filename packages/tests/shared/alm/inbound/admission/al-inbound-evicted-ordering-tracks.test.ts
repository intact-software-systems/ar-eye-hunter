import { describe, expect, it } from 'vitest';

import {
    decodeALInboundEvictedOrderingTracks,
    isALInboundOrderingTrackEvicted,
    toALInboundEvictedOrderingTracks,
    type ALInboundEvictedOrderingTrack
} from '@shared/alm/inbound/admission/al-inbound-evicted-ordering-tracks.ts';
import { AL_INBOUND_MAX_ORDERING_TRACKS } from '@shared/alm/inbound/admission/evict-al-inbound-ordering-tracks-past-cap.ts';

const NOW_MS = 10_000;

describe('the tracks an inbound store evicted at its ordering cap', () => {
    it('adds each evicted track as newest with the instant its eviction stops counting', () => {
        const held = [{ trackKey: 'a', untilMs: 20_000 }];

        const tracks = add(held, ['b', 'c'], 30_000);

        expect(tracks).toEqual([
            { trackKey: 'a', untilMs: 20_000 },
            { trackKey: 'b', untilMs: 30_000 },
            { trackKey: 'c', untilMs: 30_000 }
        ]);
    });

    it(`keeps at most ${AL_INBOUND_MAX_ORDERING_TRACKS} evictions, the oldest leaving first`, () => {
        const held = Array.from({ length: AL_INBOUND_MAX_ORDERING_TRACKS }, (_, index) => ({
            trackKey: `track-${index}`,
            untilMs: 20_000
        }));

        const tracks = add(held, ['newest'], 30_000);

        expect(tracks).toHaveLength(AL_INBOUND_MAX_ORDERING_TRACKS);
        expect(tracks[0]).toEqual({ trackKey: 'track-1', untilMs: 20_000 });
        expect(tracks.at(-1)).toEqual({ trackKey: 'newest', untilMs: 30_000 });
    });

    it('drops an eviction past its instant at the next write and counts it as absent before then', () => {
        const held = [{ trackKey: 'lapsed', untilMs: NOW_MS }, { trackKey: 'live', untilMs: NOW_MS + 1 }];

        expect(add(held, ['b'], 30_000).map((track) => track.trackKey)).toEqual(['live', 'b']);
        expect(isALInboundOrderingTrackEvicted(held, 'lapsed', NOW_MS)).toBe(false);
        expect(isALInboundOrderingTrackEvicted(held, 'live', NOW_MS)).toBe(true);
    });

    it('moves a track evicted again to newest with its new instant', () => {
        const held = [{ trackKey: 'a', untilMs: 20_000 }, { trackKey: 'b', untilMs: 20_000 }];

        expect(add(held, ['a'], 30_000)).toEqual([{ trackKey: 'b', untilMs: 20_000 }, { trackKey: 'a', untilMs: 30_000 }]);
    });

    it('answers no eviction for a track the row does not name', () => {
        expect(isALInboundOrderingTrackEvicted([{ trackKey: 'a', untilMs: 20_000 }], 'b', NOW_MS)).toBe(false);
        expect(isALInboundOrderingTrackEvicted([], 'a', NOW_MS)).toBe(false);
    });

    it('decodes the row it writes', () => {
        const tracks = add([], ['a', 'b'], 30_000);

        expect(decodeALInboundEvictedOrderingTracks(JSON.parse(JSON.stringify(tracks)))).toEqual(tracks);
    });

    it.each([
        ['a value that is not an array', { trackKey: 'a', untilMs: 1 }],
        ['an entry that is not a record', ['a']],
        ['an entry without its instant', [{ trackKey: 'a' }]],
        ['an entry with an unknown field', [{ trackKey: 'a', untilMs: 1, extra: true }]],
        ['an empty track key', [{ trackKey: '', untilMs: 1 }]],
        ['a negative instant', [{ trackKey: 'a', untilMs: -1 }]],
        ['a fractional instant', [{ trackKey: 'a', untilMs: 1.5 }]],
        ['a track named twice', [{ trackKey: 'a', untilMs: 1 }, { trackKey: 'a', untilMs: 2 }]],
        ['more entries than the cap', Array.from({ length: 257 }, (_, index) => ({ trackKey: `t-${index}`, untilMs: 1 }))]
    ])('refuses %s', (_name, value) => {
        expect(() => decodeALInboundEvictedOrderingTracks(value)).toThrow(TypeError);
    });
});

function add(
    held: readonly ALInboundEvictedOrderingTrack[],
    evictedTrackKeys: readonly string[],
    untilMs: number
): readonly ALInboundEvictedOrderingTrack[] {
    return toALInboundEvictedOrderingTracks({
        held,
        evictedTrackKeys,
        untilMs,
        nowMs: NOW_MS,
        maxTracks: AL_INBOUND_MAX_ORDERING_TRACKS
    });
}
