import { computeCommandWaitMs } from './compute-command-result-wait-ms.ts';
import { LIVE_RTC_TRIO_SIZE } from './live-rtc-control-waits.ts';

/** How long the control client waits for one agent's diagnostics read. */
export const LIVE_RTC_DIAGNOSTICS_READ_TIMEOUT_MS = 30_000;

/** A diagnostics capture reads each of the trio's agents in turn, each read a command with its own result wait. */
export const LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE *
    computeCommandWaitMs(LIVE_RTC_DIAGNOSTICS_READ_TIMEOUT_MS);
