import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestRtcConnectCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { BROWSER_TEST_HARNESS_MARGIN_MS } from './browser-test-harness-margin.ts';
import { computeCommandResultWaitMs } from './compute-command-result-wait-ms.ts';
import { BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS } from './full-stack-helpers.ts';

/** How long a command's result is polled for when the caller names no wait of its own. */
export const DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS = 45_000;

/** Each agent joins the room under the establishment SDK timeout and waits for no readiness. */
export const DIRECTOR_CONNECT_TIMING: RallarBlackBoxTestRtcConnectCommand = {
    kind: 'rtc.connect',
    timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
};

/** How long an agent's health is polled until it reports its expected peers ready. */
export const DIRECTOR_PEER_READINESS_POLL_TIMEOUT_MS = 60_000;

/** How long a relayed intent may take to report the director's receipt. */
export const DIRECTOR_INTENT_RESULT_TIMEOUT_MS = 30_000;

/** How long the control run is polled for an agent's director event. */
export const DIRECTOR_EVENT_POLL_TIMEOUT_MS = 60_000;

/** How long the clients wait, once the director's relay stops, for its heartbeat to expire. */
export const DIRECTOR_STALE_HOLD_MS = 1_900;

/**
 * Three agents opened in turn; their connects and then their peer readiness side by side; B's and C's intents in turn;
 * the intent and output events side by side; the snapshots side by side; and the stale hold.
 */
export const DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    3 * BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS +
    computeCommandResultWaitMs(DIRECTOR_CONNECT_TIMING, DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS) +
    DIRECTOR_PEER_READINESS_POLL_TIMEOUT_MS +
    2 * DIRECTOR_INTENT_RESULT_TIMEOUT_MS +
    2 * DIRECTOR_EVENT_POLL_TIMEOUT_MS +
    DIRECTOR_STALE_HOLD_MS;
