import { describe, expect, it, vi } from 'vitest';
import {
    computeDistributedRunArtifactAnalysis,
    toDistributedArtifactBundle,
    toDistributedArtifactSnapshots
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { computeDistributedRunArtifactPipelineAnalysis } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/compute-distributed-run-artifact-pipeline-analysis.ts';
import { toDistributedRunArtifactContent } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/to-distributed-run-artifact-content.ts';
import {
    declaredDistributedArtifactSchemaVersion,
    distributedArtifactGeneratedAt,
    identifyDistributedArtifactFamily
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-compatibility.ts';
import { projectDistributedArtifactEnvelope } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-envelope.ts';
import { distributedArtifactIdentityIssues } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-identity.ts';
import { parseDistributedArtifactPipeline } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-pipeline.ts';
import * as monitorModule from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { computeDistributedArtifactWorkspace } from '../../../packages/shared-test/rallar-bb-test/mod.ts';
import { createRecipeConsoleScaleFixture } from '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';

describe('distributed artifact workspace parsed integration', () => {
    it('derives one workspace from one source pass and one parse per document or JSONL row', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 12, resultCount: 6 });
        const derived = computeDistributedArtifactWorkspace({
            files: fixture.files,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion
        });

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
        const loose = computeDistributedArtifactWorkspace(input);
        const envelope = computeDistributedArtifactWorkspace({
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
        const derived = computeDistributedArtifactWorkspace({
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

    it('parses a metadata-selected dynamic control response once and focuses the run analysis on it', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const responseFile = 'control-response';
        const derived = computeDistributedArtifactWorkspace({
            files: {
                ...fixture.files,
                'control-post-error-metadata.json': JSON.stringify({
                    phase: 'stage',
                    method: 'POST',
                    path: '/distributed-runs/recipe-console-scale-distributed-run/stage',
                    httpStatus: '400',
                    curlStatus: 0,
                    exitStatus: 22,
                    responseFile,
                    atEpochSeconds: 1_735_732_800
                }),
                [responseFile]: JSON.stringify({ message: 'dynamic response rejected' })
            },
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion
        });

        expect(derived.workspace.analysis).toMatchObject({
            distributedRunId: 'recipe-console-scale-distributed-run',
            controlRunId: 'recipe-console-scale-control-run',
            failure: {
                category: 'control-api',
                likelyCause: 'dynamic response rejected',
                evidenceFile: responseFile
            }
        });
        expect(derived.parsed.files[responseFile]).toMatchObject({
            format: 'json',
            status: 'parsed',
            value: { message: 'dynamic response rejected' }
        });
        expect(derived.parsed.telemetry.jsonDocumentParseCountByFile[responseFile])
            .toBe(1);
    });

    it('reports a failed control request record as a workspace issue instead of a distributed run analysis', () => {
        const derived = computeDistributedArtifactWorkspace({
            files: {
                'manifest.json': createRecipeConsoleScaleFixture({ eventCount: 3, resultCount: 3 }).files['manifest.json'],
                'control-post-create-error.json': JSON.stringify({ message: 'target policy rejected' }),
                'control-post-error-metadata.json': JSON.stringify({
                    phase: 'create',
                    method: 'POST',
                    path: '/distributed-runs',
                    httpStatus: '400',
                    curlStatus: 0,
                    exitStatus: 22,
                    responseFile: 'control-post-create-error.json',
                    atEpochSeconds: 1_735_732_800
                })
            },
            generatedAtEpochMs: 123
        });

        expect(derived.workspace).toMatchObject({ family: 'distributed-run', support: 'incompatible' });
        expect(derived.workspace.analysis).toBeUndefined();
        expect(derived.workspace.issues).toContainEqual({
            code: 'control-request-failure',
            severity: 'error',
            fileName: 'control-post-error-metadata.json',
            message:
                'The artifacts record a failed control create request and contain no distributed run; analyze the folder with the distributed-run artifact CLI.'
        });
    });

    it('reports a missing generation time instead of reading the clock', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 3, resultCount: 3 });
        const derived = computeDistributedArtifactWorkspace({
            files: { ...fixture.files, 'metadata.json': undefined }
        });

        expect(derived.workspace.generatedAtEpochMs).toBeUndefined();
        expect(derived.workspace.analysis).toBeUndefined();
        expect(derived.workspace.issues).toContainEqual({
            code: 'missing-generation-time',
            severity: 'error',
            message: 'The artifacts record no generation time (neither an envelope nor metadata.json), and none was supplied.'
        });
    });

    it('leaves the bundle unformed and says so when a v1 import lacks manifest.json', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const derived = computeDistributedArtifactWorkspace({
            files: {
                ...fixture.files,
                'manifest.json': undefined,
                'report.json': undefined,
                'failures.json': undefined,
                'metadata.json': undefined
            },
            generatedAtEpochMs: fixture.generatedAtEpochMs
        });

        expect(derived.workspace).toMatchObject({ support: 'incomplete' });
        expect(derived.workspace.bundle).toBeUndefined();
        expect(derived.workspace.analysis?.parseWarnings).toContainEqual({
            fileName: 'manifest.json',
            message: 'manifest.json is required to form a distributed-run artifact bundle.'
        });
        expect(derived.monitor?.artifact).toMatchObject({ status: 'not-loaded' });
    });

    it('lets an unexpected SPA monitor exception fail the derivation instead of hiding it as an artifact warning', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const monitorSpy = vi.spyOn(monitorModule, 'deriveDistributedRunMonitor')
            .mockImplementationOnce(() => {
                throw new Error('synthetic monitor derivation failure');
            });
        try {
            expect(() =>
                computeDistributedArtifactWorkspace({
                    files: fixture.files,
                    generatedAtEpochMs: fixture.generatedAtEpochMs,
                    artifactSchemaVersion: fixture.artifactSchemaVersion
                })
            ).toThrow('synthetic monitor derivation failure');
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

        const missingRun = {
            fileName: 'distributed-run.json',
            message: 'distributed-run.json is required: the artifacts hold neither a distributed run snapshot nor a failed control request record.'
        };
        expect(computeDistributedRunArtifactAnalysis({ files: envelopeFiles, generatedAtEpochMs: 1 }).left)
            .toEqual(missingRun);
        expect(toDistributedArtifactSnapshots(envelopeFiles, 1).left).toEqual(missingRun);
        expect(toDistributedArtifactBundle(envelopeFiles, 1).left).toEqual(missingRun);
        expect(identifyDistributedArtifactFamily(envelopeFiles)).toBe('unknown');
        expect(declaredDistributedArtifactSchemaVersion(envelopeFiles)).toBeUndefined();
        expect(distributedArtifactGeneratedAt(envelopeFiles)).toBeUndefined();
        expect(distributedArtifactIdentityIssues(envelopeFiles)).toEqual([]);
        expect(projectDistributedArtifactEnvelope(envelopeFiles)).toMatchObject({
            source: 'bundle-envelope',
            distributedRunId: 'recipe-console-scale-distributed-run'
        });
        expect(computeDistributedArtifactWorkspace({ files: envelopeFiles }).workspace)
            .toMatchObject({ source: 'bundle-envelope', support: 'supported' });
    });

    it('clones parsed warnings so repeated analysis is idempotent', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const invalidJson = '{not-json';
        const parsed = parseDistributedArtifactPipeline({
            ...fixture.files,
            'failures.json': invalidJson
        });
        const content = toDistributedRunArtifactContent(parsed).right;
        if (content?.variant !== 'distributed-run') {
            throw new Error('Expected distributed run content.');
        }
        const first = computeDistributedRunArtifactPipelineAnalysis({
            parsed,
            content,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion
        }).analysis;
        const callerWarning = {
            fileName: 'caller',
            message: 'caller mutation must not leak'
        };
        (first.parseWarnings as Array<typeof callerWarning>).push(callerWarning);
        const originalMessage = content.parseWarnings[0]?.message;
        (first.parseWarnings[0] as { message: string; }).message = 'caller object mutation must not leak';

        const second = computeDistributedRunArtifactPipelineAnalysis({
            parsed,
            content,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion
        }).analysis;

        expect(second.parseWarnings).not.toContainEqual(callerWarning);
        expect(content.parseWarnings).not.toContainEqual(callerWarning);
        expect(second.parseWarnings).not.toBe(content.parseWarnings);
        expect(second.parseWarnings[0]?.message).toBe(originalMessage);
        expect(content.parseWarnings[0]?.message).toBe(originalMessage);
    });
});

function jsonError(text: string): string {
    try {
        JSON.parse(text);
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('Expected malformed JSON.');
}
