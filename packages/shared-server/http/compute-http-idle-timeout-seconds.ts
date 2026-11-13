/** `Bun.serve` rejects a larger `idleTimeout`. */
export const BUN_MAX_IDLE_TIMEOUT_SECONDS = 255;

/** Covers the request's work before its wait starts and the wait's final poll interval. */
const IDLE_MARGIN_SECONDS = 10;

/**
 * A request writes no bytes while it waits, so a Bun server's HTTP idle bound must outlast the longest wait a route
 * holds open, or Bun drops the socket before the route's own typed timeout response.
 */
export function computeHttpIdleTimeoutSeconds(longestWaitMs: number): number {
    return Math.ceil(longestWaitMs / 1000) + IDLE_MARGIN_SECONDS;
}
