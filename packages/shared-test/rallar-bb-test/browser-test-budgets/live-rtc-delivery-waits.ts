import {
    LIVE_RTC_CLOSE_RESULT_WAIT_MS,
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS
} from './live-rtc-control-waits.ts';
import { FULL_STACK_TAB_OPEN_BOUNDED_WAITS_MS } from './playwright-expect-timeouts.ts';

// A command that names its own budget is waited for that budget, then the control client's result poll, which is what
// `computeCommandResultWaitMs` derives from the command itself.

/** A delivery matrix send's own budget for opening the transport and sending. */
export const MATRIX_SEND_TIMEOUT_MS = 60_000;

/** How long the control client waits for a matrix send's result. */
export const MATRIX_SEND_RESULT_WAIT_MS = MATRIX_SEND_TIMEOUT_MS + LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS;

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
export const DELIVERY_CASE_BOUNDED_WAITS_MS = Math.max(MATRIX_SEND_RESULT_WAIT_MS, LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS);

/** A receiver opens its Manual Rallar tab, then its inbox shows the message. */
export const MATRIX_INBOX_OBSERVATION_BOUNDED_WAITS_MS = FULL_STACK_TAB_OPEN_BOUNDED_WAITS_MS + MATRIX_INBOX_TIMEOUT_MS;

/** Each WebSocket agent configures, opens, sends and closes, each polled for its result; only the open has a budget. */
export const WS_AGENT_OPEN_SEND_CLOSE_BOUNDED_WAITS_MS = WS_OPEN_TIMEOUT_MS +
    4 * LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS;

/** The NACK probe's send and its receipt poll, then the transport's close and the refused send that follows it. */
export const MESSAGES_PROBES_BOUNDED_WAITS_MS = NACK_PROBE_SEND_TIMEOUT_MS + LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS +
    NACK_RECEIPT_POLL_TIMEOUT_MS + LIVE_RTC_CLOSE_RESULT_WAIT_MS + STALE_SEND_TIMEOUT_MS +
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS;
