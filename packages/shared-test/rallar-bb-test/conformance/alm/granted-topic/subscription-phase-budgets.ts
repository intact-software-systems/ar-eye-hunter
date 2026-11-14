/**
 * One phase of a cell on a loaded lane runner: a grant that waits for its grantee to join, an election, a reconnect
 * and its re-assertion, the readiness of a publication's audience, or a successor page's opening, which waits out
 * the owner's work lease before it connects.
 */
export const SUBSCRIPTION_PHASE_MS = 90_000;

/** One command of a cell: a request, a token change or read, or a send's admission. */
export const SUBSCRIPTION_COMMAND_TIMEOUT_MS = 5_000;
