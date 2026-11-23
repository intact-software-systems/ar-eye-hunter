import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

import { toRecommendedTerminalTimeoutMs } from './distributed-recipes/to-recommended-terminal-timeout-ms.ts';

/** The owned worker registers every agent of the cohort with the control server. */
export const ALL_LOCAL_ALM_REGISTRATION_TIMEOUT_MS = 90_000;

/** The operator waits for the staged run to become ready or start running. */
export const ALL_LOCAL_ALM_READINESS_TIMEOUT_MS = 330_000;

/** The owned worker completes and the native evidence is exported once the run settles. */
export const ALL_LOCAL_ALM_EXPORT_ALLOWANCE_MS = 60_000;

/** The owned worker is stopped and the observation result written after the harness aborts. */
export const ALL_LOCAL_ALM_CLEANUP_ALLOWANCE_MS = 120_000;

export interface AllLocalAlmObservationDeadlines {
    /** The operator's wait for the started run to reach a terminal state. */
    readonly terminalTimeoutMs: number;
    /** The harness abort and the owned worker's idle exit. */
    readonly harnessTimeoutMs: number;
    readonly testTimeoutMs: number;
}

export function computeAllLocalAlmObservationDeadlines(
    manifest: RallarBlackBoxDistributedRunManifest
): AllLocalAlmObservationDeadlines {
    const terminalTimeoutMs = toRecommendedTerminalTimeoutMs(manifest);
    const harnessTimeoutMs = ALL_LOCAL_ALM_REGISTRATION_TIMEOUT_MS + ALL_LOCAL_ALM_READINESS_TIMEOUT_MS +
        terminalTimeoutMs + ALL_LOCAL_ALM_EXPORT_ALLOWANCE_MS;
    return {
        terminalTimeoutMs,
        harnessTimeoutMs,
        testTimeoutMs: harnessTimeoutMs + ALL_LOCAL_ALM_CLEANUP_ALLOWANCE_MS
    };
}
