/**
 * The graceful-stop deadline a Bun server uses when its environment names none. The hosted systemd units set
 * `RALLAR_SHUTDOWN_DEADLINE_MS` themselves, from the same value as their `TimeoutStopSec`.
 */
export const DEFAULT_SERVER_SHUTDOWN_DEADLINE_MS = 60_000;
