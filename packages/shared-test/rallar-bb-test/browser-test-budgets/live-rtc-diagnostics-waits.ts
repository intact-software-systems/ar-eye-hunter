import { computeEnqueuedCommandWaitMs } from './compute-command-result-wait-ms.ts';
import { LIVE_RTC_TRIO_SIZE } from './live-rtc-control-waits.ts';

/** How long the control client polls for one agent's diagnostics read result once the read is enqueued. */
export const LIVE_RTC_DIAGNOSTICS_RESULT_POLL_TIMEOUT_MS = 30_000;

/** A diagnostics capture reads each of the trio's agents in turn, each read a command enqueued and then polled for its result. */
export const LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE *
    computeEnqueuedCommandWaitMs(LIVE_RTC_DIAGNOSTICS_RESULT_POLL_TIMEOUT_MS);
