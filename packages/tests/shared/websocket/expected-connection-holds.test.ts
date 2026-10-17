import { describe, expect, it } from 'vitest';

import { ExpectedConnectionHolds } from '@shared/websocket/expected-connection-holds.ts';

const FAR_FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

interface HoldsFixture {
    readonly holds: ExpectedConnectionHolds;
    readonly clock: { now: number; };
    readonly open: Set<string>;
}

function createHoldsFixture(): HoldsFixture {
    const clock = { now: 1_000 };
    const open = new Set<string>();
    return {
        holds: new ExpectedConnectionHolds({ isOpen: (id) => open.has(id), nowEpochMs: () => clock.now }),
        clock,
        open
    };
}

describe('ExpectedConnectionHolds', () => {
    it('holds only for an expected id that is not open', () => {
        const { holds, open } = createHoldsFixture();
        holds.expect({ id: 'session-1', generationId: 'generation-1', expiresAtEpochMs: FAR_FUTURE_MS });

        expect(holds.isAwaiting('session-1')).toBe(true);
        expect(holds.isAwaiting('session-2')).toBe(false);
        expect(holds.hold('session-2', { expiresAtEpochMs: FAR_FUTURE_MS, send: () => {} })).toBe('not-awaiting');
        open.add('session-1');
        expect(holds.hold('session-1', { expiresAtEpochMs: FAR_FUTURE_MS, send: () => {} })).toBe('not-awaiting');
    });

    it('keeps the sends of a generation still expected and runs them when the last one settles', () => {
        const { holds } = createHoldsFixture();
        const sent: string[] = [];
        holds.expect({ id: 'session-1', generationId: 'rejected', expiresAtEpochMs: FAR_FUTURE_MS });
        holds.expect({ id: 'session-1', generationId: 'pending', expiresAtEpochMs: FAR_FUTURE_MS });
        holds.hold('session-1', { expiresAtEpochMs: FAR_FUTURE_MS, send: () => sent.push('held') });

        holds.release({ id: 'session-1', generationId: 'rejected' });
        expect(sent).toEqual([]);
        holds.release({ id: 'session-1', generationId: 'pending' });

        expect(sent).toEqual(['held']);
        expect(holds.hasExpectations()).toBe(false);
    });

    it('evicts the oldest held send when full, so the newest rows, the connect rows among them, survive', () => {
        const { holds } = createHoldsFixture();
        const sent: number[] = [];
        holds.expect({ id: 'session-1', generationId: 'generation-1', expiresAtEpochMs: FAR_FUTURE_MS });
        const outcomes = Array.from(
            { length: ExpectedConnectionHolds.MAX_HELD_SENDS_PER_CONNECTION + 2 },
            (_, index) => holds.hold('session-1', { expiresAtEpochMs: FAR_FUTURE_MS, send: () => sent.push(index) })
        );

        holds.open({ id: 'session-1', generationId: 'generation-1' });

        expect(outcomes.filter((outcome) => outcome === 'held-evicting-oldest')).toHaveLength(2);
        expect(sent).toHaveLength(ExpectedConnectionHolds.MAX_HELD_SENDS_PER_CONNECTION);
        expect(sent[0]).toBe(2);
        expect(sent.at(-1)).toBe(ExpectedConnectionHolds.MAX_HELD_SENDS_PER_CONNECTION + 1);
    });

    it('settles an expectation at its deadline and never runs a send past its own deadline', () => {
        const { holds, clock } = createHoldsFixture();
        const sent: string[] = [];
        holds.expect({ id: 'session-1', generationId: 'generation-1', expiresAtEpochMs: 2_000 });
        holds.hold('session-1', { expiresAtEpochMs: 1_500, send: () => sent.push('expired') });
        holds.hold('session-1', { expiresAtEpochMs: 3_000, send: () => sent.push('live') });

        clock.now = 2_000;

        expect(holds.isAwaiting('session-1')).toBe(false);
        expect(sent).toEqual(['live']);
        expect(holds.hasExpectations()).toBe(false);
    });
});
