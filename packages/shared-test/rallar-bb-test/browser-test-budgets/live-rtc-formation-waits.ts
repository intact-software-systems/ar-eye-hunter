import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '../fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestRtcConnectCommand } from '../rallar-black-box-test-contracts.ts';

import { computeCommandResultWaitMs } from './compute-command-result-wait-ms.ts';
import {
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    LIVE_RTC_PEER_READINESS_TIMEOUT_MS
} from './live-rtc-control-waits.ts';

/** How long a formation readiness refreshes the room and waits for the formation's exact peers. */
export const FORMATION_READINESS_TIMEOUT_MS = 60_000;

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
export const FORMATION_RUN_CONNECT_RESULT_WAIT_MS = 3 * FORMATION_CONNECT_RESULT_WAIT_MS;

/**
 * A formation run connects A, B and C one after another and polls presence after each; the pair and then the trio
 * each configure the mesh, read the group, and publish a layout the driver polls for; the pair's peer readiness, the
 * pair's readiness and the trio's readiness each run side by side across their agents.
 */
export const FORMATION_RUN_BOUNDED_WAITS_MS = FORMATION_RUN_CONNECT_RESULT_WAIT_MS +
    3 * FORMATION_PRESENCE_POLL_TIMEOUT_MS +
    2 * (FORMATION_TOPOLOGY_CONFIG_TIMEOUT_MS + FORMATION_GROUP_READ_TIMEOUT_MS) +
    2 * FORMATION_PLANNED_LAYOUT_POLL_TIMEOUT_MS +
    LIVE_RTC_PEER_READINESS_TIMEOUT_MS +
    2 * FORMATION_READINESS_TIMEOUT_MS;

/** A reconnecting member connects, then it and the survivors wait for readiness side by side. */
export const FORMATION_RECONNECT_BOUNDED_WAITS_MS = FORMATION_CONNECT_RESULT_WAIT_MS + FORMATION_READINESS_TIMEOUT_MS;
