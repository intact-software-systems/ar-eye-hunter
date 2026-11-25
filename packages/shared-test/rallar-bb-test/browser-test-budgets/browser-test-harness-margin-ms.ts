/**
 * A browser test's timeout is the sum of the bounded waits it runs in order plus this margin. A wait, poll or hold
 * counts by its own limit; a command counts by its enqueue request under the control request timeout, then its budget
 * and the harness's result poll, or the result poll alone when it names no budget; a request outside any poll counts
 * by the control request timeout, once per attempt it may make, with the pauses between them; an assertion that names
 * no limit counts by its configuration's default assertion limit; a recorder read counts by its read limit; waits that
 * run side by side count by the longest of them. A request inside a poll or another racing bound is bounded by it and
 * counts no more.
 *
 * The margin covers only the work that has no bound of its own: page loads, navigations, reloads and address waits;
 * clicks, fills and selections, which run without an action limit; response, download and event waits; page
 * evaluations; attachments and evidence files written; browser contexts closed; the world-fleet operator's control
 * requests, which Node's own `fetch` sends without a limit; and a killed worker's exit. Diagnostics captured only once
 * a wait has failed are bounded but not counted, since the test has failed by then.
 */
export const BROWSER_TEST_HARNESS_MARGIN_MS = 60_000;
