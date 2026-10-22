import { expect, it } from 'vitest';

import { ALInboundDeliveredMarkerIndex } from '@shared/alm/inbound/admission/al-inbound-delivered-marker-index.ts';

function readOldestTracks(index: ALInboundDeliveredMarkerIndex, senderId: string, nowMs: number): readonly string[] {
    return [...index.readOldest(senderId, nowMs)].map((marker) => marker.trackKey);
}

it('reads a sender\'s markers from the first to expire, a later expiry moving a marker behind the others', () => {
    const index = new ALInboundDeliveredMarkerIndex();
    index.record('a', { trackKey: 't1', expireAtTimestamp: 100 });
    index.record('a', { trackKey: 't2', expireAtTimestamp: 101 });
    index.record('b', { trackKey: 't3', expireAtTimestamp: 50 });

    index.record('a', { trackKey: 't1', expireAtTimestamp: 102 });
    index.record('a', { trackKey: 't2', expireAtTimestamp: 101 });

    expect(readOldestTracks(index, 'a', 0)).toEqual(['t2', 't1']);
    expect(index.countSender('a', 0)).toBe(2);
    expect(index.countSender('b', 0)).toBe(1);
    expect(index.count(0)).toBe(3);
});

it('drops expired heads and counts the rows loaded before any commit named their sender', () => {
    const index = new ALInboundDeliveredMarkerIndex();
    index.record('a', { trackKey: 't1', expireAtTimestamp: 100 });
    index.load([
        { trackKey: 't1', expireAtTimestamp: 100 },
        { trackKey: 'old-2', expireAtTimestamp: 90 },
        { trackKey: 'old-1', expireAtTimestamp: 80 }
    ]);

    expect(index.loaded).toBe(true);
    expect(index.count(0)).toBe(3);
    expect(index.count(85)).toBe(2);

    index.record('a', { trackKey: 'old-2', expireAtTimestamp: 120 });
    index.forget('a', 't1');

    expect(index.count(85)).toBe(1);
    expect(index.countSender('a', 130)).toBe(0);
});
