import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '../fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestRtcConnectCommand } from '../rallar-black-box-test-contracts.ts';

import { computeCommandResultWaitMs, computeCommandWaitMs } from './compute-command-result-wait-ms.ts';
import {
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    LIVE_RTC_PEER_READINESS_TIMEOUT_MS,
    LIVE_RTC_TRIO_SIZE,
    LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS
} from './live-rtc-control-waits.ts';

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

/** How long the formation driver waits for each read of the group's state. */
export const FORMATION_GROUP_READ_TIMEOUT_MS = 15_000;

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
export const FORMATION_RUN_CONNECT_RESULT_WAIT_MS = LIVE_RTC_TRIO_SIZE * FORMATION_CONNECT_RESULT_WAIT_MS;

/**
 * One formation cycle's owner commands: the mesh configuration under its budget, the group read under its result
 * wait, the plan or reconfigure, the planned layout poll, the layout's connect and the activation. The plan, the
 * connect and the activation name no budget of their own; every command is enqueued, then polled for its result.
 */
const FORMATION_CYCLE_COMMANDS_BOUNDED_WAITS_MS = computeCommandWaitMs(
    FORMATION_TOPOLOGY_CONFIG_TIMEOUT_MS + LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS
) + computeCommandWaitMs(FORMATION_GROUP_READ_TIMEOUT_MS) + FORMATION_PLANNED_LAYOUT_POLL_TIMEOUT_MS +
    3 * LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS;

/**
 * A formation run connects A, B and C one after another and polls presence after each; the pair and then the trio
 * each run a formation cycle and wait for readiness side by side across their agents, the pair's peers first waiting
 * for each other's readiness before its activation.
 */
export const FORMATION_RUN_BOUNDED_WAITS_MS = FORMATION_RUN_CONNECT_RESULT_WAIT_MS +
    LIVE_RTC_TRIO_SIZE * FORMATION_PRESENCE_POLL_TIMEOUT_MS +
    2 * (FORMATION_CYCLE_COMMANDS_BOUNDED_WAITS_MS + FORMATION_READINESS_BOUNDED_WAITS_MS) +
    LIVE_RTC_PEER_READINESS_TIMEOUT_MS;

/** A reconnecting member connects, then it and the survivors wait for readiness side by side. */
export const FORMATION_RECONNECT_BOUNDED_WAITS_MS = FORMATION_CONNECT_RESULT_WAIT_MS +
    FORMATION_READINESS_BOUNDED_WAITS_MS;
