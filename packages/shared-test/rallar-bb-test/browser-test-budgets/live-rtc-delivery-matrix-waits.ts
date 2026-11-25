import { LIVE_RTC_TRIO_SIZE, LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS } from './live-rtc-control-waits.ts';
import {
    DELIVERY_CASE_BOUNDED_WAITS_MS,
    MATRIX_INBOX_OBSERVATION_BOUNDED_WAITS_MS
} from './live-rtc-delivery-waits.ts';
import { FORMATION_RUN_BOUNDED_WAITS_MS } from './live-rtc-formation-waits.ts';

/** The owner's matrix: the formation, three deliveries, and the direct and broadcast receivers' visible inboxes. */
export const DELIVERY_MATRIX_BOUNDED_WAITS_MS = FORMATION_RUN_BOUNDED_WAITS_MS + 3 * DELIVERY_CASE_BOUNDED_WAITS_MS +
    2 * MATRIX_INBOX_OBSERVATION_BOUNDED_WAITS_MS;

/** The realtime matrix then reads the sender's health, a command that names no budget, for its ready peers. */
export const REALTIME_DELIVERY_MATRIX_BOUNDED_WAITS_MS = DELIVERY_MATRIX_BOUNDED_WAITS_MS +
    LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS;

/** Each of the three senders' two direct deliveries, its multicast and its broadcast, after the formation. */
export const ALL_DELIVERY_PERMUTATIONS_BOUNDED_WAITS_MS = FORMATION_RUN_BOUNDED_WAITS_MS +
    LIVE_RTC_TRIO_SIZE * 4 * DELIVERY_CASE_BOUNDED_WAITS_MS;
