// The live RTC harness's wait budgets live in this package rather than beside the Playwright modules that run them, so
// the RTC-B06 capture orchestrator can derive an attempt's test timeout without loading Playwright or the test tree.

import { computeCommandWaitMs } from './compute-command-result-wait-ms.ts';

/**
 * How long the control client polls for a command's result once the command's own budget, if it names one, is spent.
 * A command that names no budget is therefore polled this long in all.
 */
export const LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS = 45_000;

/** A command that names no budget of its own waits its enqueue request, then the whole result poll. */
export const LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS = computeCommandWaitMs(LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS);

/** The live RTC tests open their agents as trios of A, B and C. */
export const LIVE_RTC_TRIO_SIZE = 3;

/** How long the control client waits for a receiver to record a sent message. */
export const LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS = 60_000;

/** How long the control client waits for an agent to report its expected peers ready. */
export const LIVE_RTC_PEER_READINESS_TIMEOUT_MS = 60_000;

/** How long the control client waits for an agent to stop reporting a departed peer ready. */
export const LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS = 60_000;

/**
 * How long one health read waits for its result inside a readiness or absence poll, whose own limit bounds it, or
 * inside a failure capture, which runs only once a wait has failed.
 */
export const LIVE_RTC_HEALTH_READ_TIMEOUT_MS = 15_000;

/** How long the control client waits for an agent's close to return. */
export const LIVE_RTC_CLOSE_RESULT_WAIT_MS = 45_000;

/** How long the control client waits for an agent's reset to return. */
export const LIVE_RTC_RESET_RESULT_WAIT_MS = 30_000;

/** Retiring an agent closes it, then resets it, each command its enqueue request and then its result wait. */
export const LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS = computeCommandWaitMs(LIVE_RTC_CLOSE_RESULT_WAIT_MS) +
    computeCommandWaitMs(LIVE_RTC_RESET_RESULT_WAIT_MS);
