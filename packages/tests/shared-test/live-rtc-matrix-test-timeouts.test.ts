import { describe, expect, it } from 'vitest';

import {
    CLUSTER_DIRECT_EXCHANGE_BOUNDED_WAITS_MS,
    LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
    LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
    LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS,
    RETENTION_RECONNECT_CYCLES
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-matrix-test-timeouts.ts';
import {
    FORMATION_CONNECT_RESULT_WAIT_MS,
    FORMATION_RUN_BOUNDED_WAITS_MS,
    FORMATION_RUN_CONNECT_RESULT_WAIT_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-wait-budgets.ts';

const MARGIN = 60_000;
/** A delivery's 60 s send runs beside its receivers' 60 s message waits. */
const DELIVERY = 60_000;
/** Retiring the settled realtime trio: two 60 s absence waits. */
const RETIREMENT = 2 * 60_000;
/** The NACK probe's 45 s send and 15 s receipt poll, then the closed transport's 10 s refused send. */
const PROBES = 45_000 + 15_000 + 10_000;
/** The 20 s poll for every key command's result. */
const RESULTS_POLL = 20_000;

describe('live RTC three-browser matrix test timeouts', () => {
    it('waits for each formation connect its 135 s command timeout and the 45 s result poll', () => {
        expect(FORMATION_CONNECT_RESULT_WAIT_MS).toBe(180_000);
        expect(FORMATION_RUN_CONNECT_RESULT_WAIT_MS).toBe(3 * 180_000);
    });

    // Three connects, a 30 s presence poll after each, two 30 s layout polls, the pair's 60 s peer readiness and the
    // pair's and trio's 60 s readiness.
    it('counts every wait of a formation run', () => {
        expect(FORMATION_RUN_BOUNDED_WAITS_MS).toBe(3 * 180_000 + 3 * 30_000 + 2 * 30_000 + 60_000 + 2 * 60_000);
    });

    // The proof's 1,440 s covered its two formation runs' connects and 360 s for everything else.
    it('gives the proof matrix two delivery matrices, the retirement, the probes and the results poll', () => {
        const matrix = 870_000 + 3 * DELIVERY + 2 * 30_000;

        expect(LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS).toBe(MARGIN + 2 * matrix + RETIREMENT + PROBES + RESULTS_POLL);
    });

    it('adds the cluster exchange\'s three readiness waits and six direct deliveries under a cluster API', () => {
        expect(CLUSTER_DIRECT_EXCHANGE_BOUNDED_WAITS_MS).toBe(3 * 60_000 + 6 * DELIVERY);
    });

    // The 1,560 s covered two formation runs' connects, the reconnect and 300 s for everything else.
    it('gives every-scenario run its permutations, opens, probes, reconnect and direct message', () => {
        const permutations = 870_000 + 3 * 4 * DELIVERY;
        const reconnect = 60_000 + 180_000 + 60_000;

        expect(LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS).toBe(
            MARGIN + 2 * permutations + RETIREMENT + 3 * 15_000 + PROBES + reconnect + 60_000 + 60_000 + RESULTS_POLL
        );
    });

    // The soak's derived 1,800 s + one formation run + a reconnect per cycle is 20,340 s, longer than the B06 job that
    // runs it; each reconnect is already bounded by its own wait, so the soak is capped at three hours.
    it('caps the retention soak at its three-hour operational bound below its derived sum', () => {
        expect(1_800_000 + 540_000 + RETENTION_RECONNECT_CYCLES * 180_000).toBe(20_340_000);
        expect(LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS).toBe(3 * 60 * 60_000);
    });
});
