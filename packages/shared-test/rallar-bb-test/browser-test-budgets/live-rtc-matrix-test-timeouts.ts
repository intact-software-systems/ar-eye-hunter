import { BROWSER_TEST_HARNESS_MARGIN_MS } from './browser-test-harness-margin-ms.ts';
import { GROUP_MEMBERSHIP_BOUNDED_WAITS_MS } from './group-membership-waits.ts';
import {
    LIVE_RTC_AGENT_TRIO_OPEN_BOUNDED_WAITS_MS,
    LIVE_RTC_RECORDING_ADMISSION_BOUNDED_WAITS_MS
} from './live-rtc-agent-opening-waits.ts';
import {
    LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS,
    LIVE_RTC_CLOSE_RESULT_WAIT_MS,
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS,
    LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS,
    LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS,
    LIVE_RTC_PEER_READINESS_TIMEOUT_MS,
    LIVE_RTC_TRIO_SIZE
} from './live-rtc-control-waits.ts';
import {
    ALL_DELIVERY_PERMUTATIONS_BOUNDED_WAITS_MS,
    DELIVERY_MATRIX_BOUNDED_WAITS_MS,
    REALTIME_DELIVERY_MATRIX_BOUNDED_WAITS_MS
} from './live-rtc-delivery-matrix-waits.ts';
import {
    DELIVERY_CASE_BOUNDED_WAITS_MS,
    MATRIX_SEND_RESULT_WAIT_MS,
    MESSAGES_PROBES_BOUNDED_WAITS_MS,
    WS_AGENT_OPEN_SEND_CLOSE_BOUNDED_WAITS_MS
} from './live-rtc-delivery-waits.ts';
import {
    FORMATION_RECONNECT_BOUNDED_WAITS_MS,
    FORMATION_RUN_BOUNDED_WAITS_MS
} from './live-rtc-formation-waits.ts';
import { LIVE_RTC_ARTIFACT_EVIDENCE_BOUNDED_WAITS_MS } from './live-rtc-recorder-read-waits.ts';
import { SETTLED_TRIO_RETIREMENT_BOUNDED_WAITS_MS } from './settled-trio-retirement-bounded-waits-ms.ts';

/** How long a matrix test polls the control run for every key command's result once its scenarios end. */
export const MATRIX_RUN_RESULTS_POLL_TIMEOUT_MS = 20_000;

/** Each of the every-scenario test's group state readback requests' own budget: the group, then its events. */
export const GROUP_STATE_READBACK_REQUEST_TIMEOUT_MS = 10_000;

/** How long an attempt's cleanup waits for each open agent's best-effort close; the closes run side by side. */
export const LIVE_RTC_CLEANUP_CLOSE_TIMEOUT_MS = 15_000;

/** Peer C closes and reconnects once in every retention cycle. */
export const RETENTION_RECONNECT_CYCLES = 100;

/** The soak captures a checkpoint before its first cycle and after every this many cycles. */
export const RETENTION_CHECKPOINT_INTERVAL_CYCLES = 10;

/** A trio opens its agents, then admits each one's browser recording. */
const TRIO_OPENING_BOUNDED_WAITS_MS = LIVE_RTC_AGENT_TRIO_OPEN_BOUNDED_WAITS_MS +
    LIVE_RTC_RECORDING_ADMISSION_BOUNDED_WAITS_MS;

/** The group read and the group's events read, each its budget and then the result poll. */
const GROUP_STATE_READBACK_BOUNDED_WAITS_MS = 2 *
    (GROUP_STATE_READBACK_REQUEST_TIMEOUT_MS + LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS);

/** The WebSocket trio opens, sends and closes per agent, then each agent closes and resets. */
const WEB_SOCKET_TRIO_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE *
    (WS_AGENT_OPEN_SEND_CLOSE_BOUNDED_WAITS_MS + LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS);

/** A and B see C leave side by side, C reconnects, then B sends C a direct message and C waits for it. */
const RECONNECT_AND_DIRECT_MESSAGE_BOUNDED_WAITS_MS = LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS +
    FORMATION_RECONNECT_BOUNDED_WAITS_MS + MATRIX_SEND_RESULT_WAIT_MS + LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS;

/** Under a cluster API each agent waits for its peers in turn, then each sender reaches each receiver directly. */
export const CLUSTER_DIRECT_EXCHANGE_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE * LIVE_RTC_PEER_READINESS_TIMEOUT_MS +
    LIVE_RTC_TRIO_SIZE * 2 * DELIVERY_CASE_BOUNDED_WAITS_MS;

/**
 * A trio and a delivery matrix per transport, the realtime trio's membership, each trio's diagnostics, the realtime
 * trio's retirement, the messages probes, A's and B's closes and resets, the artifact evidence, the results poll and
 * the cleanup.
 */
export const LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    2 * TRIO_OPENING_BOUNDED_WAITS_MS +
    GROUP_MEMBERSHIP_BOUNDED_WAITS_MS +
    REALTIME_DELIVERY_MATRIX_BOUNDED_WAITS_MS +
    DELIVERY_MATRIX_BOUNDED_WAITS_MS +
    2 * LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS +
    SETTLED_TRIO_RETIREMENT_BOUNDED_WAITS_MS +
    MESSAGES_PROBES_BOUNDED_WAITS_MS +
    2 * LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS +
    LIVE_RTC_ARTIFACT_EVIDENCE_BOUNDED_WAITS_MS +
    MATRIX_RUN_RESULTS_POLL_TIMEOUT_MS +
    LIVE_RTC_CLEANUP_CLOSE_TIMEOUT_MS;

/**
 * Three trios, the realtime trio's membership and group state readback, every permutation per transport and each
 * transport's diagnostics, the realtime trio's retirement, the WebSocket trio, the messages probes, C's departure and
 * reconnect with the direct message to it, the messages trio's closes and resets, the artifact evidence, the results
 * poll and the cleanup.
 */
export const LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    3 * TRIO_OPENING_BOUNDED_WAITS_MS +
    GROUP_MEMBERSHIP_BOUNDED_WAITS_MS +
    GROUP_STATE_READBACK_BOUNDED_WAITS_MS +
    2 * ALL_DELIVERY_PERMUTATIONS_BOUNDED_WAITS_MS +
    2 * LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS +
    SETTLED_TRIO_RETIREMENT_BOUNDED_WAITS_MS +
    WEB_SOCKET_TRIO_BOUNDED_WAITS_MS +
    MESSAGES_PROBES_BOUNDED_WAITS_MS +
    RECONNECT_AND_DIRECT_MESSAGE_BOUNDED_WAITS_MS +
    LIVE_RTC_TRIO_SIZE * LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS +
    LIVE_RTC_ARTIFACT_EVIDENCE_BOUNDED_WAITS_MS +
    MATRIX_RUN_RESULTS_POLL_TIMEOUT_MS +
    LIVE_RTC_CLEANUP_CLOSE_TIMEOUT_MS;

/** Every retention cycle closes C, waits for A and B to see it leave side by side, then reconnects it. */
const RETENTION_CYCLE_BOUNDED_WAITS_MS = LIVE_RTC_CLOSE_RESULT_WAIT_MS + LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS +
    FORMATION_RECONNECT_BOUNDED_WAITS_MS;

/** The checkpoint before the first cycle, then one after every interval of cycles. */
const RETENTION_CHECKPOINTS = 1 + RETENTION_RECONNECT_CYCLES / RETENTION_CHECKPOINT_INTERVAL_CYCLES;

/**
 * A trio, its membership and formation, each checkpoint's diagnostics, every cycle, the closes and resets, the artifact
 * evidence and the cleanup.
 */
export const LIVE_RTC_RETENTION_SOAK_BOUNDED_WAITS_MS = TRIO_OPENING_BOUNDED_WAITS_MS +
    GROUP_MEMBERSHIP_BOUNDED_WAITS_MS +
    FORMATION_RUN_BOUNDED_WAITS_MS +
    RETENTION_CHECKPOINTS * LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS +
    RETENTION_RECONNECT_CYCLES * RETENTION_CYCLE_BOUNDED_WAITS_MS +
    LIVE_RTC_TRIO_SIZE * LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS +
    LIVE_RTC_ARTIFACT_EVIDENCE_BOUNDED_WAITS_MS +
    LIVE_RTC_CLEANUP_CLOSE_TIMEOUT_MS;

/**
 * The soak's operational limit. Each reconnect is bounded by its own wait, so a cycle that fails ends the soak; this
 * bound only limits a soak whose every cycle is slow but succeeds, which its derived sum would let outlast its job.
 */
export const RETENTION_SOAK_OPERATIONAL_BOUND_MS = 3 * 60 * 60_000;

/** The soak's bounded waits and the margin, capped at its operational bound. */
export const LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS = Math.min(
    BROWSER_TEST_HARNESS_MARGIN_MS + LIVE_RTC_RETENTION_SOAK_BOUNDED_WAITS_MS,
    RETENTION_SOAK_OPERATIONAL_BOUND_MS
);
