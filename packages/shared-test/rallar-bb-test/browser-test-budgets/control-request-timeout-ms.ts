/**
 * How long a browser test's harness waits for each request it sends through a Playwright request context before the
 * request fails: a command's enqueue, a run, artifact or distributed run read, a distributed run's create, stage,
 * start or cancel, an API configuration read or a service probe. The control server runs beside the test in its lane
 * and answers in milliseconds, so 10 s fails a hung server well before Playwright's own 30 s default while leaving a
 * loaded runner more than enough room.
 */
export const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
