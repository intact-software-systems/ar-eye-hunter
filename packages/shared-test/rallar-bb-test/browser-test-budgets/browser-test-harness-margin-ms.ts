/**
 * A browser test's timeout is the sum of the bounded waits it runs in order plus this margin. A wait, poll or hold
 * counts by its own limit; a command counts by its budget and then the harness's result poll, or by the result poll
 * alone when it names no budget; an assertion that names no limit counts by its configuration's default assertion
 * limit; a recorder read counts by its read limit, and a control read outside a poll by its transport retries' pauses;
 * waits that run side by side count by the longest of them.
 *
 * The margin covers only the work Playwright and the harnesses leave without a limit of their own: page loads,
 * navigations, reloads and address waits; clicks, fills and selections, which run without an action limit; response,
 * download and event waits; API request round trips such as a command's enqueue and a run, artifact or distributed run
 * read; page evaluations; attachments and evidence files written; and browser contexts closed.
 */
export const BROWSER_TEST_HARNESS_MARGIN_MS = 60_000;
