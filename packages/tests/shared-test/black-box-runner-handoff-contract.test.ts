import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT,
    BLACK_BOX_RUNNER_COMMAND_CENTER_FIXTURE_CATALOG,
    BLACK_BOX_RUNNER_COVERAGE_HANDOFF,
    toBlackBoxRunnerRecipeCatalog,
    type BlackBoxRunnerRecipeMatrix,
} from '../../shared-test/black-box-runner/artifacts/handoff-contract.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const matrixPath = path.join(repoRoot, 'packages/shared-test/black-box-runner/recipe-matrix.json');

function readMatrix(): BlackBoxRunnerRecipeMatrix {
    return JSON.parse(readFileSync(matrixPath, 'utf8'));
}

describe('black-box runner command-center handoff contract', () => {
    it('normalizes recipe matrix entries into command-center catalog entries', () => {
        const catalog = toBlackBoxRunnerRecipeCatalog(readMatrix());
        const memoryTraffic = catalog.entries.find(entry => entry.id === 'memory-seeded-traffic');
        const browserLive = catalog.entries.find(entry => entry.id === 'browser-realtime-live');
        const liveSoak = catalog.entries.find(entry =>
            entry.id === 'browser-messages-rtc-same-connection-soak-live'
        );
        const expectedFailure = catalog.entries.find(entry => entry.id === 'memory-routing-failures');

        expect(catalog.version).toBe(1);
        expect(memoryTraffic).toMatchObject({
            providerMode: 'rallar-memory',
            liveSupport: 'offline',
            expectedResult: 'pass',
            support: {
                deterministic: true,
                replayArtifacts: true,
            },
        });
        expect(memoryTraffic?.commands.some(command => command.command.includes('--id=memory-seeded-traffic')))
            .toBe(true);

        expect(browserLive).toMatchObject({
            providerMode: 'rallar-browser',
            liveSupport: 'gated-live',
            prerequisites: {
                requiresPlaywright: true,
            },
        });
        expect(browserLive?.prerequisites.requiredEnvVars).toContain('RALLAR_API_BASE_URL');

        expect(liveSoak).toMatchObject({
            providerMode: 'rallar-browser',
            liveSupport: 'gated-live',
            support: {
                live: true,
            },
        });
        expect(liveSoak?.commands.some(command =>
            command.command.includes('test:shared-black-box:matrix:live:soak')
        )).toBe(true);

        expect(expectedFailure).toMatchObject({
            expectedResult: 'expected-failure',
        });
    });

    it('ships a small static fixture catalog that only references matrix recipe ids', () => {
        const matrixIds = new Set(readMatrix().entries.map(entry => entry.id));
        const fixtureIds = BLACK_BOX_RUNNER_COMMAND_CENTER_FIXTURE_CATALOG.entries.map(entry => entry.id);

        expect(fixtureIds.length).toBeGreaterThanOrEqual(4);
        expect(fixtureIds.every(id => matrixIds.has(id))).toBe(true);
        expect(BLACK_BOX_RUNNER_COMMAND_CENTER_FIXTURE_CATALOG.entries.some(entry =>
            entry.liveSupport === 'gated-live'
        )).toBe(true);
        expect(BLACK_BOX_RUNNER_COMMAND_CENTER_FIXTURE_CATALOG.entries.every(entry =>
            entry.commands.length > 0 && entry.artifactName.length > 0
        )).toBe(true);
    });

    it('documents artifact files and coverage ownership for SPA artifact browsing', () => {
        expect(BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.requiredFiles).toEqual([
            'report.json',
            'events.jsonl',
            'failures.json',
            'metadata.json',
        ]);
        expect(BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.optionalFiles)
            .toContain('artifact-index.json');
        expect(BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.optionalFiles)
            .toContain('expanded-recipe.json');
        expect(BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.optionalFiles)
            .toContain('preflight-report.json');
        expect(BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.optionalFiles).toContain('expanded-plan.json');
        expect(BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.optionalFiles).toContain('reduced-plan.json');
        expect(BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.eventStream.eventKinds).toContain('step-result');
        expect(BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.eventStream.eventKinds)
            .toContain('post-run-assertion');
        expect(BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.eventStream.truncationEventKind)
            .toBe('artifact-truncated');

        const owners = BLACK_BOX_RUNNER_COVERAGE_HANDOFF.map(entry => entry.owner);

        expect(owners).toContain('black-box-runner');
        expect(owners).toContain('rallar-bb-test');
        expect(owners).toContain('rallar-black-box-spa');
        expect(owners).toContain('rallar-black-box-control-server');
    });
});
