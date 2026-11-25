import {
    LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS,
    LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS,
    LIVE_RTC_TRIO_SIZE
} from './live-rtc-control-waits.ts';

/**
 * Retiring a settled trio: C closes and resets, A and B see it leave side by side, B closes and resets, A sees it leave,
 * then A closes and resets.
 */
export const SETTLED_TRIO_RETIREMENT_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE * LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS +
    2 * LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS;
