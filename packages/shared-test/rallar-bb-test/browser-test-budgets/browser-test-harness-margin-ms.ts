/**
 * A browser test's timeout is the sum of the bounded waits it runs in order plus this margin. A wait, poll or hold
 * counts by its own limit; a command counts by its budget and then the harness's result poll, or by the result poll
 * alone when it names no budget; an assertion that names no limit counts by its configuration's default assertion
 * limit; waits that run side by side count by the longest of them. The margin covers only work that Playwright and the
 * harnesses leave without a limit of their own: page loads, navigations and reloads; clicks, fills and selections,
 * which run without an action limit; API request round trips such as a command's enqueue, a run or artifact read and a
 * recorder stream; page evaluations; attachments and evidence files written; and browser contexts closed.
 */
export const BROWSER_TEST_HARNESS_MARGIN_MS = 60_000;
