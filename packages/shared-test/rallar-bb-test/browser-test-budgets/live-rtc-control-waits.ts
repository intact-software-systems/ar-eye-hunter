import { CONTROL_AGENT_OPENING_TIMEOUT_MS } from './control-agent-opening-timeout-ms.ts';

// The live RTC harness's wait budgets live in this package rather than beside the Playwright modules that run them, so
// the RTC-B06 capture orchestrator can derive an attempt's test timeout without loading Playwright or the test tree.

/** How long the control client polls for a command's result once the command's own budget is spent. */
export const LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS = 45_000;

/** How long the control client waits for a receiver to record a sent message. */
export const LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS = 60_000;

/** How long the control client waits for an agent to report its expected peers ready. */
export const LIVE_RTC_PEER_READINESS_TIMEOUT_MS = 60_000;

/** How long the control client waits for an agent to stop reporting a departed peer ready. */
export const LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS = 60_000;

/** A live RTC agent opens until it registers with the control server; a trio opens its agents one after another. */
export const LIVE_RTC_AGENT_TRIO_OPEN_BOUNDED_WAITS_MS = 3 * CONTROL_AGENT_OPENING_TIMEOUT_MS;

/** How long the control client waits for an agent's close to return. */
export const LIVE_RTC_CLOSE_RESULT_WAIT_MS = 45_000;

/** How long the control client waits for an agent's reset to return. */
export const LIVE_RTC_RESET_RESULT_WAIT_MS = 30_000;

/** Retiring an agent closes it, then resets it. */
export const LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS = LIVE_RTC_CLOSE_RESULT_WAIT_MS + LIVE_RTC_RESET_RESULT_WAIT_MS;

/** How long the control client waits for one agent's diagnostics read. */
export const LIVE_RTC_DIAGNOSTICS_READ_TIMEOUT_MS = 30_000;

/** A diagnostics capture reads each of the trio's agents in turn. */
export const LIVE_RTC_DIAGNOSTICS_CAPTURE_BOUNDED_WAITS_MS = 3 * LIVE_RTC_DIAGNOSTICS_READ_TIMEOUT_MS;
