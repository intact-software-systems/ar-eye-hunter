import {
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    LIVE_RTC_TRIO_SIZE
} from './live-rtc-control-waits.ts';

/** Each group membership request's own budget. */
export const GROUP_MEMBERSHIP_REQUEST_TIMEOUT_MS = 10_000;

/** The control client waits for each membership request its budget, then its result poll. */
export const GROUP_MEMBERSHIP_REQUEST_RESULT_WAIT_MS = GROUP_MEMBERSHIP_REQUEST_TIMEOUT_MS +
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS;

/** The owner creates the trio's group, then the two other members join it, one request after another. */
export const GROUP_MEMBERSHIP_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE * GROUP_MEMBERSHIP_REQUEST_RESULT_WAIT_MS;
