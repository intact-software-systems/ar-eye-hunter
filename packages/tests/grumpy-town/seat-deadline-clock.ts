import type { TownMatchSeatObservation } from '../../../apps/grumpy-town/src/match/match-seats.ts';

/** A calibrated point sample for deterministic match transitions. */
export function seatDeadlineClock(now: number): TownMatchSeatObservation['clock'] {
    return {
        deadlineAfter: durationMs => now + durationMs,
        compareDeadline: deadline => now < deadline ? 'before' : 'at-or-after'
    };
}
