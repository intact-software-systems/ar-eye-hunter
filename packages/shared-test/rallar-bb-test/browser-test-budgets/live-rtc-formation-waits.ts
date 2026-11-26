import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '../fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestRtcConnectCommand } from '../rallar-black-box-test-contracts.ts';

import { computeCommandResultWaitMs, computeEnqueuedCommandWaitMs } from './compute-command-result-wait-ms.ts';
import {
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    LIVE_RTC_PEER_READINESS_TIMEOUT_MS,
    LIVE_RTC_TRIO_SIZE,
    LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS
} from './live-rtc-control-waits.ts';
import { FORMATION_CYCLE_COMMAND_POLLS } from './live-rtc-formation-command-counts.ts';

/** How long a formation readiness refreshes the room and waits for the formation's exact peers. */
export const FORMATION_READINESS_TIMEOUT_MS = 60_000;

/**
 * Each readiness read names the time left before the deadline as its budget, so the last may start just before the
 * deadline and then wait its enqueue request and the result poll.
 */
export const FORMATION_READINESS_BOUNDED_WAITS_MS = FORMATION_READINESS_TIMEOUT_MS +
    LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS;

/** The formation's mesh topology configuration request's own budget. */
export const FORMATION_TOPOLOGY_CONFIG_TIMEOUT_MS = 10_000;

/** How long the formation driver polls for the result of each enqueued read of the group's state. */
export const FORMATION_GROUP_READ_RESULT_POLL_TIMEOUT_MS = 15_000;

/** How long the formation driver polls the group for the sessions it has connected. */
export const FORMATION_PRESENCE_POLL_TIMEOUT_MS = 30_000;

/** How long the formation driver polls the topology for the layout its plan publishes. */
export const FORMATION_PLANNED_LAYOUT_POLL_TIMEOUT_MS = 30_000;

/** A formation connect joins the room under the establishment SDK timeout; the driver waits for readiness apart. */
export const FORMATION_CONNECT_TIMING: RallarBlackBoxTestRtcConnectCommand = {
    kind: 'rtc.connect',
    timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
};

/** How long the driver waits for one formation connect's result, so a test can cover each connect it runs. */
export const FORMATION_CONNECT_RESULT_WAIT_MS = computeCommandResultWaitMs(
    FORMATION_CONNECT_TIMING,
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS
);

/** A formation run connects A, B and C one after another. */
export const FORMATION_RUN_CONNECT_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE * FORMATION_CONNECT_RESULT_WAIT_MS;

/**
 * How long each of a formation cycle's owner commands is polled for its result: the mesh configuration its budget and
 * then the result poll, the group read its own result poll, and a command that names no budget the result poll alone.
 */
const FORMATION_CYCLE_COMMAND_RESULT_POLL_TIMEOUTS_MS = {
    'mesh-configuration': FORMATION_TOPOLOGY_CONFIG_TIMEOUT_MS + LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    'group-read': FORMATION_GROUP_READ_RESULT_POLL_TIMEOUT_MS,
    unbudgeted: LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS
} as const;

/** One formation cycle's owner commands, each enqueued and then polled for its result, and the planned layout poll. */
const FORMATION_CYCLE_COMMANDS_BOUNDED_WAITS_MS = FORMATION_CYCLE_COMMAND_POLLS.reduce(
    (sum, poll) => sum + computeEnqueuedCommandWaitMs(FORMATION_CYCLE_COMMAND_RESULT_POLL_TIMEOUTS_MS[poll]),
    FORMATION_PLANNED_LAYOUT_POLL_TIMEOUT_MS
);

/**
 * A formation run connects A, B and C one after another and polls presence after each; the pair and then the trio
 * each run a formation cycle and wait for readiness side by side across their agents, the pair's peers first waiting
 * for each other's readiness before its activation.
 */
export const FORMATION_RUN_BOUNDED_WAITS_MS = FORMATION_RUN_CONNECT_BOUNDED_WAITS_MS +
    LIVE_RTC_TRIO_SIZE * FORMATION_PRESENCE_POLL_TIMEOUT_MS +
    2 * (FORMATION_CYCLE_COMMANDS_BOUNDED_WAITS_MS + FORMATION_READINESS_BOUNDED_WAITS_MS) +
    LIVE_RTC_PEER_READINESS_TIMEOUT_MS;

/** A reconnecting member connects, then it and the survivors wait for readiness side by side. */
export const FORMATION_RECONNECT_BOUNDED_WAITS_MS = FORMATION_CONNECT_RESULT_WAIT_MS +
    FORMATION_READINESS_BOUNDED_WAITS_MS;
