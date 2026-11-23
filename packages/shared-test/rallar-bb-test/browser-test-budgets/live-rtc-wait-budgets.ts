import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '../fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestRtcConnectCommand } from '../rallar-black-box-test-contracts.ts';

import { computeCommandResultWaitMs } from './compute-command-result-wait-ms.ts';
import { CONTROL_AGENT_OPENING_TIMEOUT_MS } from './control-agent-opening-timeout-ms.ts';

// The live RTC harness's wait budgets live in this package rather than beside the Playwright modules that run them, so
// the RTC-B06 capture orchestrator can derive an attempt's test timeout without loading Playwright or the test tree.

/** How long the control client polls for a command's result once the command's own budget is spent. */
export const LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS = 45_000;

/** How long the control client waits for a receiver to record a sent message. */
export const LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS = 60_000;

/** How long the control client waits for an agent to report its expected peers ready. */
export const LIVE_RTC_PEER_READINESS_TIMEOUT_MS = 60_000;

/** How long the control client waits for an agent to stop reporting a departed peer ready. */
export const LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS = 60_000;

/** A live RTC agent opens until it registers with the control server; a trio opens its agents one after another. */
export const LIVE_RTC_AGENT_TRIO_OPEN_BOUNDED_WAITS_MS = 3 * CONTROL_AGENT_OPENING_TIMEOUT_MS;

/** Each group membership request's own budget. */
export const GROUP_MEMBERSHIP_REQUEST_TIMEOUT_MS = 10_000;

/** The owner creates the trio's group, then the two other members join it, one request after another. */
export const GROUP_MEMBERSHIP_BOUNDED_WAITS_MS = 3 * GROUP_MEMBERSHIP_REQUEST_TIMEOUT_MS;

/** How long the control client waits for an agent's close to return. */
export const LIVE_RTC_CLOSE_RESULT_WAIT_MS = 45_000;

/** How long the control client waits for an agent's reset to return. */
export const LIVE_RTC_RESET_RESULT_WAIT_MS = 30_000;

/** Retiring an agent closes it, then resets it. */
export const LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS = LIVE_RTC_CLOSE_RESULT_WAIT_MS + LIVE_RTC_RESET_RESULT_WAIT_MS;

/** How long the control client waits for one agent's diagnostics read. */
export const LIVE_RTC_DIAGNOSTICS_READ_TIMEOUT_MS = 30_000;

/** A diagnostics capture reads each of the trio's agents in turn. */
export const LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS = 3 * LIVE_RTC_DIAGNOSTICS_READ_TIMEOUT_MS;

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

/** A delivery matrix send's own budget for opening the transport and sending. */
export const MATRIX_SEND_TIMEOUT_MS = 60_000;

/** How long a receiver's visible inbox may take to show a delivered matrix message. */
export const MATRIX_INBOX_TIMEOUT_MS = 30_000;

/** The not-yet-in-sync probe's send budget. */
export const NACK_PROBE_SEND_TIMEOUT_MS = 45_000;

/** How long the probe's sender polls its wire observation for the receiver's NACK. */
export const NACK_RECEIPT_POLL_TIMEOUT_MS = 15_000;

/** The send a closed transport must refuse, under its own budget. */
export const STALE_SEND_TIMEOUT_MS = 10_000;

/** Each agent's WebSocket open in the open-send-close matrix. */
export const WS_OPEN_TIMEOUT_MS = 15_000;

/** A delivery case sends while its receivers wait for the message, so it takes the longer of the two. */
export const DELIVERY_CASE_BOUNDED_WAITS_MS = Math.max(MATRIX_SEND_TIMEOUT_MS, LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS);
