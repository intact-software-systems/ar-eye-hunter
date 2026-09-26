/** A cold RTC handshake on a fresh server exceeds the message deadline; connect budgets are harness budgets. */
export const CONNECT_TIMEOUT_MS = 45_000;
export const CONNECT_READINESS_TIMEOUT_MS = 30_000;
/** Hosted conformance may need more than five seconds to admit a non-expiring send. */
export const NON_EXPIRING_SEND_TIMEOUT_MS = 10_000;
export const MESSAGE_CONTROL_TIMEOUT_MS = 5_000;
export const ASSERT_TIMEOUT_MS = 2_000;
export const STATS_TIMEOUT_MS = 3_000;
export const RESPONSE_MARGIN_MS = 1_000;
// Must clear the slowest observed outbound-admission latency (up to 5s on a loaded CI runner) with
// margin, and still leave most of the receiver's `deadlineMs - RESPONSE_MARGIN_MS` absence window
// after expiry, so the absence proves the ttl expired rather than racing the deadline itself. The
// expiring send's command budget is this ttl, so it also bounds how long admission may take.
export const EXPIRY_TTL_MS = 7_500;
/** The browser's default lifetime, stated so the send outlives the whole scenario window. */
export const NON_EXPIRING_TTL_MS = 30_000;
export const MINIMUM_POST_EXPIRY_OBSERVATION_MS = 2_500;

export function toBudgetMs(desiredMs: number, deadlineMs: number): number {
    return Math.min(desiredMs, deadlineMs);
}
