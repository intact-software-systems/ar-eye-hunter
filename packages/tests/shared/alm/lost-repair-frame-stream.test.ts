import { describe, expect, it } from 'vitest';

import { createLossyLink } from './lost-repair-frame-link.ts';
import type { WsClientCarrierStoreKind } from './outbound-runtime-test-fixture.ts';

const STORE_KINDS: readonly WsClientCarrierStoreKind[] = ['memory', 'indexeddb'];

describe('a WS client\'s ordered stream through a link that loses a repair frame', () => {
    // Breaks when the receiver reports a gap only when a later frame arrives: once the stream has ended, nothing
    // arrives to reveal it again, and the sender has no new request to answer with a frame.
    it.each(STORE_KINDS)(
        'on %s, delivers the whole ack-none stream when the link drops a first frame and its first repair frame',
        async (store) => {
            const link = createLossyLink(store, { drop: (frame) => frame.seq === 1 && frame.copy <= 2 });
            await link.send(['first', 'second', 'third'], 'none');
            await link.advanceTo(999);
            expect(link.delivered).toEqual([]);
            expect(link.framesOf(1)).toBe(2);
            await link.advanceTo(1_100);
            expect(link.delivered).toEqual(['first', 'second', 'third']);
            expect(link.framesOf(1)).toBe(3);
            await link.advanceTo(29_000);
            expect(link.framesOf(1)).toBe(3);
            expect(link.delivered).toEqual(['first', 'second', 'third']);
        }
    );
});
