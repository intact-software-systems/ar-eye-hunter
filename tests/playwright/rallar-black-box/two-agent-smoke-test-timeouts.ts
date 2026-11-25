import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import { CONTROL_AGENT_OPENING_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-agent-opening-timeout-ms.ts';
import { RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';

import {
    computeTwoAgentConnectResultWaitMs,
    TWO_AGENT_DISCONNECT_SETTLE_MS,
    TWO_AGENT_EVIDENCE_POLL_TIMEOUT_MS,
    TWO_AGENT_GROUP_REQUEST_TIMEOUT_MS,
    TWO_AGENT_MESSAGE_POLL_TIMEOUT_MS,
    TWO_AGENT_RESULT_POLL_TIMEOUT_MS
} from './browser-rallar-two-agent-smoke.ts';

/** How long each connect waits for its one peer to be ready. */
const TWO_AGENT_PEER_READINESS_TIMEOUT_MS = 30_000;

/** Each connect waits for its one peer to be ready. */
export const TWO_AGENT_PEER_READINESS = {
    minReadyPeers: 1,
    timeoutMs: TWO_AGENT_PEER_READINESS_TIMEOUT_MS,
    intervalMs: 250
};

/** A delivery's send budget. */
export const TWO_AGENT_SEND_TIMEOUT_MS = 30_000;

/** A delivery's send budget once the reloaded agent has reconnected. */
export const TWO_AGENT_SEND_AFTER_RELOAD_TIMEOUT_MS = 45_000;

/** The two agents of a stage connect side by side, so a stage takes one connect's wait. */
export const TWO_AGENT_CONNECT_STAGE_WAIT_MS = computeTwoAgentConnectResultWaitMs(TWO_AGENT_PEER_READINESS);

/**
 * Each agent opens through its login gate, its workbench and its registration in turn, then the owner creates the
 * group and both agents join it, each request its budget and then the result poll.
 */
const AGENTS_AND_MEMBERSHIP_BOUNDED_WAITS_MS = 2 * 3 * CONTROL_AGENT_OPENING_TIMEOUT_MS +
    3 * (TWO_AGENT_GROUP_REQUEST_TIMEOUT_MS + TWO_AGENT_RESULT_POLL_TIMEOUT_MS);

/**
 * Each agent's health, stats, report recipe (whose one health names no budget), close and reset, the agents side by
 * side, then the evidence poll.
 */
const FINALIZATION_BOUNDED_WAITS_MS = 5 * TWO_AGENT_RESULT_POLL_TIMEOUT_MS + TWO_AGENT_EVIDENCE_POLL_TIMEOUT_MS;

/** The agents, the membership and the first connect stage every smoke opens with. */
const OPENING_BOUNDED_WAITS_MS = BROWSER_TEST_HARNESS_MARGIN_MS + AGENTS_AND_MEMBERSHIP_BOUNDED_WAITS_MS +
    TWO_AGENT_CONNECT_STAGE_WAIT_MS;

/** A delivery's send under its budget and then the result poll, the message poll, and, when shown, the inbox. */
function computeDeliveryBoundedWaitsMs(sendTimeoutMs: number, visibleInbox: boolean): number {
    return sendTimeoutMs + TWO_AGENT_RESULT_POLL_TIMEOUT_MS + TWO_AGENT_MESSAGE_POLL_TIMEOUT_MS +
        (visibleInbox ? RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS : 0);
}

/** The pair delivers each way, showing each message in its receiver's inbox, then finalizes. */
export const TWO_AGENT_DELIVERY_SMOKE_TEST_TIMEOUT_MS = OPENING_BOUNDED_WAITS_MS +
    2 * computeDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS, true) + FINALIZATION_BOUNDED_WAITS_MS;

/**
 * The pair delivers once and reads both healths; agent B reloads, shows its workbench and registers, reads its health,
 * reconnects and reads it again; the pair delivers each way and reads both healths, then finalizes.
 */
export const TWO_AGENT_RELOAD_SMOKE_TEST_TIMEOUT_MS = OPENING_BOUNDED_WAITS_MS +
    computeDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS, false) + 2 * TWO_AGENT_RESULT_POLL_TIMEOUT_MS +
    2 * CONTROL_AGENT_OPENING_TIMEOUT_MS + TWO_AGENT_RESULT_POLL_TIMEOUT_MS + TWO_AGENT_CONNECT_STAGE_WAIT_MS +
    TWO_AGENT_RESULT_POLL_TIMEOUT_MS +
    2 * computeDeliveryBoundedWaitsMs(TWO_AGENT_SEND_AFTER_RELOAD_TIMEOUT_MS, true) +
    2 * TWO_AGENT_RESULT_POLL_TIMEOUT_MS + FINALIZATION_BOUNDED_WAITS_MS;

/**
 * The pair delivers once and B reads its health; B closes and settles, reads its health, reconnects, receives a
 * delivery and reads its health, then the pair finalizes.
 */
export const TWO_AGENT_DISCONNECT_SMOKE_TEST_TIMEOUT_MS = OPENING_BOUNDED_WAITS_MS +
    computeDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS, false) + TWO_AGENT_RESULT_POLL_TIMEOUT_MS +
    TWO_AGENT_RESULT_POLL_TIMEOUT_MS + TWO_AGENT_DISCONNECT_SETTLE_MS + TWO_AGENT_RESULT_POLL_TIMEOUT_MS +
    TWO_AGENT_CONNECT_STAGE_WAIT_MS + computeDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS, false) +
    TWO_AGENT_RESULT_POLL_TIMEOUT_MS + FINALIZATION_BOUNDED_WAITS_MS;
