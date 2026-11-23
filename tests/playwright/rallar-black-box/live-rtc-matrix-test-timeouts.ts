import {
    FORMATION_CONNECT_RESULT_WAIT_MS,
    FORMATION_RUN_CONNECT_RESULT_WAIT_MS
} from './create-group-formation-lifecycle-driver.ts';

/** The proof matrix's steps besides its formation connects. */
const MATRIX_STEPS_TIMEOUT_MS = 360_000;

/** Every sender and receiver scenario's steps besides its formation connects and the reconnect. */
const ALL_SCENARIOS_STEPS_TIMEOUT_MS = 300_000;

/** The retention soak's steps besides its formation connects and the reconnects. */
const RETENTION_STEPS_TIMEOUT_MS = 1_800_000;

/** Peer C closes and reconnects once in every retention cycle. */
export const RETENTION_RECONNECT_CYCLES = 100;

/** A delivery matrix per transport, each forming the room by connecting the trio. */
export const LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS = MATRIX_STEPS_TIMEOUT_MS + 2 * FORMATION_RUN_CONNECT_RESULT_WAIT_MS;

/** A permutation run per transport, each forming the room, and agent C's reconnect. */
export const LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS = ALL_SCENARIOS_STEPS_TIMEOUT_MS +
    2 * FORMATION_RUN_CONNECT_RESULT_WAIT_MS + FORMATION_CONNECT_RESULT_WAIT_MS;

/** One formation, then a reconnect in every cycle. */
export const LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS = RETENTION_STEPS_TIMEOUT_MS +
    FORMATION_RUN_CONNECT_RESULT_WAIT_MS +
    RETENTION_RECONNECT_CYCLES * FORMATION_CONNECT_RESULT_WAIT_MS;
