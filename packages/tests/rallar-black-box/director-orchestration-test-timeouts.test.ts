import { describe, expect, it } from 'vitest';

import { DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS } from '../../../tests/playwright/rallar-black-box/director-orchestration-test-timeouts.ts';

/** Every command's enqueue request, and every control run read outside a poll, waits at most 10 s. */
const REQUEST = 10_000;
/** A command that names no budget of its own is enqueued, then polled for its result for 45 s. */
const POLL = REQUEST + 45_000;

describe('director orchestration test timeout', () => {
    // No command's enqueue request was counted, and a control read outside a poll only by its pauses; earlier, the
    // scenario counted neither its membership requests, the director commands polled under the default result
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
        /** Each client's intent is enqueued, then waits 30 s for the director's receipt. */
        const intents = 2 * (REQUEST + 30_000);
        const events = 60_000;
        /** The two sync requests, then their snapshots side by side. */
        const syncs = 2 * POLL + 60_000;
        /** A's relay stops, the 1.9 s stale hold, B's and C's status reads, then their relays stop. */
        const stale = POLL + 1_900 + 2 * POLL + 2 * POLL;
        /**
         * The run and its artifacts are read, each read sending up to three requests of 10 s that fail in transport,
         * 250 ms apart.
         */
        const reads = 2 * (3 * REQUEST + 2 * 250);
        /** Each page's cleanup clicks up to seven buttons, each for up to 2 s; the pages clean up side by side. */
        const cleanup = 7 * 2_000;

        expect(DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS).toBe(
            60_000 + openings + membership + connects + readiness + appointment + relays + intents + events + syncs +
                stale + reads + cleanup
        );
    });
});
