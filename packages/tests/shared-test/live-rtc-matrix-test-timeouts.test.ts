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
    LIVE_RTC_RETENTION_SOAK_BOUNDED_WAITS_MS,
    LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS,
    RETENTION_RECONNECT_CYCLES
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-matrix-test-timeouts.ts';
import { LIVE_RTC_MATRIX_NATIVE_ACQUISITION_BOUNDED_WAITS_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-recorder-read-waits.ts';

const MARGIN = 60_000;
/** A command that names no budget of its own is polled for its result for 45 s. */
const POLL = 45_000;
/** A trio's agents each sign in (30 s), select the workbench tab (15 s, then 15 s for its panel) and register (30 s). */
const TRIO_OPEN = 3 * (30_000 + 2 * 15_000 + 30_000);
/** Browser recording admission then reads each agent's health in turn. */
const TRIO = TRIO_OPEN + 3 * POLL;
/** The owner creates the group and the two other members join it, each request its 10 s budget and then the poll. */
const MEMBERSHIP = 3 * (10_000 + POLL);
const CONNECT = 180_000;
/** A readiness waits 60 s; its last read may start before the deadline and then wait the poll. */
const READINESS = 60_000 + POLL;
/**
 * One formation cycle: the mesh configuration (10 s budget and the poll), the 15 s group read, the plan, the 30 s
 * planned layout poll, the layout's connect and the activation, the last three polled.
 */
const CYCLE = 10_000 + POLL + 15_000 + 30_000 + 3 * POLL;
/** Three connects each followed by a 30 s presence poll, the pair's and the trio's cycles and readiness, the pair's 60 s. */
const FORMATION = 3 * (CONNECT + 30_000) + 2 * (CYCLE + READINESS) + 60_000;
/** A delivery's send, its 60 s budget then the poll, runs beside its receivers' 60 s message waits. */
const DELIVERY = Math.max(60_000 + POLL, 60_000);
/** A receiver opens its Manual Rallar tab (two 15 s waits), then its inbox shows the message within 30 s. */
const INBOX = 2 * 15_000 + 30_000;
/** A diagnostics capture reads each of the trio's agents for up to 30 s. */
const DIAGNOSTICS = 3 * 30_000;
/** An agent's 45 s close, then its 30 s reset. */
const CLOSE_AND_RESET = 45_000 + 30_000;
/** Retiring the settled realtime trio: each agent closes and resets, with two 60 s absence waits between. */
const RETIREMENT = 3 * CLOSE_AND_RESET + 2 * 60_000;
/**
 * The NACK probe's send (45 s budget and the poll) and 15 s receipt poll, the 45 s close, then the refused send (10 s
 * budget and the poll).
 */
const PROBES = 45_000 + POLL + 15_000 + 45_000 + 10_000 + POLL;
/** The artifact evidence reads the run's results, then its events, from the recorder, each for up to 30 s. */
const ARTIFACT_EVIDENCE = 2 * 30_000;
/** The 20 s poll for every key command's result. */
const RESULTS_POLL = 20_000;
/** The attempt's cleanup closes its open agents side by side, each for up to 15 s. */
const CLEANUP = 15_000;

describe('live RTC three-browser matrix test timeouts', () => {
    it('waits for each formation connect its 135 s command timeout and the 45 s result poll', () => {
        expect(FORMATION_CONNECT_RESULT_WAIT_MS).toBe(180_000);
        expect(FORMATION_RUN_CONNECT_RESULT_WAIT_MS).toBe(3 * 180_000);
    });

    // The plan, the layout's connect, the activation and each readiness's last read wait the result poll, which went
    // uncounted, and the mesh configuration waited its poll after its budget.
    it('counts every wait of a formation run', () => {
        expect(FORMATION_RUN_BOUNDED_WAITS_MS).toBe(FORMATION);
    });

    // The proof counted neither its agents' opening screens under the default assertion limit, its recording
    // admission, its membership's result polls, the sends' and probes' result polls, the inboxes' tab opening, the
    // realtime sender's health nor the artifact evidence's recorder reads.
    it('gives the proof two trios, two delivery matrices, the diagnostics, the retirement, the probes and the cleanup', () => {
        const matrix = FORMATION + 3 * DELIVERY + 2 * INBOX;

        expect(LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS).toBe(
            MARGIN + 2 * TRIO + MEMBERSHIP + (matrix + POLL) + matrix + 2 * DIAGNOSTICS + RETIREMENT + PROBES +
                2 * CLOSE_AND_RESET + ARTIFACT_EVIDENCE + RESULTS_POLL + CLEANUP
        );
    });

    it('adds the cluster exchange\'s three readiness waits and six direct deliveries under a cluster API', () => {
        expect(CLUSTER_DIRECT_EXCHANGE_BOUNDED_WAITS_MS).toBe(3 * 60_000 + 6 * DELIVERY);
    });

    // The every-scenario count also read an acquisition for C's reconnect, which requests none.
    it('reads one acquisition for each connect of the two formation runs under Native capture', () => {
        expect(LIVE_RTC_MATRIX_NATIVE_ACQUISITION_BOUNDED_WAITS_MS).toBe(2 * 3 * 30_000);
    });

    it('gives every-scenario run its trios, permutations, opens, closes, probes, reconnect, direct message and cleanup', () => {
        const readback = 2 * (10_000 + POLL);
        const permutations = FORMATION + 3 * 4 * DELIVERY;
        /** Each WebSocket agent configures, opens (15 s budget and the poll), sends and closes, then closes and resets. */
        const webSocketTrio = 3 * (POLL + 15_000 + POLL + POLL + POLL) + 3 * CLOSE_AND_RESET;
        const reconnect = 60_000 + CONNECT + READINESS;
        const reconnectMessage = 60_000 + POLL + 60_000;

        expect(LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS).toBe(
            MARGIN + 3 * TRIO + MEMBERSHIP + readback + 2 * permutations + 2 * DIAGNOSTICS + RETIREMENT +
                webSocketTrio + PROBES + reconnect + reconnectMessage + 3 * CLOSE_AND_RESET + ARTIFACT_EVIDENCE +
                RESULTS_POLL + CLEANUP
        );
    });

    // Each reconnect is already bounded by its own wait, so the soak is capped at three hours below its derived sum: the
    // margin, a trio, the formation, eleven checkpoints, per cycle C's 45 s close, the 60 s absence and the reconnect, the closes
    // and resets, and the artifact evidence.
    it('caps the retention soak at its three-hour operational bound below its derived sum', () => {
        const cycle = 45_000 + 60_000 + CONNECT + READINESS;
        const boundedWaits = TRIO + MEMBERSHIP + FORMATION + 11 * DIAGNOSTICS + RETENTION_RECONNECT_CYCLES * cycle +
            3 * CLOSE_AND_RESET + ARTIFACT_EVIDENCE + CLEANUP;

        // The bounded waits held the margin as well, which no other bounded-waits sum does.
        expect(LIVE_RTC_RETENTION_SOAK_BOUNDED_WAITS_MS).toBe(boundedWaits);
        expect(MARGIN + boundedWaits).toBe(42_290_000);
        expect(LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS).toBe(3 * 60 * 60_000);
    });
});
