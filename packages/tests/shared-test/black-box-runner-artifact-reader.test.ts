import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    BLACK_BOX_RUNNER_ARTIFACT_SCHEMA_VERSION,
    BLACK_BOX_RUNNER_RECIPE_CATALOG_SCHEMA_VERSION,
    parseBlackBoxRunnerArtifactBundle,
    parseBlackBoxRunnerEventsJsonl,
    parseBlackBoxRunnerExpandedPlan,
    validateBlackBoxRunnerRecipeCatalogEntryFixture,
    type BlackBoxRunnerArtifactBundleFiles,
} from '../../shared-test/black-box-runner/artifacts/artifact-reader.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixturesRoot = path.join(repoRoot, 'packages/shared-test/black-box-runner/fixtures/schema');

function readFixture(relativePath: string): string {
    return readFileSync(path.join(fixturesRoot, relativePath), 'utf8');
}

function readBundle(version: 'v0' | 'v1'): BlackBoxRunnerArtifactBundleFiles {
    const base = `${version}/artifact-bundle`;
    return {
        'report.json': readFixture(`${base}/report.json`),
        'events.jsonl': readFixture(`${base}/events.jsonl`),
        'failures.json': readFixture(`${base}/failures.json`),
        'metadata.json': readFixture(`${base}/metadata.json`),
        ...(version === 'v1'
            ? {
                'artifact-index.json': readFixture(`${base}/artifact-index.json`),
                'expanded-recipe.json': readFixture(`${base}/expanded-recipe.json`),
                'expanded-plan.json': readFixture(`${base}/expanded-plan.json`),
                'reduced-plan.json': readFixture(`${base}/reduced-plan.json`),
                'matrix-summary.json': readFixture(`${base}/matrix-summary.json`),
            }
            : {}),
    };
}

describe('black-box runner artifact reader', () => {
    it('parses a versioned artifact bundle into command-center views', () => {
        const result = parseBlackBoxRunnerArtifactBundle(readBundle('v1'));

        expect(result.ok).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.value?.schemaVersion).toBe(BLACK_BOX_RUNNER_ARTIFACT_SCHEMA_VERSION);
        expect(result.value?.report.summary).toMatchObject({
            total: 2,
            success: 1,
            failure: 1,
        });
        expect(result.value?.views.eventStream).toHaveLength(5);
        expect(result.value?.views.rtcDiagnostics).toHaveLength(1);
        expect(result.value?.views.rtcMessages).toHaveLength(1);
        expect(result.value?.views.failures[0]).toMatchObject({
            name: 'aliceWaits',
            connection: 'aliceRtc',
        });
        expect(result.value?.artifactIndex?.truncation).toMatchObject({
            truncated: true,
            omittedEvents: 3,
        });
        expect(result.value?.views.artifactIndex?.firstFailure).toMatchObject({
            name: 'aliceWaits',
            sequence: 4,
        });
        expect(result.value?.expandedRecipe?.recipe.steps).toHaveLength(2);
        expect(result.value?.views.expandedRecipe?.includeMetadata?.includes).toEqual([
            expect.objectContaining({
                source: 'file:fragments/rtc-connect.json',
                stepCount: 1,
            }),
        ]);
        expect(result.value?.views.replayRecipe?.steps).toHaveLength(1);
        expect(result.value?.reducedPlan?.reduction).toMatchObject({
            strategy: 'truncate-after-first-failure',
        });
        expect(result.value?.views.reducedReplayRecipe?.steps).toHaveLength(1);
        expect(result.value?.matrixSummary?.summary).toMatchObject({
            PASSED: 1,
            FAILED: 0,
            SKIPPED: 0,
        });
    });

    it('accepts legacy v0 artifact bundles and records compatibility warnings', () => {
        const result = parseBlackBoxRunnerArtifactBundle(readBundle('v0'));

        expect(result.ok).toBe(true);
        expect(result.value?.compatibility).toMatchObject({
            sourceSchemaVersion: 0,
            currentSchemaVersion: BLACK_BOX_RUNNER_ARTIFACT_SCHEMA_VERSION,
            legacy: true,
        });
        expect(result.warnings.some(warning =>
            warning.message.includes('legacy compatible v0')
        )).toBe(true);
    });

    it('returns actionable errors for malformed artifact bundles', () => {
        const missing = parseBlackBoxRunnerArtifactBundle({
            'report.json': readFixture('v1/artifact-bundle/report.json'),
        });
        expect(missing.ok).toBe(false);
        expect(missing.errors.map(error => error.message)).toEqual(expect.arrayContaining([
            'Missing required artifact file events.jsonl.',
            'Missing required artifact file failures.json.',
            'Missing required artifact file metadata.json.',
        ]));

        const badEvent = parseBlackBoxRunnerEventsJsonl(
            '{"kind":"unknown-event","connection":"aliceRtc","value":{}}\n',
        );
        expect(badEvent.ok).toBe(false);
        expect(badEvent.errors[0].message).toContain('Unsupported event kind');

        const badRedaction = parseBlackBoxRunnerArtifactBundle({
            ...readBundle('v1'),
            'report.json': readFixture('v1/artifact-bundle/report.json')
                .replace('<redacted:apiToken>', '<redacted>'),
        });
        expect(badRedaction.ok).toBe(false);
        expect(badRedaction.errors.some(error =>
            error.message.includes('Invalid redaction placeholder')
        )).toBe(true);
    });

    it('accepts post-run assertion events and preserves failure-bundle assertion data', () => {
        const result = parseBlackBoxRunnerArtifactBundle({
            ...readBundle('v1'),
            'events.jsonl': [
                '{"kind":"step-result","name":"setValue","status":"SUCCESS","transport":"SET"}',
                '{"kind":"post-run-assertion","name":"failure budget","status":"FAILURE","path":"summary.failure","operator":"max","expected":0,"actual":1}',
            ].join('\n'),
            'failures.json': JSON.stringify({
                summary: {
                    total: 1,
                    success: 0,
                    failure: 1,
                },
                failures: [],
                postRunAssertionFailures: [
                    {
                        name: 'failure budget',
                        status: 'FAILURE',
                        path: 'summary.failure',
                        operator: 'max',
                        expected: 0,
                        actual: 1,
                    },
                ],
                postRunAssertions: {
                    summary: {
                        total: 1,
                        success: 0,
                        failure: 1,
                    },
                },
                outputs: {},
            }),
        });

        expect(result.ok).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.value?.views.postRunAssertions).toHaveLength(1);
        expect(result.value?.failures.postRunAssertionFailures?.[0]).toMatchObject({
            name: 'failure budget',
            path: 'summary.failure',
        });
        expect(result.value?.failures.postRunAssertions?.summary).toMatchObject({
            failure: 1,
        });
    });

    it('accepts optional live preflight reports in artifact bundles', () => {
        const result = parseBlackBoxRunnerArtifactBundle({
            ...readBundle('v1'),
            'preflight-report.json': JSON.stringify({
                schemaVersion: 1,
                generatedAtEpochMs: 123,
                mode: 'live-environment',
                ok: false,
                summary: {
                    total: 2,
                    passed: 1,
                    failed: 1,
                    skipped: 0,
                },
                checks: [
                    {
                        id: 'rallar-api-config',
                        kind: 'rallar-api-config',
                        status: 'passed',
                    },
                    {
                        id: 'auth-login:alice',
                        kind: 'auth-login',
                        status: 'failed',
                        code: 'BAD_AUTH',
                    },
                ],
                issues: [
                    {
                        severity: 'error',
                        code: 'BAD_AUTH',
                        message: 'Login failed for configured user alice.',
                        checkId: 'auth-login:alice',
                    },
                ],
                skipReasons: [
                    'Login failed for configured user alice.',
                ],
            }),
        });

        expect(result.ok).toBe(true);
        expect(result.value?.preflightReport).toMatchObject({
            mode: 'live-environment',
            ok: false,
        });
        expect(result.value?.preflightReport?.issues[0]).toMatchObject({
            code: 'BAD_AUTH',
        });
    });

    it('validates expanded-plan replay fields', () => {
        const badPlan = parseBlackBoxRunnerExpandedPlan(JSON.stringify({
            version: 1,
            seed: 42,
            replay: false,
            decisions: [],
            steps: [],
            replayRecipe: {
                execution: {
                    trafficPlan: {},
                },
                steps: [],
            },
        }));

        expect(badPlan.ok).toBe(false);
        expect(badPlan.errors.some(error =>
            error.path === '$.replayRecipe.execution.trafficPlan'
        )).toBe(true);
    });

    it('validates current and legacy recipe catalog entry fixtures', () => {
        const current = validateBlackBoxRunnerRecipeCatalogEntryFixture(
            JSON.parse(readFixture('v1/catalog-entry.json')),
        );
        const legacy = validateBlackBoxRunnerRecipeCatalogEntryFixture(
            JSON.parse(readFixture('v0/catalog-entry.json')),
        );

        expect(current.ok).toBe(true);
        expect(current.value?.schemaVersion).toBe(BLACK_BOX_RUNNER_RECIPE_CATALOG_SCHEMA_VERSION);
        expect(current.value?.entry.support.replayArtifacts).toBe(true);

        expect(legacy.ok).toBe(true);
        expect(legacy.value?.schemaVersion).toBe(0);
        expect(legacy.value?.entry.recipePath).toBe('examples/rtc-rallar-browser-messages-rtc.json');
        expect(legacy.value?.entry.liveSupport).toBe('gated-live');
        expect(legacy.value?.entry.commands[0].command).toContain('scenario-black-box.ts');
        expect(legacy.warnings.some(warning =>
            warning.message.includes('normalized to the current command-center entry shape')
        )).toBe(true);
    });
});
