import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

import { toRecommendedTerminalTimeoutMs } from './distributed-recipes/to-recommended-terminal-timeout-ms.ts';
import {
    BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS,
    CONTROL_RUN_AGENT_POLL_TIMEOUT_MS
} from './full-stack-helpers.ts';

/** The operator waits for the staged run to become ready or start running. */
const VIEW_PUSH_READINESS_TIMEOUT_MS = 90_000;

/** How long the operator waits between state reads. */
export const VIEW_PUSH_STATE_POLL_INTERVAL_MS = 250;

/**
 * The operator's control requests outside its state waits: the target resolution, the create, the stage and the
 * start, then the artifact bundle and the four native artifacts it exports.
 */
const VIEW_PUSH_OPERATOR_REQUESTS = 4 + 1 + 4;

/**
 * A state wait reads the run until its limit has passed, so its last read may start at the limit, take its whole
 * request timeout and be followed by one interval.
 */
const VIEW_PUSH_STATE_WAIT_OVERRUN_MS = CONTROL_REQUEST_TIMEOUT_MS + VIEW_PUSH_STATE_POLL_INTERVAL_MS;

/** Each of the two agents is opened, then seen connected by the control run. */
const VIEW_PUSH_AGENTS_BOUNDED_WAITS_MS = 2 *
    (BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS + CONTROL_RUN_AGENT_POLL_TIMEOUT_MS);

export interface ViewPushTestDeadlines {
    readonly readinessTimeoutMs: number;
    /** The operator's wait for the started run to reach a terminal state. */
    readonly terminalTimeoutMs: number;
    readonly testTimeoutMs: number;
}

/**
 * The two agents, the operator's requests outside its state waits, then its readiness and terminal waits, each with
 * its overrun.
 */
export function computeViewPushTestDeadlines(manifest: RallarBlackBoxDistributedRunManifest): ViewPushTestDeadlines {
    const terminalTimeoutMs = toRecommendedTerminalTimeoutMs(manifest);
    return {
        readinessTimeoutMs: VIEW_PUSH_READINESS_TIMEOUT_MS,
        terminalTimeoutMs,
        testTimeoutMs: BROWSER_TEST_HARNESS_MARGIN_MS + VIEW_PUSH_AGENTS_BOUNDED_WAITS_MS +
            VIEW_PUSH_OPERATOR_REQUESTS * CONTROL_REQUEST_TIMEOUT_MS +
            VIEW_PUSH_READINESS_TIMEOUT_MS + terminalTimeoutMs + 2 * VIEW_PUSH_STATE_WAIT_OVERRUN_MS
    };
}
