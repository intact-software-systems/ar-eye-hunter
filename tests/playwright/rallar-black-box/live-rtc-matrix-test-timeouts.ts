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

/**
 * The soak's operational limit. Each reconnect is bounded by its own wait, so a cycle that fails ends the soak; this
 * bound only limits a soak whose every cycle is slow but succeeds, which its derived sum would let outlast its job.
 */
export const RETENTION_SOAK_OPERATIONAL_BOUND_MS = 3 * 60 * 60_000;

/** One formation, then a reconnect in every cycle, up to the soak's operational bound. */
export const LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS = Math.min(
    RETENTION_STEPS_TIMEOUT_MS + FORMATION_RUN_CONNECT_RESULT_WAIT_MS +
        RETENTION_RECONNECT_CYCLES * FORMATION_CONNECT_RESULT_WAIT_MS,
    RETENTION_SOAK_OPERATIONAL_BOUND_MS
);
