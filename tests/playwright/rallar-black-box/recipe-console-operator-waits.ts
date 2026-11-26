import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';
import {
    FULL_STACK_EXPECT_TIMEOUT_MS,
    FULL_STACK_TAB_OPEN_BOUNDED_WAITS_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';

import { LOGIN_RUN_HEADER_TIMEOUT_MS } from './full-stack-helpers.ts';

/** The API and control service probes run side by side, then the API's readiness is read. */
export const CONSOLE_SERVICE_READINESS_BOUNDED_WAITS_MS = 2 * CONTROL_REQUEST_TIMEOUT_MS;

/** How long the Console's launch control may take to open the agents' pages. */
export const CONSOLE_AGENT_PAGES_POLL_TIMEOUT_MS = 30_000;

/** How long the Console may take to report its launched agents ready and selected. */
export const CONSOLE_AGENTS_READY_STATUS_TIMEOUT_MS = 60_000;

/** How long the Execute view may take to list every launched agent as a target. */
export const CONSOLE_TARGETS_TIMEOUT_MS = 30_000;

/** How long a staged run may take to show ready in the Execute view. */
export const CONSOLE_STAGE_READY_TIMEOUT_MS = 60_000;

/** How long the Monitor view may take to show a run's verdict. */
export const CONSOLE_MONITOR_VERDICT_TIMEOUT_MS = 30_000;

/** The operator signs in: its login gate, its run header, then its Rallar Server tab. */
export const CONSOLE_OPERATOR_SIGN_IN_BOUNDED_WAITS_MS = FULL_STACK_EXPECT_TIMEOUT_MS + LOGIN_RUN_HEADER_TIMEOUT_MS +
    FULL_STACK_TAB_OPEN_BOUNDED_WAITS_MS;

/** The agent setup and its control run ID show, the launched pages open, then the agents report ready and selected. */
export const CONSOLE_AGENT_LAUNCH_BOUNDED_WAITS_MS = 2 * FULL_STACK_EXPECT_TIMEOUT_MS +
    CONSOLE_AGENT_PAGES_POLL_TIMEOUT_MS + CONSOLE_AGENTS_READY_STATUS_TIMEOUT_MS;

/** A Monitor visit shows the Monitor's address, then its run's, then the run's verdict. */
export const CONSOLE_MONITOR_VISIT_BOUNDED_WAITS_MS = 2 * FULL_STACK_EXPECT_TIMEOUT_MS +
    CONSOLE_MONITOR_VERDICT_TIMEOUT_MS;

/**
 * The selected recipe shows selected with its provider and prerequisite, the targets list every agent, show each, and
 * show them all matched.
 */
export function computeConsoleExecuteTargetsBoundedWaitsMs(agentCount: number): number {
    return 3 * FULL_STACK_EXPECT_TIMEOUT_MS + CONSOLE_TARGETS_TIMEOUT_MS + agentCount * FULL_STACK_EXPECT_TIMEOUT_MS +
        FULL_STACK_EXPECT_TIMEOUT_MS;
}
