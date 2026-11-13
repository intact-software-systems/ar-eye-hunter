/**
 * The allowance for a barrier verdict to reach an agent. The control server closes the barrier's window on the next
 * envelope any agent sends; the agent listens this much longer, so its own timeout means no control server answered,
 * never a slow verdict.
 */
export const RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS = 10_000;
