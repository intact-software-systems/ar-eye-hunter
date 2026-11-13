import type { ApiV1HttpConfiguration } from './api-v1-configuration.ts';

/** Kept back from the deadline for the steps after the drain: queue workers, background tasks, the database. */
const SHUTDOWN_CLEANUP_ALLOWANCE_MS = 15_000;

/** How long a graceful HTTP drain may run before the remaining connections are force-closed. */
export function computeApiShutdownGraceMs(http: Pick<ApiV1HttpConfiguration, 'shutdownDeadlineMs'>): number {
    return http.shutdownDeadlineMs - SHUTDOWN_CLEANUP_ALLOWANCE_MS;
}
