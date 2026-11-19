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

    it('recovers a lost last frame of a receipted stream by its first-hop wait', async () => {
        const link = createLossyLink('memory', { drop: (frame) => frame.seq === 3 && frame.copy === 1 });
        await link.send(['first', 'second', 'third'], 'receiver');
        await link.advanceTo(1_999);
        expect(link.delivered).toEqual(['first', 'second']);
        expect(link.framesOf(3)).toBe(1);
        await link.advanceTo(2_100);
        expect(link.framesOf(3)).toBe(2);
        expect(link.delivered).toEqual(['first', 'second', 'third']);
    });

    // A limit the design accepts: no receipt waits on the send, and no later frame reveals the gap. A fix turns this red.
    it(
        'does not recover a lost last frame under ack none: nothing reveals the gap (the stated limit)',
        async () => {
            const link = createLossyLink('memory', { drop: (frame) => frame.seq === 3 });
            await link.send(['first', 'second', 'third'], 'none');
            await link.advanceTo(29_000);
            expect(link.delivered).toEqual(['first', 'second']);
            expect(link.framesOf(3)).toBe(1);
            expect(link.controls).toEqual([]);
            expect(await link.readNextDueAtMs()).toBeUndefined();
        }
    );

    // The link hands the repair frame over at the instant the renewal runs, after it, so the renewal is answered with a
    // frame of its own: that frame is the one stray copy, and the timer it armed finds nothing missing and ends.
    it(
        'a renewal that races the repair frame closing the gap costs at most one stray frame',
        async () => {
            const link = createLossyLink('memory', {
                drop: (frame) => frame.seq === 1 && frame.copy === 1,
                holdUntilMs: (frame) => frame.seq === 1 && frame.copy === 2 ? 1_000 : undefined
            });
            await link.send(['first', 'second', 'third'], 'none');
            await link.advanceTo(999);
            expect(link.delivered).toEqual([]);
            expect(link.framesOf(1)).toBe(2);
            await link.advanceTo(29_000);
            expect(link.delivered).toEqual(['first', 'second', 'third']);
            expect(link.framesOf(1)).toBe(3);
            expect((await link.readPendingReceiverWork()).map((effect) => effect.payload.kind)).not.toContain('renew-gap');
        }
    );
});
