/** How long Playwright waits for the full-stack in-memory API to answer. */
export const FULL_STACK_MEMORY_API_START_TIMEOUT_MS = 120_000;

/** How long Playwright waits for a PostgreSQL-backed full-stack API to answer. */
export const FULL_STACK_POSTGRES_API_START_TIMEOUT_MS = 90_000;

/** How long Playwright waits for the SPA, served by its dev server or as a production preview, to answer. */
export const FULL_STACK_SPA_START_TIMEOUT_MS = 60_000;

/** How long Playwright waits for the control server to answer. */
export const FULL_STACK_CONTROL_START_TIMEOUT_MS = 60_000;

/** Playwright starts a full-stack run's API, then its SPA, then its control server, each under its own limit. */
export const FULL_STACK_WEB_SERVERS_START_BOUNDED_WAITS_MS =
    Math.max(FULL_STACK_MEMORY_API_START_TIMEOUT_MS, FULL_STACK_POSTGRES_API_START_TIMEOUT_MS) +
    FULL_STACK_SPA_START_TIMEOUT_MS + FULL_STACK_CONTROL_START_TIMEOUT_MS;
