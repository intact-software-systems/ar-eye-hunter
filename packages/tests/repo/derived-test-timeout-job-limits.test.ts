import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectDistributedRecipeCatalog } from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS } from '@shared-test/rallar-bb-test/fixtures/rtc-realtime-recipes.ts';
import { createViewPushManifestEntry } from '../../../apps/rallar-black-box/src/hetzner/create-view-push-manifest-entry.ts';
import { createExecuteManifestDraft } from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-manifest.ts';
import { DEFAULT_EXECUTE_RECIPE_ID } from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-workflow-state.ts';
import { computeLiveRtcLifecycleScenarioTimeoutMs } from '../../../tests/playwright/rallar-black-box/compute-live-rtc-lifecycle-scenario-timeout-ms.ts';
import { computeViewPushTestDeadlines } from '../../../tests/playwright/rallar-black-box/compute-view-push-test-deadlines.ts';
import {
    computeLiveDistributedRecipesTestTimeoutMs,
    computeSimulatedAckTestTimeoutMs,
    createLiveDistributedRecipeRuns,
    createSimulatedAckManifest,
    SIMULATED_FAILURES_TEST_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/distributed-recipes/distributed-recipe-test-runs.ts';
import {
    LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
    LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
    LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/live-rtc-matrix-test-timeouts.ts';
import {
    computeConsoleNativeTestTimeoutMs,
    CONSOLE_LIFECYCLE_TEST_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/recipe-console-monitor-test-timeouts.ts';
import { RTC_BASELINE_WORKLOAD_CATALOG } from '../../shared-rtc-bench/baseline/catalog/rtc-baseline-workload-catalog.ts';
import { toRtcB06AttemptTestTimeoutMs } from '../../shared-rtc-bench/baseline/observation/to-rtc-b06-attempt-test-timeout-ms.ts';

interface WorkflowJob {
    readonly 'timeout-minutes'?: number;
    readonly env?: Readonly<Record<string, string>>;
    readonly steps?: readonly Readonly<{ name?: string; run?: string; }>[];
}

interface WorkflowDocument {
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const B06_WORKFLOW_PATH = '.github/workflows/rtc-b06-performance-observation.yml';

const repoRoot = path.resolve(__dirname, '../../..');

const group: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'job-limit-room'
};

/** GitHub's hosted runners end any job at six hours, whatever its `timeout-minutes`. */
const GITHUB_HOSTED_JOB_MAXIMUM_MS = 360 * 60_000;

/**
 * The app browser job's work before its lifecycle test: the lane setup, the app browser tests and the in-memory
 * full-stack tests, whose limits are not derived, then Playwright starting the lifecycle test's web servers. Release
 * Gate runs 45224498021 and 45207491208 reached the lifecycle step after 10 min 23 s and 10 min 26 s, and the step's
 * servers and test took 42 s and 85 s.
 */
const E2E_APP_JOB_SETUP_MS = 15 * 60_000;

/**
 * The live recipes job's work besides its tests: containers, checkout, the lane setup, migrations and listing the
 * cases, then Playwright starting the API, SPA and control web servers. Release Gate runs 45224498021 and
 * 45207491208 spent 65 s and 59 s before the execute step, and the whole step, every case included, took under 2 min.
 */
const E2E_LIVE_RECIPES_JOB_SETUP_MS = 5 * 60_000;

/**
 * The Postgres integration job's work besides the view push test: every other step of the lane, none of them a
 * derived test. Release Gate runs 45224498021 and 45207491208 took 9 min 2 s and 9 min 41 s in all, the view push step
 * 13 s of it.
 */
const POSTGRES_INTEGRATION_JOB_SETUP_MS = 12 * 60_000;

/**
 * The B06 diagnostic job's work besides its three Playwright invocations' tests: checkout, toolchain, `npm ci`,
 * Chromium and the observation tooling check, then each invocation starting its API, SPA and control web servers. The
 * B06 capture job, which shares that setup, spent 60 s on it in run 34573688470 and 86 s in run 39110663949.
 */
const B06_DIAGNOSTIC_JOB_SETUP_MS = 10 * 60_000;

/**
 * The B06 capture job's work before its capture step: checkout, toolchain, `npm ci`, Chromium, the observation tooling
 * check and, for E4, the isolated PostgreSQL. Runs 39110663949, 39105729932, 39070106121, 38693066869, 38148414112
 * and 34573688470 reached the capture step after 86 s, 87 s, 70 s, 84 s, 67 s and 60 s.
 */
const B06_CAPTURE_JOB_SETUP_MS = 10 * 60_000;

/**
 * What the B06 capture job does once its deadline passes: the last attempt's build and web-server start, which its
 * deadline check does not count, the orchestrator's finalization and archive, then the E4 cleanup and the uploads. The
 * steps after the capture took 10 s, 5 s, 11 s, 7 s, 3 s and 3 s in the runs above, and each web server may take 60 s.
 */
const B06_CAPTURE_REPORT_RESERVE_MS = 10 * 60_000;

/** The manifest the Console's Execute view builds for its default recipe, as the Native console test starts it. */
function toConsoleNativeManifest(): RallarBlackBoxDistributedRunManifest {
    const selectedRecipe = projectDistributedRecipeCatalog({
        configuration: {
            group,
            apiBaseUrl: 'http://localhost:8080',
            rtcRealtimeDurationSeconds: RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS
        }
    }).entries.find((entry) => entry.item.recipe.recipeId === DEFAULT_EXECUTE_RECIPE_ID);
    if (!selectedRecipe) {
        throw new Error(`The Console catalog has no ${DEFAULT_EXECUTE_RECIPE_ID} recipe.`);
    }
    return createExecuteManifestDraft({
        distributedRunId: 'dist-console-native',
        controlRunId: 'console-native-run',
        group,
        selectedRecipe,
        selectedAgentIds: ['console-native-agent-1', 'console-native-agent-2']
    }).fold((issue) => {
        throw new Error(issue);
    }, (draft) => draft.manifest);
}

function readJob(workflowPath: string, job: string): WorkflowJob {
    const workflow = load(readFileSync(path.join(repoRoot, workflowPath), 'utf8')) as WorkflowDocument;
    return workflow.jobs[job] ?? {};
}

function readJobTimeoutMs(workflowPath: string, job: string): number {
    return (readJob(workflowPath, job)['timeout-minutes'] ?? 0) * 60_000;
}

describe('jobs that run tests whose timeouts are derived', () => {
    // The diagnostic job runs the matrix spec three times: alone, with every scenario, and with the retention soak; the
    // proof runs in each. With every bounded wait counted, the three no longer fit GitHub's six-hour maximum, which no
    // limit can raise; this pins that shortfall until the maintainer rules on how the diagnostic is split or bounded.
    it('records that the B06 diagnostic job\'s three invocations outlast the hosted maximum', () => {
        const casesMs = 3 * LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS + LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS +
            LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS;

        expect(readJobTimeoutMs('.github/workflows/rtc-b06-performance-observation.yml', 'diagnostic'))
            .toBe(GITHUB_HOSTED_JOB_MAXIMUM_MS);
        expect(B06_DIAGNOSTIC_JOB_SETUP_MS + casesMs).toBeGreaterThan(GITHUB_HOSTED_JOB_MAXIMUM_MS);
    });

    // The lifecycle test runs after the app browser and in-memory full-stack tests in one job.
    it('gives the app browser job room for its setup and the reopening lifecycle scenario', () => {
        const testsMs = computeLiveRtcLifecycleScenarioTimeoutMs('monotonic-readiness');

        expect(readJobTimeoutMs('.github/workflows/release-gate.yml', 'e2e-app'))
            .toBeGreaterThan(E2E_APP_JOB_SETUP_MS + testsMs);
    });

    // The live distributed recipes and the Console monitor specs run one test after another in one job.
    it('gives the live recipes job room for its setup and every distributed and Console test', () => {
        const runInput = { suffix: 'job-limit', controlRunId: 'job-limit-run', group };
        const live = createLiveDistributedRecipeRuns({ ...runInput, agentIds: ['agent-a', 'agent-b', 'agent-c'] });
        const testsMs = computeSimulatedAckTestTimeoutMs(createSimulatedAckManifest(runInput)) +
            SIMULATED_FAILURES_TEST_TIMEOUT_MS +
            computeLiveDistributedRecipesTestTimeoutMs(live) +
            CONSOLE_LIFECYCLE_TEST_TIMEOUT_MS +
            computeConsoleNativeTestTimeoutMs(toConsoleNativeManifest());

        expect(readJobTimeoutMs('.github/workflows/release-gate.yml', 'e2e-live-recipes'))
            .toBeGreaterThan(E2E_LIVE_RECIPES_JOB_SETUP_MS + testsMs);
    });

    it('gives the Postgres integration job room for its other steps and the view push test', () => {
        const { testTimeoutMs } = computeViewPushTestDeadlines(createViewPushManifestEntry().manifest);

        expect(readJobTimeoutMs('.github/workflows/release-gate.yml', 'postgres-integration'))
            .toBeGreaterThan(POSTGRES_INTEGRATION_JOB_SETUP_MS + testTimeoutMs);
    });
});

describe('the B06 capture job deadline', () => {
    const capture = readJob(B06_WORKFLOW_PATH, 'capture');

    // A slow but passing capture ran past the 360-minute job limit before it could report.
    it('gives the capture the job limit less its setup and its upload and report as its job budget', () => {
        const budgetMs = Number(capture.env?.RTC_B06_CAPTURE_JOB_BUDGET_SECONDS) * 1_000;

        expect(budgetMs).toBe(
            readJobTimeoutMs(B06_WORKFLOW_PATH, 'capture') - B06_CAPTURE_JOB_SETUP_MS -
                B06_CAPTURE_REPORT_RESERVE_MS
        );
    });

    it('passes that budget to the publish and the baseline capture', () => {
        const captureRuns = (capture.steps ?? []).filter((step) => step.run?.includes('perf:rtc-baseline'));

        expect(captureRuns.map((step) => step.name)).toEqual([
            'Capture RTC-B06 E3-memory observation',
            'Capture RTC-B06 governed branch baseline'
        ]);
        for (const step of captureRuns) {
            expect(step.run).toContain('--job-budget-seconds="$RTC_B06_CAPTURE_JOB_BUDGET_SECONDS"');
        }
    });

    it('checks each declared B06 attempt against the derived timeout of the test its case runs', () => {
        const caseIds = RTC_BASELINE_WORKLOAD_CATALOG.find((workload) => workload.workloadId === 'RTC-B06')!.cases
            .map((entry) => entry.caseId);

        expect(Object.fromEntries(caseIds.map((caseId) => [caseId, toRtcB06AttemptTestTimeoutMs(caseId)]))).toEqual({
            default: LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
            'all-scenarios': LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
            'retention-100': LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS
        });
    });
});
