import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import { computeCommandWaitMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';
import { GROUP_MEMBERSHIP_BOUNDED_WAITS_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/group-membership-waits.ts';
import {
    LIVE_RTC_AGENT_TRIO_OPEN_BOUNDED_WAITS_MS,
    LIVE_RTC_RECORDING_ADMISSION_BOUNDED_WAITS_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-agent-opening-waits.ts';
import {
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    LIVE_RTC_TRIO_SIZE,
    LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-control-waits.ts';
import { LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-diagnostics-waits.ts';
import { FORMATION_RUN_BOUNDED_WAITS_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-formation-waits.ts';

import {
    computeLayoutSwitchStreamResultPollTimeoutMs,
    LAYOUT_SWITCH_CONFIG_READ_TIMEOUT_MS,
    LAYOUT_SWITCH_TOPOLOGY_WRITE_TIMEOUT_MS
} from './live-rtc-layout-switch-operations.ts';

/** How long the streams run before the owner issues the first switch. */
export const LAYOUT_SWITCH_STREAM_LEAD_MS = 3_000;

/** Outside the 15 s overlap of the previous switch, so the two promotions never share one overlap. */
export const LAYOUT_SWITCH_HOLD_MS = 16_000;

/** This spec's bound on each promotion poll; it also sizes the streams, which must be fixed before they start. */
export const LAYOUT_SWITCH_PROMOTION_POLL_TIMEOUT_MS = 15_000;

/** How long each promotion poll waits between its reads of the browsers' layouts. */
export const LAYOUT_SWITCH_PROMOTION_POLL_INTERVAL_MS = 1_000;

/** The streams run through the lead and both switches, each switch its promotion poll and then its hold. */
export const LAYOUT_SWITCH_STREAM_DURATION_MS = LAYOUT_SWITCH_STREAM_LEAD_MS +
    2 * (LAYOUT_SWITCH_PROMOTION_POLL_TIMEOUT_MS + LAYOUT_SWITCH_HOLD_MS);

/**
 * How long the receivers' events may take to drain once the streams settled: a drain as long as the stream it drains,
 * since the events are published as the frames arrive. A drain the limit ends says so, so a slow run is told apart
 * from lost frames.
 */
export const LAYOUT_SWITCH_RECEIVER_DRAIN_TIMEOUT_MS = LAYOUT_SWITCH_STREAM_DURATION_MS;

/** How long the drain waits between its reads of the run. */
export const LAYOUT_SWITCH_RECEIVER_DRAIN_POLL_INTERVAL_MS = 1_000;

/**
 * Each of the layout-switch operations, as `LiveRtcLayoutSwitchOperations` runs it: every one a command, enqueued and
 * then polled for its result; a browser's health read names no budget of its own.
 */
export const LIVE_RTC_LAYOUT_SWITCH_OPERATION_BOUNDED_WAITS_MS = {
    configRead: computeCommandWaitMs(LAYOUT_SWITCH_CONFIG_READ_TIMEOUT_MS + LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS),
    topologyWrite: computeCommandWaitMs(
        LAYOUT_SWITCH_TOPOLOGY_WRITE_TIMEOUT_MS + LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS
    ),
    health: LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS,
    stream: computeCommandWaitMs(computeLayoutSwitchStreamResultPollTimeoutMs(LAYOUT_SWITCH_STREAM_DURATION_MS))
};

/** Every browser's accepted layout, read one browser after another. */
const COMMON_LAYOUT_READ_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE * LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS;

/**
 * The lead, switch 1's write and promotion poll, its hold, the tree's layout read, each leaf's health (every browser
 * but the tree's one relay), then switch 2's write and promotion poll.
 */
const SWITCHES_BOUNDED_WAITS_MS = LAYOUT_SWITCH_STREAM_LEAD_MS +
    LIVE_RTC_LAYOUT_SWITCH_OPERATION_BOUNDED_WAITS_MS.topologyWrite + LAYOUT_SWITCH_PROMOTION_POLL_TIMEOUT_MS +
    LAYOUT_SWITCH_HOLD_MS + COMMON_LAYOUT_READ_BOUNDED_WAITS_MS +
    (LIVE_RTC_TRIO_SIZE - 1) * LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS +
    LIVE_RTC_LAYOUT_SWITCH_OPERATION_BOUNDED_WAITS_MS.topologyWrite + LAYOUT_SWITCH_PROMOTION_POLL_TIMEOUT_MS;

/**
 * The receivers' drain reads the run until its limit, its hold never passing it, so its last read may start just
 * before the limit and wait its request.
 */
const RECEIVER_DRAIN_BOUNDED_WAITS_MS = LAYOUT_SWITCH_RECEIVER_DRAIN_TIMEOUT_MS + CONTROL_REQUEST_TIMEOUT_MS;

/**
 * The trio, its recording admission, membership and formation; the served overlap and the formed layout; the streams
 * side by side with the switches; the receivers' drain; the diagnostics every outcome captures, then the run summary's
 * read.
 */
export const LIVE_RTC_LAYOUT_SWITCH_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    LIVE_RTC_AGENT_TRIO_OPEN_BOUNDED_WAITS_MS + LIVE_RTC_RECORDING_ADMISSION_BOUNDED_WAITS_MS +
    GROUP_MEMBERSHIP_BOUNDED_WAITS_MS + FORMATION_RUN_BOUNDED_WAITS_MS +
    LIVE_RTC_LAYOUT_SWITCH_OPERATION_BOUNDED_WAITS_MS.configRead + COMMON_LAYOUT_READ_BOUNDED_WAITS_MS +
    Math.max(LIVE_RTC_LAYOUT_SWITCH_OPERATION_BOUNDED_WAITS_MS.stream, SWITCHES_BOUNDED_WAITS_MS) +
    RECEIVER_DRAIN_BOUNDED_WAITS_MS + LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS + CONTROL_REQUEST_TIMEOUT_MS;
