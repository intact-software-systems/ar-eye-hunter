import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
    LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
    LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/live-rtc-matrix-test-timeouts.ts';

interface WorkflowDocument {
    readonly jobs: Readonly<Record<string, Readonly<{ 'timeout-minutes'?: number; }>>>;
}

const repoRoot = path.resolve(__dirname, '../../..');

/**
 * The B06 diagnostic job's work besides its three Playwright invocations' tests: checkout, toolchain, `npm ci`,
 * Chromium and the observation tooling check, then each invocation starting its API, SPA and control web servers. The
 * B06 capture job, which shares that setup, spent 60 s on it in run 34573688470 and 86 s in run 39110663949.
 */
const B06_DIAGNOSTIC_JOB_SETUP_MS = 10 * 60_000;

function readJobTimeoutMs(workflowPath: string, job: string): number {
    const workflow = load(readFileSync(path.join(repoRoot, workflowPath), 'utf8')) as WorkflowDocument;
    return (workflow.jobs[job]?.['timeout-minutes'] ?? 0) * 60_000;
}

describe('jobs that run tests whose timeouts are derived', () => {
    // The diagnostic job runs the matrix spec three times: alone, with every scenario, and with the retention soak. The
    // proof runs in each, so a hung run of any case is killed by its test before the 360-minute job.
    it('gives the B06 diagnostic job room for its setup, three proofs, every scenario and the soak bound', () => {
        const casesMs = 3 * LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS + LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS +
            LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS;

        expect(readJobTimeoutMs('.github/workflows/rtc-b06-performance-observation.yml', 'diagnostic'))
            .toBeGreaterThan(B06_DIAGNOSTIC_JOB_SETUP_MS + casesMs);
    });
});
