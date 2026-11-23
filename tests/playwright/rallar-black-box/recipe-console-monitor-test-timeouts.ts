import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin.ts';
import { computeDistributedRunPassedWaitMs } from './distributed-recipes/distributed-control.ts';
import { CONTROL_RUN_AGENT_POLL_TIMEOUT_MS, LOGIN_RUN_HEADER_TIMEOUT_MS } from './full-stack-helpers.ts';

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

/**
 * The Native test's limit until it reads its manifest: the service probes, the operator's sign-in, the launched agents'
 * pages, their readiness, their connection and the targets they become.
 */
export const CONSOLE_NATIVE_SETUP_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS + CONSOLE_SERVICE_PROBE_TIMEOUT_MS +
    LOGIN_RUN_HEADER_TIMEOUT_MS + CONSOLE_AGENT_PAGES_POLL_TIMEOUT_MS + CONSOLE_AGENTS_READY_STATUS_TIMEOUT_MS +
    CONTROL_RUN_AGENT_POLL_TIMEOUT_MS + CONSOLE_TARGETS_TIMEOUT_MS;

/** The Native test's setup, then staging, the started run to passed, and the Monitor's verdict. */
export function computeConsoleNativeTestTimeoutMs(manifest: RallarBlackBoxDistributedRunManifest): number {
    return CONSOLE_NATIVE_SETUP_TIMEOUT_MS + CONSOLE_STAGE_READY_TIMEOUT_MS +
        computeDistributedRunPassedWaitMs(manifest) +
        CONSOLE_MONITOR_VERDICT_TIMEOUT_MS;
}
