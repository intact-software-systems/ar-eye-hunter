import { describe, expect, it } from 'vitest';

import { DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS } from '../../../tests/playwright/rallar-black-box/director-orchestration-test-timeouts.ts';

/** A command that names no budget of its own is polled for its result for 45 s. */
const POLL = 45_000;

describe('director orchestration test timeout', () => {
    // The scenario counted neither its membership requests, the director commands polled under the default result
    // poll, the appointment's and the relays' budgets, nor the page cleanup's bounded clicks.
    it('gives the director scenario every bounded wait it runs and the harness margin', () => {
        const openings = 3 * 3 * 30_000;
        /** The owner creates the group, then each of the three agents joins it, each request its 10 s and the poll. */
        const membership = 4 * (10_000 + POLL);
        const connects = 135_000 + POLL;
        const readiness = 60_000;
        /** The appointment's 20 s budget and the poll, then the three status reads. */
        const appointment = 20_000 + POLL + 3 * POLL;
        /** Each agent starts its relay under a 20 s budget, then the poll. */
        const relays = 3 * (20_000 + POLL);
        const intents = 2 * 30_000;
        const events = 60_000;
        /** The two sync requests, then their snapshots side by side. */
        const syncs = 2 * POLL + 60_000;
        /** A's relay stops, the 1.9 s stale hold, B's and C's status reads, then their relays stop. */
        const stale = POLL + 1_900 + 2 * POLL + 2 * POLL;
        /** Each page's cleanup clicks up to seven buttons, each for up to 2 s; the pages clean up side by side. */
        const cleanup = 7 * 2_000;

        expect(DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS).toBe(
            60_000 + openings + membership + connects + readiness + appointment + relays + intents + events + syncs +
                stale + cleanup
        );
    });
});
