/**
 * A finished-command window that outlives every fixed test clock, for tests that do not exercise retention: the
 * runtime-state store reads a row past its expiry as absent by the wall clock, so a shorter window would expire the
 * idempotency records of a test whose clock starts in 1970.
 */
export const TEST_APP_INBOX_FINISHED_RETENTION_MS = 1_000 * 365 * 24 * 60 * 60 * 1_000;
