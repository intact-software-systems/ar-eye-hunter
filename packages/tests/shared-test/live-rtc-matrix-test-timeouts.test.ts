import { describe, expect, it } from 'vitest';

import {
    FORMATION_CONNECT_RESULT_WAIT_MS,
    FORMATION_RUN_BOUNDED_WAITS_MS,
    FORMATION_RUN_CONNECT_RESULT_WAIT_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-formation-waits.ts';
import {
    CLUSTER_DIRECT_EXCHANGE_BOUNDED_WAITS_MS,
    LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
    LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
    LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS,
    RETENTION_RECONNECT_CYCLES
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-matrix-test-timeouts.ts';

const MARGIN = 60_000;
/** Each of a trio's agents waits 30 s for its registration as it opens, one after another. */
const TRIO_OPEN = 3 * 30_000;
/** The owner creates the group and the two other members join it, each request under its own 10 s. */
const MEMBERSHIP = 3 * 10_000;
/** A formation run: three connects, a presence poll after each, two layout polls and three readiness waits. */
const FORMATION = 3 * 180_000 + 3 * 30_000 + 2 * 30_000 + 60_000 + 2 * 60_000 + 2 * (10_000 + 15_000);
/** A delivery's 60 s send runs beside its receivers' 60 s message waits. */
const DELIVERY = 60_000;
/** A diagnostics capture reads each of the trio's agents for up to 30 s. */
const DIAGNOSTICS = 3 * 30_000;
/** An agent's 45 s close, then its 30 s reset. */
const CLOSE_AND_RESET = 45_000 + 30_000;
/** Retiring the settled realtime trio: each agent closes and resets, with two 60 s absence waits between. */
const RETIREMENT = 3 * CLOSE_AND_RESET + 2 * 60_000;
/** The NACK probe's 45 s send and 15 s receipt poll, the 45 s close, then the closed transport's 10 s refused send. */
const PROBES = 45_000 + 15_000 + 45_000 + 10_000;
/** The 20 s poll for every key command's result. */
const RESULTS_POLL = 20_000;
/** The attempt's cleanup closes its open agents side by side, each for up to 15 s. */
const CLEANUP = 15_000;

describe('live RTC three-browser matrix test timeouts', () => {
    it('waits for each formation connect its 135 s command timeout and the 45 s result poll', () => {
        expect(FORMATION_CONNECT_RESULT_WAIT_MS).toBe(180_000);
        expect(FORMATION_RUN_CONNECT_RESULT_WAIT_MS).toBe(3 * 180_000);
    });

    // The pair and the trio each configure the mesh under its 10 s and read the group for up to 15 s, which went uncounted.
    it('counts every wait of a formation run', () => {
        expect(FORMATION_RUN_BOUNDED_WAITS_MS).toBe(FORMATION);
    });

    // The proof counted neither its agents' registrations, its membership, its diagnostics reads, its closes and resets
    // nor its cleanup.
    it('gives the proof two trios, two delivery matrices, the diagnostics, the retirement, the probes and the cleanup', () => {
        const matrix = FORMATION + 3 * DELIVERY + 2 * 30_000;

        expect(LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS).toBe(
            MARGIN + 2 * TRIO_OPEN + MEMBERSHIP + 2 * matrix + 2 * DIAGNOSTICS + RETIREMENT + PROBES +
                2 * CLOSE_AND_RESET + RESULTS_POLL + CLEANUP
        );
    });

    it('adds the cluster exchange\'s three readiness waits and six direct deliveries under a cluster API', () => {
        expect(CLUSTER_DIRECT_EXCHANGE_BOUNDED_WAITS_MS).toBe(3 * 60_000 + 6 * DELIVERY);
    });

    it('gives every-scenario run its trios, permutations, opens, closes, probes, reconnect, direct message and cleanup', () => {
        const readback = 2 * 10_000;
        const permutations = FORMATION + 3 * 4 * DELIVERY;
        const webSocketTrio = 3 * 15_000 + 3 * CLOSE_AND_RESET;
        const reconnect = 60_000 + 180_000 + 60_000;

        expect(LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS).toBe(
            MARGIN + 3 * TRIO_OPEN + MEMBERSHIP + readback + 2 * permutations + 2 * DIAGNOSTICS + RETIREMENT +
                webSocketTrio + PROBES + reconnect + 60_000 + 60_000 + 3 * CLOSE_AND_RESET + RESULTS_POLL + CLEANUP
        );
    });

    // The soak's derived 1,800 s + one formation run + a reconnect per cycle is 20,340 s, longer than the B06 job that
    // runs it; each reconnect is already bounded by its own wait, so the soak is capped at three hours.
    it('caps the retention soak at its three-hour operational bound below its derived sum', () => {
        expect(1_800_000 + 540_000 + RETENTION_RECONNECT_CYCLES * 180_000).toBe(20_340_000);
        expect(LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS).toBe(3 * 60 * 60_000);
    });
});
