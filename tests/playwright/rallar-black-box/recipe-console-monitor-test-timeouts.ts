import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import { LIVE_RTC_RECORDER_READ_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-recorder-read-waits.ts';
import {
    FULL_STACK_EXPECT_TIMEOUT_MS,
    FULL_STACK_TAB_OPEN_BOUNDED_WAITS_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

import { computeDistributedRunPassedWaitMs } from './distributed-recipes/distributed-control.ts';
import {
    CONTROL_RUN_AGENT_POLL_TIMEOUT_MS,
    LOGIN_RUN_HEADER_TIMEOUT_MS,
    RALLAR_PAGE_CLEANUP_BOUNDED_WAITS_MS
} from './full-stack-helpers.ts';

/** The Console lifecycle test's limit; its composite run's passed wait is part of it. */
export const CONSOLE_LIFECYCLE_TEST_TIMEOUT_MS = 240_000;

/** How long each configured-service probe may take; the API and control probes run side by side. */
export const CONSOLE_SERVICE_PROBE_TIMEOUT_MS = 5_000;

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

/** How many browser agents the Native test launches through the Console. */
export const CONSOLE_NATIVE_AGENT_COUNT = 2;

/** The operator signs in: its login gate, its run header, then its Rallar Server tab. */
const OPERATOR_SIGN_IN_BOUNDED_WAITS_MS = FULL_STACK_EXPECT_TIMEOUT_MS + LOGIN_RUN_HEADER_TIMEOUT_MS +
    FULL_STACK_TAB_OPEN_BOUNDED_WAITS_MS;

/** The agent setup and its control run ID show, the launched pages open, then the agents report ready and selected. */
const AGENT_LAUNCH_BOUNDED_WAITS_MS = 2 * FULL_STACK_EXPECT_TIMEOUT_MS + CONSOLE_AGENT_PAGES_POLL_TIMEOUT_MS +
    CONSOLE_AGENTS_READY_STATUS_TIMEOUT_MS;

/**
 * The selected recipe shows selected with its provider and prerequisite, the targets list every agent, show each, and
 * show them all matched.
 */
const EXECUTE_TARGETS_BOUNDED_WAITS_MS = 3 * FULL_STACK_EXPECT_TIMEOUT_MS + CONSOLE_TARGETS_TIMEOUT_MS +
    CONSOLE_NATIVE_AGENT_COUNT * FULL_STACK_EXPECT_TIMEOUT_MS + FULL_STACK_EXPECT_TIMEOUT_MS;

/**
 * The Native test's limit until it reads its manifest: the service probes, the operator's sign-in, the launched agents,
 * their connection, the targets they become and the agent pages' addresses side by side.
 */
export const CONSOLE_NATIVE_SETUP_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS + CONSOLE_SERVICE_PROBE_TIMEOUT_MS +
    OPERATOR_SIGN_IN_BOUNDED_WAITS_MS + AGENT_LAUNCH_BOUNDED_WAITS_MS + CONTROL_RUN_AGENT_POLL_TIMEOUT_MS +
    EXECUTE_TARGETS_BOUNDED_WAITS_MS + FULL_STACK_EXPECT_TIMEOUT_MS;

/**
 * The capture control's empty value, the draft state, the control disabled with its native value, the started run's
 * control disabled again, then the Monitor's address and its run.
 */
const CONSOLE_NATIVE_RUN_ASSERTIONS = 7;

/**
 * The Native test's setup, the run's assertions, staging, the started run to passed, each agent's Native attachment
 * read from the recorder in turn, the Monitor's verdict and the pages' cleanup side by side.
 */
export function computeConsoleNativeTestTimeoutMs(manifest: RallarBlackBoxDistributedRunManifest): number {
    return CONSOLE_NATIVE_SETUP_TIMEOUT_MS + CONSOLE_NATIVE_RUN_ASSERTIONS * FULL_STACK_EXPECT_TIMEOUT_MS +
        CONSOLE_STAGE_READY_TIMEOUT_MS + computeDistributedRunPassedWaitMs(manifest) +
        CONSOLE_NATIVE_AGENT_COUNT * LIVE_RTC_RECORDER_READ_TIMEOUT_MS + CONSOLE_MONITOR_VERDICT_TIMEOUT_MS +
        RALLAR_PAGE_CLEANUP_BOUNDED_WAITS_MS;
}
