import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';
import { LIVE_RTC_RECORDER_READ_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-recorder-read-waits.ts';
import { FULL_STACK_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

import { computeDistributedRunPassedWaitMs } from './distributed-recipes/distributed-control.ts';
import {
    CONTROL_RUN_AGENT_POLL_TIMEOUT_MS,
    RALLAR_PAGE_CLEANUP_BOUNDED_WAITS_MS
} from './full-stack-helpers.ts';
import { CONTROL_GET_BOUNDED_WAITS_MS } from './read-control-get-response.ts';
import {
    computeConsoleExecuteTargetsBoundedWaitsMs,
    CONSOLE_AGENT_LAUNCH_BOUNDED_WAITS_MS,
    CONSOLE_MONITOR_VERDICT_TIMEOUT_MS,
    CONSOLE_MONITOR_VISIT_BOUNDED_WAITS_MS,
    CONSOLE_OPERATOR_SIGN_IN_BOUNDED_WAITS_MS,
    CONSOLE_SERVICE_READINESS_BOUNDED_WAITS_MS,
    CONSOLE_STAGE_READY_TIMEOUT_MS
} from './recipe-console-operator-waits.ts';

/** How many browser agents the Native test launches through the Console. */
export const CONSOLE_NATIVE_AGENT_COUNT = 2;

/**
 * The Native test's limit until it reads its manifest: the service readiness, the operator's sign-in, the launched
 * agents, their connection, the targets they become and the agent pages' addresses side by side.
 */
export const CONSOLE_NATIVE_SETUP_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    CONSOLE_SERVICE_READINESS_BOUNDED_WAITS_MS +
    CONSOLE_OPERATOR_SIGN_IN_BOUNDED_WAITS_MS + CONSOLE_AGENT_LAUNCH_BOUNDED_WAITS_MS +
    CONTROL_RUN_AGENT_POLL_TIMEOUT_MS + computeConsoleExecuteTargetsBoundedWaitsMs(CONSOLE_NATIVE_AGENT_COUNT) +
    FULL_STACK_EXPECT_TIMEOUT_MS;

/**
 * The capture control's empty value, the draft state, the control disabled with its native value, the started run's
 * control disabled again, then the Monitor's address and its run.
 */
const CONSOLE_NATIVE_RUN_ASSERTIONS = 7;

/** The Native test reads the control run before its draft, once staged and once passed. */
const CONSOLE_NATIVE_CONTROL_RUN_READS = 3;

/** The Native test reads the distributed run once drafted, once staged and once passed. */
const CONSOLE_NATIVE_DISTRIBUTED_RUN_READS = 3;

/**
 * The Native test's setup, the run's assertions, staging, the started run to passed, the control and distributed run
 * reads, each agent's Native attachment read from the recorder in turn, the Monitor's verdict and the pages' cleanup
 * side by side.
 */
export function computeConsoleNativeTestTimeoutMs(manifest: RallarBlackBoxDistributedRunManifest): number {
    return CONSOLE_NATIVE_SETUP_TIMEOUT_MS + CONSOLE_NATIVE_RUN_ASSERTIONS * FULL_STACK_EXPECT_TIMEOUT_MS +
        CONSOLE_STAGE_READY_TIMEOUT_MS + computeDistributedRunPassedWaitMs(manifest) +
        CONSOLE_NATIVE_CONTROL_RUN_READS * CONTROL_GET_BOUNDED_WAITS_MS +
        CONSOLE_NATIVE_DISTRIBUTED_RUN_READS * CONTROL_REQUEST_TIMEOUT_MS +
        CONSOLE_NATIVE_AGENT_COUNT * LIVE_RTC_RECORDER_READ_TIMEOUT_MS + CONSOLE_MONITOR_VERDICT_TIMEOUT_MS +
        RALLAR_PAGE_CLEANUP_BOUNDED_WAITS_MS;
}

/** The composite recipe's commands read local state and name no budget; its run passes well inside this wait. */
export const CONSOLE_COMPOSITE_PASSED_WAIT_MS = 90_000;

/** How long the lifecycle test polls the distributed and control runs until they complete the cancel proof. */
export const CONSOLE_CANCEL_PROOF_POLL_TIMEOUT_MS = 30_000;

/** How many browser agents the lifecycle test launches through the Console. */
export const CONSOLE_LIFECYCLE_AGENT_COUNT = 3;

/** The operator's address after it opens the Console, the Execute workspace, then its address without the run. */
const CONSOLE_LIFECYCLE_ADDRESS_ASSERTIONS = 3;

/** The cancel dialog shows, names the run and its state, then closes. */
const CONSOLE_CANCEL_DIALOG_ASSERTIONS = 4;

/** Each run is drafted, then staged, through the Execute view. */
const CONSOLE_DRAFT_AND_STAGE_BOUNDED_WAITS_MS = FULL_STACK_EXPECT_TIMEOUT_MS + CONSOLE_STAGE_READY_TIMEOUT_MS;

/**
 * The service readiness, the operator's sign-in, the launched agents and their connection; per run the targets, the
 * draft and the stage; the first run to passed; both Monitor visits; the addresses the test checks; the second run's
 * read once staged; the cancel dialog, the cancelled verdict and the cancel proof, the distributed and control runs
 * read side by side after it, and the pages' cleanup.
 */
export const CONSOLE_LIFECYCLE_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    CONSOLE_SERVICE_READINESS_BOUNDED_WAITS_MS + CONSOLE_OPERATOR_SIGN_IN_BOUNDED_WAITS_MS +
    CONSOLE_AGENT_LAUNCH_BOUNDED_WAITS_MS + CONTROL_RUN_AGENT_POLL_TIMEOUT_MS +
    2 * (computeConsoleExecuteTargetsBoundedWaitsMs(CONSOLE_LIFECYCLE_AGENT_COUNT) +
            CONSOLE_DRAFT_AND_STAGE_BOUNDED_WAITS_MS) +
    CONSOLE_COMPOSITE_PASSED_WAIT_MS + 2 * CONSOLE_MONITOR_VISIT_BOUNDED_WAITS_MS +
    (CONSOLE_LIFECYCLE_ADDRESS_ASSERTIONS + CONSOLE_CANCEL_DIALOG_ASSERTIONS) * FULL_STACK_EXPECT_TIMEOUT_MS +
    CONTROL_REQUEST_TIMEOUT_MS + CONSOLE_MONITOR_VERDICT_TIMEOUT_MS + CONSOLE_CANCEL_PROOF_POLL_TIMEOUT_MS +
    Math.max(CONTROL_REQUEST_TIMEOUT_MS, CONTROL_GET_BOUNDED_WAITS_MS) + RALLAR_PAGE_CLEANUP_BOUNDED_WAITS_MS;
