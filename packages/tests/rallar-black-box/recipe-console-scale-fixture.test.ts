import { describe, expect, it } from 'vitest';
import {
    RECIPE_CONSOLE_SCALE_DEFAULT_EVENT_COUNT,
    RECIPE_CONSOLE_SCALE_DEFAULT_RESULT_COUNT,
    RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT,
    RECIPE_CONSOLE_SCALE_MAX_FILE_BYTES,
    RECIPE_CONSOLE_SCALE_MAX_TOTAL_BYTES,
    createRecipeConsoleScaleFixture,
} from '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';
import { analyzeDistributedRunArtifactFiles } from
    '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { createDistributedArtifactWorkspace } from
    '../../../packages/shared-test/rallar-bb-test/distributed-artifact-workspace.ts';
import { validateDistributedRunManifest } from
    '../../../packages/shared-test/rallar-bb-test/distributed-run-validation.ts';

const MEBIBYTE = 1_024 * 1_024;

function lineCount(value: string | undefined): number {
    return value?.split('\n').filter(Boolean).length ?? 0;
}

function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe('Recipe Console deterministic scale fixture', () => {
    it('creates the canonical 15,000-row artifact within browser intake limits', () => {
        const fixture = createRecipeConsoleScaleFixture();

        expect(fixture.counts).toEqual({
            events: RECIPE_CONSOLE_SCALE_DEFAULT_EVENT_COUNT,
            results: RECIPE_CONSOLE_SCALE_DEFAULT_RESULT_COUNT,
            sourceRows: 15_000,
        });
        expect(lineCount(fixture.files['events.jsonl'])).toBe(12_000);
        expect(lineCount(fixture.files['results.jsonl'])).toBe(3_000);
        expect(fixture.bytes.total).toBe(
            Object.values(fixture.bytes.byFile).reduce((total, bytes) => total + bytes, 0),
        );
        expect(fixture.bytes.total).toBeLessThanOrEqual(48 * MEBIBYTE);
        expect(Object.entries(fixture.bytes.byFile).every(
            ([fileName, bytes]) => fileName.length > 0 && bytes <= 16 * MEBIBYTE,
        )).toBe(true);
        expect(fixture.bytes).toEqual({
            byFile: {
                'distributed-run.json': 1_291,
                'manifest.json': 617,
                'control-run.json': 443,
                'report.json': 363,
                'results.jsonl': 1_101_362,
                'events.jsonl': 3_648_310,
                'failures.json': 334,
                'metadata.json': 383,
            },
            total: 4_753_103,
        });
    });

    it('publishes and enforces the conservative browser intake ceilings before allocation', () => {
        expect(RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT).toBe(40_000);
        expect(RECIPE_CONSOLE_SCALE_MAX_FILE_BYTES).toBe(16 * MEBIBYTE);
        expect(RECIPE_CONSOLE_SCALE_MAX_TOTAL_BYTES).toBe(48 * MEBIBYTE);
        expect(() => createRecipeConsoleScaleFixture({
            artifactRowCount: 40_001,
        })).toThrow('artifactRowCount must not exceed 40000 source rows.');
        expect(() => createRecipeConsoleScaleFixture({
            artifactRowCount: Number.MAX_SAFE_INTEGER,
        })).toThrow('artifactRowCount must not exceed 40000 source rows.');
        expect(() => createRecipeConsoleScaleFixture({
            eventCount: 39_998,
            resultCount: 3,
        })).toThrow('eventCount and resultCount must not exceed 40000 source rows in total.');
    });

    it('accepts the exact row ceiling while keeping every artifact inside byte limits', () => {
        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 40_000 });
        const resultHeavyFixture = createRecipeConsoleScaleFixture({
            eventCount: 3,
            resultCount: 39_997,
        });

        for (const candidate of [fixture, resultHeavyFixture]) {
            expect(candidate.counts.sourceRows).toBe(40_000);
            expect(candidate.bytes.total).toBeLessThanOrEqual(48 * MEBIBYTE);
            expect(Object.values(candidate.bytes.byFile).every(
                bytes => bytes <= 16 * MEBIBYTE,
            )).toBe(true);
        }
    });

    it('provides unique first, middle, and last needles for both source streams', () => {
        const fixture = createRecipeConsoleScaleFixture();
        const events = fixture.files['events.jsonl'] ?? '';
        const results = fixture.files['results.jsonl'] ?? '';

        for (const needle of Object.values(fixture.needles.events)) {
            expect(occurrences(events, needle), needle).toBe(1);
            expect(results, needle).not.toContain(needle);
        }
        for (const needle of Object.values(fixture.needles.results)) {
            expect(occurrences(results, needle), needle).toBe(1);
            expect(events, needle).not.toContain(needle);
        }
    });

    it('is a supported distributed-run artifact with actionable failure and diagnostic evidence', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 12, resultCount: 6 });
        const manifestValidation = validateDistributedRunManifest(
            JSON.parse(fixture.files['manifest.json'] ?? 'null'),
        );
        const workspace = createDistributedArtifactWorkspace({
            files: fixture.files,
            artifactSchemaVersion: fixture.artifactSchemaVersion,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
        });
        const analysis = analyzeDistributedRunArtifactFiles({
            files: fixture.files,
            artifactSchemaVersion: fixture.artifactSchemaVersion,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
        });

        expect(
            manifestValidation.ok,
            JSON.stringify(manifestValidation.errors, null, 2),
        ).toBe(true);
        expect(workspace).toMatchObject({
            family: 'distributed-run',
            support: 'supported',
            distributedRunId: 'recipe-console-scale-distributed-run',
        });
        expect(analysis.parseWarnings).toEqual([]);
        expect(analysis).toMatchObject({
            distributedRunId: 'recipe-console-scale-distributed-run',
            controlRunId: 'recipe-console-scale-control-run',
            status: 'failed',
            ok: false,
            performance: {
                exportedEventCount: 12,
                errorDiagnosticCount: 1,
            },
            failure: {
                evidenceFile: 'results.jsonl',
                affectedAgents: ['scale-agent-001'],
                commandId: 'scale-command-000000',
            },
        });
        expect(analysis.failure?.nextAction.length).toBeGreaterThan(20);
        expect(fixture.files['results.jsonl']).toContain(fixture.needles.actionableFailure);
        expect(fixture.files['events.jsonl']).toContain(fixture.needles.actionableDiagnostic);
    });

    it('supports smaller exact source sizes and total-row scaling', () => {
        const explicit = createRecipeConsoleScaleFixture({ eventCount: 9, resultCount: 5 });
        const total = createRecipeConsoleScaleFixture({ artifactRowCount: 500 });

        expect(explicit.counts).toEqual({ events: 9, results: 5, sourceRows: 14 });
        expect(lineCount(explicit.files['events.jsonl'])).toBe(9);
        expect(lineCount(explicit.files['results.jsonl'])).toBe(5);
        expect(total.counts).toEqual({ events: 400, results: 100, sourceRows: 500 });
        expect(() => createRecipeConsoleScaleFixture({
            artifactRowCount: 500,
            eventCount: 400,
        })).toThrow(/artifactRowCount cannot be combined/);
    });
});
