import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

import { toRecommendedTerminalTimeoutMs } from './compute-all-local-alm-observation-deadlines.ts';

/** The operator waits for the staged run to become ready or start running. */
const VIEW_PUSH_READINESS_TIMEOUT_MS = 90_000;

/** Opening the two agents, staging and the evidence export besides the run's readiness and terminal waits. */
const VIEW_PUSH_STEPS_TIMEOUT_MS = 180_000;

export interface ViewPushTestDeadlines {
    readonly readinessTimeoutMs: number;
    /** The operator's wait for the started run to reach a terminal state. */
    readonly terminalTimeoutMs: number;
    readonly testTimeoutMs: number;
}

export function computeViewPushTestDeadlines(manifest: RallarBlackBoxDistributedRunManifest): ViewPushTestDeadlines {
    const terminalTimeoutMs = toRecommendedTerminalTimeoutMs(manifest);
    return {
        readinessTimeoutMs: VIEW_PUSH_READINESS_TIMEOUT_MS,
        terminalTimeoutMs,
        testTimeoutMs: VIEW_PUSH_STEPS_TIMEOUT_MS + VIEW_PUSH_READINESS_TIMEOUT_MS + terminalTimeoutMs
    };
}
