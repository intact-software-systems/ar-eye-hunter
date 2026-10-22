import { expect, it } from 'vitest';

import { ALInboundStoreCounts } from '@shared/alm/storage/al-inbound-store-counts.ts';

it('sums each store\'s latest ordering-snapshot and delivered-marker statements apart', () => {
    const counts = new ALInboundStoreCounts();

    counts.observe({ kind: 'ordering-tracks', storeId: 'session', tracks: 3 });
    counts.observe({ kind: 'delivered-markers', storeId: 'session', markers: 5 });
    counts.observe({ kind: 'delivered-markers', storeId: 'session/volatile', markers: 255 });
    counts.observe({ kind: 'delivered-markers', storeId: 'session/volatile', markers: 256 });
    counts.observe({ kind: 'persist', outcome: 'granted' });

    expect(counts.getOrderingTracks()).toBe(3);
    expect(counts.getDeliveredMarkers()).toBe(261);
});

it('reads 0 before any statement and after a reset', () => {
    const counts = new ALInboundStoreCounts();
    expect(counts.getDeliveredMarkers()).toBe(0);
    counts.observe({ kind: 'delivered-markers', storeId: 'session', markers: 5 });
    counts.observe({ kind: 'ordering-tracks', storeId: 'session', tracks: 3 });

    counts.reset();

    expect(counts.getDeliveredMarkers()).toBe(0);
    expect(counts.getOrderingTracks()).toBe(0);
});
