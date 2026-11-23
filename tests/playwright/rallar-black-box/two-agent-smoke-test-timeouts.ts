import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin.ts';
import {
    computeTwoAgentConnectResultWaitMs,
    TWO_AGENT_EVIDENCE_POLL_TIMEOUT_MS,
    TWO_AGENT_MESSAGE_POLL_TIMEOUT_MS,
    TWO_AGENT_RELOAD_SCREEN_TIMEOUT_MS
} from './browser-rallar-two-agent-smoke.ts';

/** Each connect waits for its one peer to be ready. */
export const TWO_AGENT_PEER_READINESS = { minReadyPeers: 1, timeoutMs: 30_000, intervalMs: 250 };

/** A delivery's send budget. */
export const TWO_AGENT_SEND_TIMEOUT_MS = 30_000;

/** A delivery's send budget once the reloaded agent has reconnected. */
export const TWO_AGENT_SEND_AFTER_RELOAD_TIMEOUT_MS = 45_000;

/** The two agents of a stage connect side by side, so a stage takes one connect's wait. */
export const TWO_AGENT_CONNECT_STAGE_WAIT_MS = computeTwoAgentConnectResultWaitMs(TWO_AGENT_PEER_READINESS);

/** A delivery sends, then polls for the received message. */
function computeDeliveryBoundedWaitsMs(sendTimeoutMs: number): number {
    return sendTimeoutMs + TWO_AGENT_MESSAGE_POLL_TIMEOUT_MS;
}

/** The pair connects, delivers each way, and the run is polled for the evidence. */
export const TWO_AGENT_DELIVERY_SMOKE_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    TWO_AGENT_CONNECT_STAGE_WAIT_MS + 2 * computeDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS) +
    TWO_AGENT_EVIDENCE_POLL_TIMEOUT_MS;

/**
 * The pair connects and delivers once; agent B reloads, shows its workbench and registers, then reconnects; the pair
 * delivers each way, and the run is polled for the evidence.
 */
export const TWO_AGENT_RELOAD_SMOKE_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    TWO_AGENT_CONNECT_STAGE_WAIT_MS + computeDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS) +
    2 * TWO_AGENT_RELOAD_SCREEN_TIMEOUT_MS + TWO_AGENT_CONNECT_STAGE_WAIT_MS +
    2 * computeDeliveryBoundedWaitsMs(TWO_AGENT_SEND_AFTER_RELOAD_TIMEOUT_MS) + TWO_AGENT_EVIDENCE_POLL_TIMEOUT_MS;
