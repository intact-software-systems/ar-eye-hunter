import { expect, it } from 'vitest';

import { ALInboundDeliveredMarkerIndex } from '@shared/alm/inbound/admission/al-inbound-delivered-marker-index.ts';

function getOldestTracks(index: ALInboundDeliveredMarkerIndex, nowMs: number): readonly string[] {
    return [...index.getOldest(nowMs)].map((marker) => marker.trackKey);
}

it('reads the markers from the least recently admitted, a later expiry moving a marker behind the others', () => {
    const index = new ALInboundDeliveredMarkerIndex();
    index.record({ trackKey: 't1', expireAtTimestamp: 100 });
    index.record({ trackKey: 't2', expireAtTimestamp: 101 });
    index.record({ trackKey: 't3', expireAtTimestamp: 102 });

    index.record({ trackKey: 't1', expireAtTimestamp: 103 });
    index.record({ trackKey: 't2', expireAtTimestamp: 101 });

    expect(getOldestTracks(index, 0)).toEqual(['t2', 't3', 't1']);
    expect(index.count(0)).toBe(3);
});

it('leaves no entry for a sender that opens no more tracks once its markers expire, and the count falls', () => {
    const index = new ALInboundDeliveredMarkerIndex();
    index.record({ trackKey: 'chat:departed:0', expireAtTimestamp: 100 });
    index.record({ trackKey: 'chat:departed:1', expireAtTimestamp: 101 });
    index.record({ trackKey: 'chat:staying:0', expireAtTimestamp: 200 });

    expect(index.count(50)).toBe(3);
    expect(index.count(150)).toBe(1);
    expect(getOldestTracks(index, 150)).toEqual(['chat:staying:0']);
});

it('puts the rows the store held before any commit named them ahead of the recorded markers, earliest expiry first', () => {
    const index = new ALInboundDeliveredMarkerIndex();
    index.record({ trackKey: 't1', expireAtTimestamp: 100 });

    index.load([
        { trackKey: 't1', expireAtTimestamp: 100 },
        { trackKey: 'old-2', expireAtTimestamp: 90 },
        { trackKey: 'old-1', expireAtTimestamp: 80 }
    ]);

    expect(index.loaded).toBe(true);
    expect(getOldestTracks(index, 0)).toEqual(['old-1', 'old-2', 't1']);
    expect(index.count(85)).toBe(2);
    index.forget('t1');
    expect(index.count(85)).toBe(1);
});
