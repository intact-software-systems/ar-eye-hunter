/**
 * A browser test's timeout is the sum of the bounded waits it runs in order (a wait, poll or hold by its own limit, a
 * command that names its own budget by that budget, waits that run side by side by the longest of them) plus this
 * margin for the work that has no bound of its own: page loads, command round trips, a result's poll beyond its
 * command's budget, and assertions under Playwright's default expect timeout.
 */
export const BROWSER_TEST_HARNESS_MARGIN_MS = 60_000;
