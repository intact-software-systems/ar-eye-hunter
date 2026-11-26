import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import {
    computeCommandResultWaitMs,
    computeEnqueuedCommandWaitMs
} from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { CONTROL_AGENT_OPENING_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-agent-opening-timeout-ms.ts';
import { RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';

import {
    computeTwoAgentConnectResultWaitMs,
    toTwoAgentFinalizationCommands,
    TWO_AGENT_DISCONNECT_SETTLE_MS,
    TWO_AGENT_EVIDENCE_POLL_TIMEOUT_MS,
    TWO_AGENT_GROUP_REQUEST_TIMEOUT_MS,
    TWO_AGENT_MESSAGE_POLL_TIMEOUT_MS,
    TWO_AGENT_RESULT_POLL_TIMEOUT_MS,
    TWO_AGENT_SIDES
} from './browser-rallar-two-agent-smoke.ts';

/** How long each connect waits for its one peer to be ready. */
const TWO_AGENT_PEER_READINESS_TIMEOUT_MS = 30_000;

/** How long each connect's readiness wait pauses between its reads. */
const TWO_AGENT_PEER_READINESS_INTERVAL_MS = 250;

/** Each connect waits for its one peer to be ready. */
export const TWO_AGENT_PEER_READINESS = {
    minReadyPeers: 1,
    timeoutMs: TWO_AGENT_PEER_READINESS_TIMEOUT_MS,
    intervalMs: TWO_AGENT_PEER_READINESS_INTERVAL_MS
};

/** A delivery's send budget. */
export const TWO_AGENT_SEND_TIMEOUT_MS = 30_000;

/** A delivery's send budget once the reloaded agent has reconnected. */
export const TWO_AGENT_SEND_AFTER_RELOAD_TIMEOUT_MS = 45_000;

/** A command that names no budget of its own waits its enqueue request, then the whole result poll. */
const TWO_AGENT_UNBUDGETED_COMMAND_WAIT_MS = computeEnqueuedCommandWaitMs(TWO_AGENT_RESULT_POLL_TIMEOUT_MS);

/** The two agents of a stage connect side by side, so a stage takes one connect's wait. */
export const TWO_AGENT_CONNECT_STAGE_WAIT_MS = computeTwoAgentConnectResultWaitMs(TWO_AGENT_PEER_READINESS);

/** The smoke's operations' bounded waits, each as `BrowserRallarTwoAgentSmoke` runs it. */
export const TWO_AGENT_OPERATION_BOUNDED_WAITS_MS = {
    /** `openAgent` through the login gate: its heading, its workbench button, then its registration. */
    signInOpen: 3 * CONTROL_AGENT_OPENING_TIMEOUT_MS,
    /** `joinRoom`: the owner creates the group, then each agent joins it, each its enqueue, budget and result poll. */
    membership: (1 + TWO_AGENT_SIDES.length) *
        computeEnqueuedCommandWaitMs(TWO_AGENT_GROUP_REQUEST_TIMEOUT_MS + TWO_AGENT_RESULT_POLL_TIMEOUT_MS),
    /** `reloadAgent`: its workbench button, then its registration. */
    reload: 2 * CONTROL_AGENT_OPENING_TIMEOUT_MS,
    /** `finalizeAgent`: each finalization command its enqueue, its budget if it names one, and then the result poll. */
    finalization: toTwoAgentFinalizationCommands('agent', 'suffix').reduce(
        (sum, { command }) => sum + computeCommandResultWaitMs(command, TWO_AGENT_RESULT_POLL_TIMEOUT_MS),
        0
    ),
    /** `disconnectAgent`: the close, a command that names no budget, then the settle. */
    disconnect: TWO_AGENT_UNBUDGETED_COMMAND_WAIT_MS + TWO_AGENT_DISCONNECT_SETTLE_MS
};

/** The agents finalize side by side, then the run is polled for the evidence. */
const FINALIZATION_BOUNDED_WAITS_MS = TWO_AGENT_OPERATION_BOUNDED_WAITS_MS.finalization +
    TWO_AGENT_EVIDENCE_POLL_TIMEOUT_MS;

/** The agents, opened in turn, the membership and the first connect stage every smoke opens with. */
const OPENING_BOUNDED_WAITS_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    TWO_AGENT_SIDES.length * TWO_AGENT_OPERATION_BOUNDED_WAITS_MS.signInOpen +
    TWO_AGENT_OPERATION_BOUNDED_WAITS_MS.membership + TWO_AGENT_CONNECT_STAGE_WAIT_MS;

/**
 * A delivery's send, enqueued and then polled under its budget and the result poll, the message poll, and, when shown,
 * the inbox.
 */
export function computeTwoAgentDeliveryBoundedWaitsMs(sendTimeoutMs: number, visibleInbox: boolean): number {
    return computeEnqueuedCommandWaitMs(sendTimeoutMs + TWO_AGENT_RESULT_POLL_TIMEOUT_MS) +
        TWO_AGENT_MESSAGE_POLL_TIMEOUT_MS +
        (visibleInbox ? RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS : 0);
}

/** The pair delivers each way, showing each message in its receiver's inbox, then finalizes. */
export const TWO_AGENT_DELIVERY_SMOKE_TEST_TIMEOUT_MS = OPENING_BOUNDED_WAITS_MS +
    2 * computeTwoAgentDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS, true) + FINALIZATION_BOUNDED_WAITS_MS;

/**
 * The pair delivers once and reads both healths; agent B reloads, reads its health, reconnects and reads it again; the
 * pair delivers each way and reads both healths, then finalizes. A health read names no budget.
 */
export const TWO_AGENT_RELOAD_SMOKE_TEST_TIMEOUT_MS = OPENING_BOUNDED_WAITS_MS +
    computeTwoAgentDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS, false) + 2 * TWO_AGENT_UNBUDGETED_COMMAND_WAIT_MS +
    TWO_AGENT_OPERATION_BOUNDED_WAITS_MS.reload + TWO_AGENT_UNBUDGETED_COMMAND_WAIT_MS +
    TWO_AGENT_CONNECT_STAGE_WAIT_MS +
    TWO_AGENT_UNBUDGETED_COMMAND_WAIT_MS +
    2 * computeTwoAgentDeliveryBoundedWaitsMs(TWO_AGENT_SEND_AFTER_RELOAD_TIMEOUT_MS, true) +
    2 * TWO_AGENT_UNBUDGETED_COMMAND_WAIT_MS + FINALIZATION_BOUNDED_WAITS_MS;

/**
 * The pair delivers once and B reads its health; B disconnects, reads its health, reconnects, receives a delivery and
 * reads its health, then the pair finalizes.
 */
export const TWO_AGENT_DISCONNECT_SMOKE_TEST_TIMEOUT_MS = OPENING_BOUNDED_WAITS_MS +
    computeTwoAgentDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS, false) + TWO_AGENT_UNBUDGETED_COMMAND_WAIT_MS +
    TWO_AGENT_OPERATION_BOUNDED_WAITS_MS.disconnect + TWO_AGENT_UNBUDGETED_COMMAND_WAIT_MS +
    TWO_AGENT_CONNECT_STAGE_WAIT_MS + computeTwoAgentDeliveryBoundedWaitsMs(TWO_AGENT_SEND_TIMEOUT_MS, false) +
    TWO_AGENT_UNBUDGETED_COMMAND_WAIT_MS + FINALIZATION_BOUNDED_WAITS_MS;
