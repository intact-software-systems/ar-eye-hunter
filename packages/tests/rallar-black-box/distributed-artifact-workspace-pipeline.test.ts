import { describe, expect, it, vi } from 'vitest';
import {
    analyzeDistributedRunArtifactFiles,
    analyzeDistributedRunArtifactPipeline,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    parseDistributedRunArtifactPipeline
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import {
    declaredDistributedArtifactSchemaVersion,
    distributedArtifactGeneratedAt,
    identifyDistributedArtifactFamily
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-compatibility.ts';
import { projectDistributedArtifactEnvelope } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-envelope.ts';
import { distributedArtifactIdentityIssues } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-identity.ts';
import { parseDistributedArtifactPipeline } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-pipeline.ts';
import * as monitorModule from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { createDistributedArtifactWorkspace, deriveDistributedArtifactWorkspace } from '../../../packages/shared-test/rallar-bb-test/mod.ts';
import { createRecipeConsoleScaleFixture } from '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';

describe('distributed artifact workspace parsed integration', () => {
    it('derives one workspace from one source pass and one parse per document or JSONL row', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 12, resultCount: 6 });
        const derived = deriveDistributedArtifactWorkspace({
            files: fixture.files,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion
        });

        expect(derived.workspace).toEqual(createDistributedArtifactWorkspace({
            files: fixture.files,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion
        }));
        expect(derived.parsed.telemetry).toMatchObject({
            pipelinePassCount: 1,
            sourceCollectionPassCount: 1,
            sourceFileVisitCount: Object.keys(fixture.files).length,
            jsonDocumentParseCount: 6,
            jsonlFilePassCount: 2,
            jsonlRowParseCount: fixture.counts.sourceRows
        });
        expect(Object.values(derived.parsed.telemetry.jsonDocumentParseCountByFile))
            .toEqual(expect.arrayContaining([1]));
        expect(
            Object.values(derived.parsed.telemetry.jsonDocumentParseCountByFile)
                .every((count) => count <= 1)
        ).toBe(true);
        expect(
            Object.values(derived.parsed.telemetry.jsonlFilePassCountByFile)
                .every((count) => count <= 1)
        ).toBe(true);
        expect(derived.telemetry).toEqual({
            parsedArtifactPassCount: 1,
            normalizedSnapshotCount: 1,
            bundleDerivationCount: 1,
            monitorDerivationCount: 1,
            reportDerivationCount: 1
        });
        expect(derived.monitor).toBeDefined();
        expect(derived.report).toBeDefined();
        expect(derived.workspace.analysis?.spa?.report).toBe(derived.report);
        expect(derived.workspace.analysis?.spa?.report.distributedRunId)
            .toBe(
                fixture.files['distributed-run.json'] &&
                    JSON.parse(fixture.files['distributed-run.json']).distributedRunId
            );
    });

    it('preserves loose and envelope workspace output exactly', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const input = {
            files: fixture.files,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion
        };
        const loose = deriveDistributedArtifactWorkspace(input);
        const envelope = deriveDistributedArtifactWorkspace({
            files: {
                'scale-envelope.json': JSON.stringify({
                    artifactSchemaVersion: fixture.artifactSchemaVersion,
                    distributedRunId: loose.workspace.distributedRunId,
                    generatedAtEpochMs: fixture.generatedAtEpochMs,
                    files: fixture.files
                })
            }
        });

        expect(envelope.workspace).toMatchObject({
            source: 'bundle-envelope',
            support: 'supported'
        });
        expect(envelope.workspace.analysis).toEqual(loose.workspace.analysis);
        expect(envelope.workspace.snapshots).toEqual(loose.workspace.snapshots);
        expect(envelope.workspace.bundle).toEqual(loose.workspace.bundle);
        expect(envelope.workspace.inventory).toEqual(loose.workspace.inventory);
    });

    it('retains exact optional JSON and JSONL warnings without reparsing valid siblings', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const invalidJson = '{not-json';
        const invalidRow = 'not-json';
        const derived = deriveDistributedArtifactWorkspace({
            files: {
                ...fixture.files,
                'failures.json': invalidJson,
                'events.jsonl': `${fixture.files['events.jsonl']}\n${invalidRow}`
            },
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion
        });

        expect(derived.workspace.analysis?.parseWarnings).toEqual(
            expect.arrayContaining([
                {
                    fileName: 'failures.json',
                    message: `failures.json is not valid JSON: ${jsonError(invalidJson)}`
                },
                {
                    fileName: 'events.jsonl',
                    lineNumber: 7,
                    message: `events.jsonl:7 is not valid JSON: ${jsonError(invalidRow)}`
                }
            ])
        );
        expect(derived.parsed.telemetry.jsonDocumentParseCountByFile['failures.json'])
            .toBe(1);
        expect(derived.parsed.telemetry.jsonlRowParseCountByFile['events.jsonl'])
            .toBe(7);
    });

    it('reuses runner-summary fallback and a metadata-selected dynamic control response', () => {
        const responseFile = 'control-response';
        const files = fallbackFiles({
            'control-post-error-metadata.json': JSON.stringify({
                phase: 'create',
                path: '/distributed-runs',
                httpStatus: '400',
                responseFile
            }),
            [responseFile]: JSON.stringify({ message: 'dynamic response rejected' })
        });
        const derived = deriveDistributedArtifactWorkspace({
            files,
            generatedAtEpochMs: 123
        });

        expect(derived.workspace.analysis).toMatchObject({
            distributedRunId: 'dist-fallback',
            controlRunId: 'run-fallback',
            failure: {
                category: 'control-api',
                likelyCause: 'dynamic response rejected',
                evidenceFile: responseFile
            }
        });
        expect(derived.workspace.analysis?.parseWarnings).toContainEqual({
            fileName: 'distributed-run.json',
            message: 'distributed-run.json is missing or empty; using runner-summary.json and manifest.json fallback.'
        });
        expect(derived.parsed.files[responseFile]).toMatchObject({
            format: 'json',
            status: 'parsed',
            value: { message: 'dynamic response rejected' }
        });
        expect(derived.parsed.telemetry.jsonDocumentParseCountByFile[responseFile])
            .toBe(1);
        expect(derived.telemetry.monitorDerivationCount).toBe(1);
        expect(derived.telemetry.reportDerivationCount).toBe(1);
    });

    it('validates the v1 manifest fallback against its parsed distributed-run source', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const derived = deriveDistributedArtifactWorkspace({
            files: {
                ...fixture.files,
                'manifest.json': undefined,
                'report.json': undefined,
                'failures.json': undefined,
                'metadata.json': undefined
            },
            generatedAtEpochMs: fixture.generatedAtEpochMs
        });

        expect(derived.workspace).toMatchObject({
            support: 'incomplete',
            bundle: { artifactSchemaVersion: 1 }
        });
        expect(derived.monitor?.artifact).toMatchObject({ status: 'valid' });
        expect(derived.report?.summary.artifactStatus).toBe('valid');
    });

    it('isolates SPA monitor derivation failure without discarding core analysis', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const monitorSpy = vi.spyOn(monitorModule, 'deriveDistributedRunMonitor')
            .mockImplementationOnce(() => {
                throw new Error('synthetic monitor derivation failure');
            });
        try {
            const derived = deriveDistributedArtifactWorkspace({
                files: fixture.files,
                generatedAtEpochMs: fixture.generatedAtEpochMs,
                artifactSchemaVersion: fixture.artifactSchemaVersion
            });

            expect(derived.workspace).toMatchObject({
                support: 'supported',
                analysis: {
                    distributedRunId: 'recipe-console-scale-distributed-run',
                    spa: undefined
                },
                snapshots: {
                    distributedRun: {
                        distributedRunId: 'recipe-console-scale-distributed-run'
                    }
                },
                bundle: { artifactSchemaVersion: 2 }
            });
            expect(derived.workspace.analysis?.parseWarnings).toContainEqual({
                fileName: 'spa-analysis',
                message: 'Unable to derive SPA report: synthetic monitor derivation failure'
            });
            expect(derived.monitor).toBeUndefined();
            expect(derived.report).toBeUndefined();
            expect(derived.telemetry).toMatchObject({
                monitorDerivationCount: 1,
                reportDerivationCount: 0
            });
        }
        finally {
            monitorSpy.mockRestore();
        }
    });

    it('keeps raw public file wrappers literal while workspace envelope projection remains explicit', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const envelopeFiles = {
            'scale-envelope.json': JSON.stringify({
                artifactSchemaVersion: fixture.artifactSchemaVersion,
                distributedRunId: 'recipe-console-scale-distributed-run',
                generatedAtEpochMs: fixture.generatedAtEpochMs,
                files: fixture.files
            })
        };

        expect(() => analyzeDistributedRunArtifactFiles({ files: envelopeFiles }))
            .toThrow('distributed-run.json is required.');
        expect(() => distributedArtifactSnapshotsFromFiles(envelopeFiles))
            .toThrow('distributed-run.json is required.');
        expect(distributedArtifactBundleFromFiles(envelopeFiles)).toBeUndefined();
        expect(identifyDistributedArtifactFamily(envelopeFiles)).toBe('unknown');
        expect(declaredDistributedArtifactSchemaVersion(envelopeFiles)).toBeUndefined();
        expect(distributedArtifactGeneratedAt(envelopeFiles)).toBeUndefined();
        expect(distributedArtifactIdentityIssues(envelopeFiles)).toEqual([]);
        expect(projectDistributedArtifactEnvelope(envelopeFiles)).toMatchObject({
            source: 'bundle-envelope',
            distributedRunId: 'recipe-console-scale-distributed-run'
        });
        expect(deriveDistributedArtifactWorkspace({ files: envelopeFiles }).workspace)
            .toMatchObject({ source: 'bundle-envelope', support: 'supported' });
    });

    it('clones parsed warnings so repeated analysis is idempotent', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const invalidJson = '{not-json';
        const parsed = parseDistributedArtifactPipeline({
            ...fixture.files,
            'failures.json': invalidJson
        });
        const parsedFiles = parseDistributedRunArtifactPipeline(parsed);
        const first = analyzeDistributedRunArtifactPipeline({
            parsed,
            parsedFiles,
            generatedAtEpochMs: fixture.generatedAtEpochMs
        });
        const callerWarning = {
            fileName: 'caller',
            message: 'caller mutation must not leak'
        };
        (first.parseWarnings as Array<typeof callerWarning>).push(callerWarning);
        const originalMessage = parsedFiles.parseWarnings[0]?.message;
        (first.parseWarnings[0] as { message: string; }).message = 'caller object mutation must not leak';

        const second = analyzeDistributedRunArtifactPipeline({
            parsed,
            parsedFiles,
            generatedAtEpochMs: fixture.generatedAtEpochMs
        });

        expect(second.parseWarnings).not.toContainEqual(callerWarning);
        expect(parsedFiles.parseWarnings).not.toContainEqual(callerWarning);
        expect(second.parseWarnings).not.toBe(parsedFiles.parseWarnings);
        expect(second.parseWarnings[0]?.message).toBe(originalMessage);
        expect(parsedFiles.parseWarnings[0]?.message).toBe(originalMessage);
    });
});

function fallbackFiles(
    overrides: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> {
    return {
        'distributed-run.json': '',
        'runner-summary.json': JSON.stringify({
            distributedRunId: 'dist-fallback',
            controlRunId: 'run-fallback',
            state: 'failed',
            ok: false
        }),
        'manifest.json': JSON.stringify({
            schemaVersion: 1,
            distributedRunId: 'dist-fallback',
            controlRunId: 'run-fallback',
            group: { groupId: 'pipeline-room' },
            recipes: []
        }),
        'control-run.json': JSON.stringify({
            runId: 'run-fallback',
            agents: [],
            commands: [],
            results: [],
            events: [],
            stats: [],
            reports: [],
            heartbeats: []
        }),
        ...overrides
    };
}

function jsonError(text: string): string {
    try {
        JSON.parse(text);
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('Expected malformed JSON.');
}
