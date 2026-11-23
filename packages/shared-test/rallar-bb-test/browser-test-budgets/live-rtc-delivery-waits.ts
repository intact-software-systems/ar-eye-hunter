import { LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS } from './live-rtc-control-waits.ts';

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
