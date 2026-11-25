import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import { computeCommandResultWaitMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS,
    RALLAR_PAGE_CLEANUP_BOUNDED_WAITS_MS
} from './full-stack-helpers.ts';
import { CONTROL_GET_RETRY_BOUNDED_WAITS_MS } from './read-control-get-response.ts';

/** How long a command's result is polled for once its own budget, if it names one, is spent. */
const DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS = 45_000;

/** Each agent joins the room under the establishment SDK timeout and waits for no readiness. */
export const DIRECTOR_CONNECT_TIMING: RallarBlackBoxTestRtcConnectCommand = {
    kind: 'rtc.connect',
    timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
};

/** Each group creation or membership request's own budget. */
export const DIRECTOR_GROUP_REQUEST_TIMEOUT_MS = 10_000;

/** How long one health read of the peer readiness poll waits for its result; the poll's own limit bounds it. */
export const DIRECTOR_HEALTH_READ_TIMEOUT_MS = 15_000;

/** How long an agent's health is polled until it reports its expected peers ready. */
export const DIRECTOR_PEER_READINESS_POLL_TIMEOUT_MS = 60_000;

/** The appointment's own budget, and each relay start's. */
export const DIRECTOR_APPOINT_TIMEOUT_MS = 20_000;
export const DIRECTOR_RELAY_START_TIMEOUT_MS = 20_000;

/** How long a relayed intent may take to report the director's receipt. */
export const DIRECTOR_INTENT_RESULT_TIMEOUT_MS = 30_000;

/** How long the control run is polled for an agent's director event. */
export const DIRECTOR_EVENT_POLL_TIMEOUT_MS = 60_000;

/** How long the clients wait, once the director's relay stops, for its heartbeat to expire. */
export const DIRECTOR_STALE_HOLD_MS = 1_900;

/** The scenario's three agents. */
const DIRECTOR_AGENT_COUNT = 3;

/** A command that names no budget of its own is polled for its result alone. */
const UNBUDGETED_COMMAND_RESULT_WAIT_MS = DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS;

/** The owner creates the group, then each agent joins it, each request its budget and then the result poll. */
const MEMBERSHIP_BOUNDED_WAITS_MS = (1 + DIRECTOR_AGENT_COUNT) *
    (DIRECTOR_GROUP_REQUEST_TIMEOUT_MS + DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS);

/** A appoints itself under its budget, then each agent reads its status. */
const APPOINTMENT_BOUNDED_WAITS_MS = DIRECTOR_APPOINT_TIMEOUT_MS + DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS +
    DIRECTOR_AGENT_COUNT * UNBUDGETED_COMMAND_RESULT_WAIT_MS;

/** Each agent starts its relay under its budget, in turn. */
const RELAYS_BOUNDED_WAITS_MS = DIRECTOR_AGENT_COUNT *
    (DIRECTOR_RELAY_START_TIMEOUT_MS + DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS);

/** B and C request a sync in turn, then their snapshots arrive side by side. */
const SYNCS_BOUNDED_WAITS_MS = 2 * UNBUDGETED_COMMAND_RESULT_WAIT_MS + DIRECTOR_EVENT_POLL_TIMEOUT_MS;

/** A's relay stops, the stale hold, B's and C's status reads, then their relays stop. */
const STALE_BOUNDED_WAITS_MS = UNBUDGETED_COMMAND_RESULT_WAIT_MS + DIRECTOR_STALE_HOLD_MS +
    2 * UNBUDGETED_COMMAND_RESULT_WAIT_MS + 2 * UNBUDGETED_COMMAND_RESULT_WAIT_MS;

/**
 * Three agents opened in turn; the membership; their connects and then their peer readiness side by side; the
 * appointment and the status reads; the relays; B's and C's intents in turn; the intent and output events side by
 * side; the syncs and their snapshots; the stale checks; the run and its artifacts read; and the pages' cleanup side
 * by side.
 */
export const DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    DIRECTOR_AGENT_COUNT * BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS +
    MEMBERSHIP_BOUNDED_WAITS_MS +
    computeCommandResultWaitMs(DIRECTOR_CONNECT_TIMING, DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS) +
    DIRECTOR_PEER_READINESS_POLL_TIMEOUT_MS +
    APPOINTMENT_BOUNDED_WAITS_MS +
    RELAYS_BOUNDED_WAITS_MS +
    2 * DIRECTOR_INTENT_RESULT_TIMEOUT_MS +
    DIRECTOR_EVENT_POLL_TIMEOUT_MS +
    SYNCS_BOUNDED_WAITS_MS +
    STALE_BOUNDED_WAITS_MS +
    2 * CONTROL_GET_RETRY_BOUNDED_WAITS_MS +
    RALLAR_PAGE_CLEANUP_BOUNDED_WAITS_MS;

/** The wait a caller names for a command's result, or else the command's own budget and then the result poll. */
export function resolveDirectorCommandResultWaitMs(
    input: Readonly<{ command: RallarBlackBoxTestCommand; timeout?: number; }>
): number {
    return input.timeout ?? computeCommandResultWaitMs(input.command, DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS);
}
