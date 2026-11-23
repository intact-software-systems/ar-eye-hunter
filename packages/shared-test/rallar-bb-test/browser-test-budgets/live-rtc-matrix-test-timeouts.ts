import { BROWSER_TEST_HARNESS_MARGIN_MS } from './browser-test-harness-margin.ts';
import {
    DELIVERY_CASE_BOUNDED_WAITS_MS,
    FORMATION_CONNECT_RESULT_WAIT_MS,
    FORMATION_RECONNECT_BOUNDED_WAITS_MS,
    FORMATION_RUN_BOUNDED_WAITS_MS,
    FORMATION_RUN_CONNECT_RESULT_WAIT_MS,
    LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS,
    LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS,
    LIVE_RTC_PEER_READINESS_TIMEOUT_MS,
    MATRIX_INBOX_TIMEOUT_MS,
    MATRIX_SEND_TIMEOUT_MS,
    NACK_PROBE_SEND_TIMEOUT_MS,
    NACK_RECEIPT_POLL_TIMEOUT_MS,
    STALE_SEND_TIMEOUT_MS,
    WS_OPEN_TIMEOUT_MS
} from './live-rtc-wait-budgets.ts';

/** How long a matrix test polls the control run for every key command's result once its scenarios end. */
export const MATRIX_RUN_RESULTS_POLL_TIMEOUT_MS = 20_000;

/** The retention soak's steps besides its formation connects and the reconnects. */
const RETENTION_STEPS_TIMEOUT_MS = 1_800_000;

/** Peer C closes and reconnects once in every retention cycle. */
export const RETENTION_RECONNECT_CYCLES = 100;

/** The owner's matrix: the formation, three deliveries, and the direct and broadcast receivers' visible inboxes. */
const DELIVERY_MATRIX_BOUNDED_WAITS_MS = FORMATION_RUN_BOUNDED_WAITS_MS + 3 * DELIVERY_CASE_BOUNDED_WAITS_MS +
    2 * MATRIX_INBOX_TIMEOUT_MS;

/** Each of the three senders' two direct deliveries, its multicast and its broadcast, after the formation. */
const ALL_DELIVERY_PERMUTATIONS_BOUNDED_WAITS_MS = FORMATION_RUN_BOUNDED_WAITS_MS +
    3 * 4 * DELIVERY_CASE_BOUNDED_WAITS_MS;

/** Retiring a settled trio: A and B see C leave side by side, then A sees B leave. */
const SETTLED_TRIO_RETIREMENT_BOUNDED_WAITS_MS = 2 * LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS;

/** The NACK probe's send and its receipt poll, then the closed transport's refused send. */
const MESSAGES_PROBES_BOUNDED_WAITS_MS = NACK_PROBE_SEND_TIMEOUT_MS + NACK_RECEIPT_POLL_TIMEOUT_MS +
    STALE_SEND_TIMEOUT_MS;

/** Under a cluster API each agent waits for its peers in turn, then each sender reaches each receiver directly. */
export const CLUSTER_DIRECT_EXCHANGE_BOUNDED_WAITS_MS = 3 * LIVE_RTC_PEER_READINESS_TIMEOUT_MS +
    3 * 2 * DELIVERY_CASE_BOUNDED_WAITS_MS;

/** A delivery matrix per transport, the realtime trio's retirement, the messages probes and the results poll. */
export const LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    2 * DELIVERY_MATRIX_BOUNDED_WAITS_MS +
    SETTLED_TRIO_RETIREMENT_BOUNDED_WAITS_MS +
    MESSAGES_PROBES_BOUNDED_WAITS_MS +
    MATRIX_RUN_RESULTS_POLL_TIMEOUT_MS;

/**
 * Every permutation per transport, the realtime trio's retirement, the WebSocket opens, the messages probes, C's
 * departure and reconnect, the direct message to the reconnected C, and the results poll.
 */
export const LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    2 * ALL_DELIVERY_PERMUTATIONS_BOUNDED_WAITS_MS +
    SETTLED_TRIO_RETIREMENT_BOUNDED_WAITS_MS +
    3 * WS_OPEN_TIMEOUT_MS +
    MESSAGES_PROBES_BOUNDED_WAITS_MS +
    LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS +
    FORMATION_RECONNECT_BOUNDED_WAITS_MS +
    MATRIX_SEND_TIMEOUT_MS +
    LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS +
    MATRIX_RUN_RESULTS_POLL_TIMEOUT_MS;

/**
 * The soak's operational limit. Each reconnect is bounded by its own wait, so a cycle that fails ends the soak; this
 * bound only limits a soak whose every cycle is slow but succeeds, which its derived sum would let outlast its job.
 */
export const RETENTION_SOAK_OPERATIONAL_BOUND_MS = 3 * 60 * 60_000;

/** One formation, then a reconnect in every cycle, up to the soak's operational bound. */
export const LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS = Math.min(
    RETENTION_STEPS_TIMEOUT_MS + FORMATION_RUN_CONNECT_RESULT_WAIT_MS +
        RETENTION_RECONNECT_CYCLES * FORMATION_CONNECT_RESULT_WAIT_MS,
    RETENTION_SOAK_OPERATIONAL_BOUND_MS
);
