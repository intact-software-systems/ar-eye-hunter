import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { decodeDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { ALL_LOCAL_ALM_MANIFEST_PATHS } from '../../../apps/rallar-black-box/scripts/select-all-local-alm-manifest.mjs';
import { computeAllLocalAlmObservationDeadlines } from '../../../tests/playwright/rallar-black-box/compute-all-local-alm-observation-deadlines.ts';

interface WorkflowDocument {
    readonly jobs: Readonly<Record<string, Readonly<{ 'timeout-minutes'?: number; }>>>;
}

const repoRoot = path.resolve(__dirname, '../../..');

/**
 * The all-local job's work before the spec's test starts: containers and checkout, toolchain and browser setup,
 * migrations, source admission and provenance, then Playwright starting the API, SPA and control web servers. The
 * job's own runs 42523832468, 41790618924 and 41762853749 spent 42 s to 65 s before their observe step with a warm
 * cache, and their whole observe step, web servers included, took 80 s to 85 s; ALM conformance observation run
 * 45214937652, which shares the toolchain and browser setup, spent 5 min 47 s on that setup with a cold cache.
 */
const ALL_LOCAL_JOB_SETUP_MS = 10 * 60_000;

function readSelectableManifest(manifestPath: string): RallarBlackBoxDistributedRunManifest {
    const value: unknown = JSON.parse(readFileSync(path.join(repoRoot, manifestPath), 'utf8'));
    return decodeDistributedRunManifest(value).fold(
        () => {
            throw new Error(`${manifestPath} could not be decoded.`);
        },
        (manifest) => manifest
    );
}

function readAllLocalJobTimeoutMs(): number {
    const workflow = load(
        readFileSync(path.join(repoRoot, '.github/workflows/github-free-distributed-recipe.yml'), 'utf8')
    ) as WorkflowDocument;
    return (workflow.jobs['all-local']?.['timeout-minutes'] ?? 0) * 60_000;
}

describe('all-local ALM observation deadlines', () => {
    it('derives the terminal wait, the harness abort and the test limit from the selected manifest', () => {
        // registration 90 s + readiness 330 s + the manifest's terminal timeout + export 60 s; cleanup 120 s after it.
        expect(computeAllLocalAlmObservationDeadlines(readSelectableManifest(ALL_LOCAL_ALM_MANIFEST_PATHS.get(6) ?? '')))
            .toEqual({ terminalTimeoutMs: 860_000, harnessTimeoutMs: 1_340_000, testTimeoutMs: 1_460_000 });
        expect(computeAllLocalAlmObservationDeadlines(readSelectableManifest(ALL_LOCAL_ALM_MANIFEST_PATHS.get(50) ?? '')))
            .toEqual({ terminalTimeoutMs: 928_000, harnessTimeoutMs: 1_408_000, testTimeoutMs: 1_528_000 });
    });

    it('gives the all-local job a limit above the largest selectable test limit plus the job\'s own setup', () => {
        const testTimeoutsMs = [...ALL_LOCAL_ALM_MANIFEST_PATHS.values()].map((manifestPath) =>
            computeAllLocalAlmObservationDeadlines(readSelectableManifest(manifestPath)).testTimeoutMs
        );

        expect(testTimeoutsMs).toHaveLength(5);
        expect(readAllLocalJobTimeoutMs()).toBeGreaterThan(Math.max(...testTimeoutsMs) + ALL_LOCAL_JOB_SETUP_MS);
    });
});
