/**
 * How long an opened browser control agent may take to show each screen it opens through: the login gate or its
 * workbench, its selected Advanced tab, then its registration with the control server. Every opener waits for its own
 * subset of these screens under this one limit.
 */
export const CONTROL_AGENT_OPENING_TIMEOUT_MS = 30_000;
