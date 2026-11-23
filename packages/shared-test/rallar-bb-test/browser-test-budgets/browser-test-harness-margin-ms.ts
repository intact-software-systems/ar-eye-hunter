/**
 * A browser test's timeout is the sum of the bounded waits it runs in order (a wait, poll or hold by its own limit, a
 * command that names its own budget by that budget, a command that names only how long its result is polled by that
 * poll, waits that run side by side by the longest of them) plus this margin. The margin covers only work with no limit
 * of its own: page loads, request round trips (a command that names no wait of its own, and a result reaching the
 * harness once its command's budget is spent), and the clicks and assertions that keep Playwright's default limits.
 */
export const BROWSER_TEST_HARNESS_MARGIN_MS = 60_000;
