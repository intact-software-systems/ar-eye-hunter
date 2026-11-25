import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import {
    computeCommandResultPollTimeoutMs,
    computeCommandResultWaitMs,
    computeCommandWaitMs
} from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';
import {
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS,
    LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-control-waits.ts';
import { LIVE_RTC_RECORDER_READ_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-recorder-read-waits.ts';
import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecipeRunCommand,
    RallarBlackBoxTestRtcConnectCommand,
    RallarBlackBoxTestRtcSendCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

/** The worker's agents, by the ordinal the worker gives each one. */
export const WORKER_CAPTURE_AGENT_ORDINALS = [1, 2] as const;

/** How long each worker agent may take to register with the control server. */
export const WORKER_REGISTRATION_TIMEOUT_MS = 45_000;

/** Each group creation or membership request's own budget. */
export const WORKER_MEMBERSHIP_REQUEST_TIMEOUT_MS = 45_000;

/** How long the worker may take to release its browser after SIGTERM before it is killed. */
export const WORKER_STOP_TIMEOUT_MS = 10_000;

/** How long a worker given a malformed HOST may take to refuse its startup. */
export const WORKER_STARTUP_REFUSAL_TIMEOUT_MS = 10_000;

/** How long a worker connect waits for its one peer to be ready. */
const WORKER_CONNECT_READINESS_TIMEOUT_MS = 10_000;

/** How long a worker connect's readiness wait pauses between its reads. */
const WORKER_CONNECT_READINESS_INTERVAL_MS = 100;

/** A worker send's own budget for opening the peer's channel and delivering. */
const WORKER_SEND_TIMEOUT_MS = 60_000;

/** A worker connect joins the room under the establishment SDK timeout, then waits for its one peer to be ready. */
export const WORKER_CONNECT_TIMING: RallarBlackBoxTestRtcConnectCommand = {
    kind: 'rtc.connect',
    timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS,
    readiness: {
        minReadyPeers: 1,
        timeoutMs: WORKER_CONNECT_READINESS_TIMEOUT_MS,
        intervalMs: WORKER_CONNECT_READINESS_INTERVAL_MS
    }
};

/** A worker send opens the peer's channel and delivers within its own timeout. */
export const WORKER_SEND_TIMING: RallarBlackBoxTestRtcSendCommand = {
    kind: 'rtc.send',
    timeoutMs: WORKER_SEND_TIMEOUT_MS
};

/** The recipe a worker runs one command in, under the budget that command may take. */
export function toWorkerRecipeRoot(
    command: RallarBlackBoxTestCommand
): RallarBlackBoxTestRecipeRunCommand & Readonly<{ recipe: RallarBlackBoxTestRecipe; }> {
    return {
        kind: 'recipe.run',
        recipe: { schemaVersion: 1, recipeId: `recipe-${command.commandId ?? command.kind}`, commands: [command] }
    };
}

/** How long the control client polls for a worker recipe's result: what its one command may take, then the poll. */
export function computeWorkerRecipeResultPollTimeoutMs(command: RallarBlackBoxTestCommand): number {
    return computeCommandResultPollTimeoutMs(toWorkerRecipeRoot(command), LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS);
}

/** How long a worker recipe takes in all: its enqueue request, then its result poll. */
function computeWorkerRecipeResultWaitMs(command: RallarBlackBoxTestCommand): number {
    return computeCommandResultWaitMs(toWorkerRecipeRoot(command), LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS);
}

/** The worker stops while its run's artifacts and recorder events are read side by side. */
const WORKER_RETIREMENT_BOUNDED_WAITS_MS = Math.max(WORKER_STOP_TIMEOUT_MS, CONTROL_REQUEST_TIMEOUT_MS);

/**
 * Each agent registers in turn; the first creates the group and each joins it, reading its issued session; the agents
 * connect side by side and read their sessions again; under Native capture each acquisition is read from the
 * recorder; the first sends, the second waits for the message and the run is read for it, and the worker retires.
 */
export function computeWorkerHostCaptureTestTimeoutMs(mode: 'native' | 'off'): number {
    const agentCount = WORKER_CAPTURE_AGENT_ORDINALS.length;
    return BROWSER_TEST_HARNESS_MARGIN_MS + agentCount * WORKER_REGISTRATION_TIMEOUT_MS +
        (1 + agentCount) *
            computeCommandWaitMs(WORKER_MEMBERSHIP_REQUEST_TIMEOUT_MS + LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS) +
        2 * agentCount * LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS +
        computeWorkerRecipeResultWaitMs(WORKER_CONNECT_TIMING) +
        (mode === 'native' ? agentCount * LIVE_RTC_RECORDER_READ_TIMEOUT_MS : 0) +
        computeWorkerRecipeResultWaitMs(WORKER_SEND_TIMING) + LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS +
        CONTROL_REQUEST_TIMEOUT_MS + WORKER_RETIREMENT_BOUNDED_WAITS_MS;
}

/**
 * The malformed HOST test waits for the refusal and reads the control run it never created, then retires the worker
 * if it still runs.
 */
export const WORKER_HOST_REFUSAL_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS + WORKER_STARTUP_REFUSAL_TIMEOUT_MS +
    CONTROL_REQUEST_TIMEOUT_MS + WORKER_RETIREMENT_BOUNDED_WAITS_MS;
