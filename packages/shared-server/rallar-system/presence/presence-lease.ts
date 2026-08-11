/**
 * Client and group presence sessions share one lease-bounding policy.
 *
 * Session timestamps are client-supplied, and the disconnect path no-ops when a
 * disconnect predates the stored heartbeat. A far-future `connectedAtEpochMs` or
 * `lastHeartbeatAtEpochMs` would therefore make a session permanently
 * undisconnectable — a real-time disconnect (including WS-close cleanup) would
 * always be treated as stale — pinning the session online and holding both a
 * member-session slot and a topology seat. Reject connect/heartbeat timestamps
 * beyond a small clock-skew tolerance so a heartbeat cannot be dated in the
 * future.
 */
export const MAX_PRESENCE_TIMESTAMP_SKEW_MS = 5 * 60 * 1_000;

export function isPresenceTimestampWithinSkew(valueEpochMs: number, nowEpochMs: number): boolean {
  return valueEpochMs <= nowEpochMs + MAX_PRESENCE_TIMESTAMP_SKEW_MS;
}
