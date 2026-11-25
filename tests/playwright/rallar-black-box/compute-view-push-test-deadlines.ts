import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

import { toRecommendedTerminalTimeoutMs } from './distributed-recipes/to-recommended-terminal-timeout-ms.ts';
import {
    BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS,
    CONTROL_RUN_AGENT_POLL_TIMEOUT_MS
} from './full-stack-helpers.ts';

/** The operator waits for the staged run to become ready or start running. */
const VIEW_PUSH_READINESS_TIMEOUT_MS = 90_000;

/** How long the operator waits between state reads; each state wait may overrun its limit by one interval. */
export const VIEW_PUSH_STATE_POLL_INTERVAL_MS = 250;

/** Each of the two agents is opened, then seen connected by the control run. */
const VIEW_PUSH_AGENTS_BOUNDED_WAITS_MS = 2 *
    (BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS + CONTROL_RUN_AGENT_POLL_TIMEOUT_MS);

export interface ViewPushTestDeadlines {
    readonly readinessTimeoutMs: number;
    /** The operator's wait for the started run to reach a terminal state. */
    readonly terminalTimeoutMs: number;
    readonly testTimeoutMs: number;
}

/** The two agents, then the operator's readiness and terminal waits, each with its last poll interval. */
export function computeViewPushTestDeadlines(manifest: RallarBlackBoxDistributedRunManifest): ViewPushTestDeadlines {
    const terminalTimeoutMs = toRecommendedTerminalTimeoutMs(manifest);
    return {
        readinessTimeoutMs: VIEW_PUSH_READINESS_TIMEOUT_MS,
        terminalTimeoutMs,
        testTimeoutMs: BROWSER_TEST_HARNESS_MARGIN_MS + VIEW_PUSH_AGENTS_BOUNDED_WAITS_MS +
            VIEW_PUSH_READINESS_TIMEOUT_MS + terminalTimeoutMs + 2 * VIEW_PUSH_STATE_POLL_INTERVAL_MS
    };
}
