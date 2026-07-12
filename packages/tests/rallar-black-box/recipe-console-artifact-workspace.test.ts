import { describe, expect, it } from 'vitest';
import {
    createDistributedArtifactWorkspace,
    type DistributedArtifactWorkspace,
    type DistributedArtifactWorkspaceInput,
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    type DistributedRunArtifactFiles,
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

function createWorkspace(input: DistributedArtifactWorkspaceInput): DistributedArtifactWorkspace {
    return createDistributedArtifactWorkspace(input);
}

function serverV2Files(
    overrides: DistributedRunArtifactFiles = {},
): DistributedRunArtifactFiles {
    const distributedRun = {
        distributedRunId: 'distributed-import',
        controlRunId: 'control-import',
        state: 'failed',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
        completedAtEpochMs: 2_000,
        targetAgentIds: ['agent-eu'],
        commandLinks: [],
        manifest: {
            schemaVersion: 1,
            distributedRunId: 'distributed-import',
            controlRunId: 'control-import',
            group: { groupId: 'ci-import' },
            recipes: [],
            targetPolicy: {},
            roleAssignments: [],
            startMode: 'manual',
        },
        rollup: {
            state: 'failed',
            ok: false,
            failures: [{ code: 'rtc-timeout', message: 'Receiver timed out.' }],
            summary: { blockingFailures: 1 },
        },
    };
    const controlRun = {
        runId: 'control-import',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
        agents: [{
            runId: 'control-import',
            agentId: 'agent-eu',
            connected: true,
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: [],
        }],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
    const summary = {
        total: 1,
        success: 0,
        failure: 1,
        commandCount: 0,
        eventCount: 0,
        agentCount: 1,
        reportCount: 0,
    };

    return {
        'distributed-run.json': JSON.stringify(distributedRun),
        'manifest.json': JSON.stringify(distributedRun.manifest),
        'control-run.json': JSON.stringify(controlRun),
        'report.json': JSON.stringify({
            schemaVersion: 2,
            artifactSchemaVersion: 2,
            execution: 'distributed-run',
            distributedRunId: 'distributed-import',
            controlRunId: 'control-import',
            state: 'failed',
            ok: false,
            summary,
            resultsList: [],
            outputs: {},
        }),
        'failures.json': JSON.stringify({
            summary,
            failures: [{ source: 'distributed-rollup', code: 'rtc-timeout' }],
            outputs: {},
        }),
        'metadata.json': JSON.stringify({
            schemaVersion: 2,
            artifactSchemaVersion: 2,
            generatedAtEpochMs: 3_000,
            config: 'rallar-black-box-control-server',
            execution: 'distributed-run',
            summary,
        }),
        ...overrides,
    };
}

function inventoryStatus(
    workspace: DistributedArtifactWorkspace,
    fileName: string,
): string | undefined {
    return workspace.inventory.find(item => item.fileName === fileName)?.status;
}

describe('Recipe Console distributed artifact workspace compatibility', () => {
    it('recognizes the authoritative server v2 bundle without linked JSONL files', () => {
        const files = serverV2Files();
        const workspace = createWorkspace({ files, generatedAtEpochMs: 4_242 });
        const bundle = distributedArtifactBundleFromFiles(files, 4_242);

        expect(bundle?.artifactSchemaVersion).toBe(2);
        expect(workspace).toMatchObject({
            family: 'distributed-run',
            source: 'loose-files',
            support: 'supported',
            artifactSchemaVersion: 2,
            generatedAtEpochMs: 4_242,
            files,
            analysis: {
                artifactSchemaVersion: 2,
                distributedRunId: 'distributed-import',
            },
            snapshots: {
                distributedRun: { distributedRunId: 'distributed-import' },
                controlRun: { runId: 'control-import' },
                artifactBundle: { artifactSchemaVersion: 2 },
            },
            bundle: { artifactSchemaVersion: 2 },
        });
        expect(inventoryStatus(workspace, 'events.jsonl')).toBe('missing-optional');
        expect(inventoryStatus(workspace, 'results.jsonl')).toBe('missing-optional');
    });

    it('unwraps exported envelopes and converges with the equivalent loose files', () => {
        const files = serverV2Files();
        const loose = createWorkspace({
            files,
            artifactSchemaVersion: 2,
            generatedAtEpochMs: 5_151,
        });
        const envelope = createWorkspace({
            files: {
                'distributed-import-artifact.json': JSON.stringify({
                    artifactSchemaVersion: 2,
                    distributedRunId: 'distributed-import',
                    generatedAtEpochMs: 5_151,
                    files,
                }),
            },
        });

        expect(envelope).toMatchObject({
            family: 'distributed-run',
            source: 'bundle-envelope',
            support: 'supported',
            artifactSchemaVersion: 2,
            generatedAtEpochMs: 5_151,
            files,
        });
        expect(envelope.analysis).toEqual(loose.analysis);
        expect(envelope.snapshots).toEqual(loose.snapshots);
        expect(envelope.bundle).toEqual(loose.bundle);
        expect(envelope.inventory).toEqual(loose.inventory);
    });

    it('projects an explicit source schema version through analysis and bundle helpers', () => {
        const files = serverV2Files({
            'report.json': undefined,
            'failures.json': undefined,
            'metadata.json': undefined,
        });
        const analysis = analyzeDistributedRunArtifactFiles({
            files,
            generatedAtEpochMs: 6_161,
            artifactSchemaVersion: 2,
        });
        const bundle = distributedArtifactBundleFromFiles(
            files,
            6_161,
            'distributed-import',
            2,
        );

        expect(analysis.artifactSchemaVersion).toBe(2);
        expect(bundle?.artifactSchemaVersion).toBe(2);
    });

    it('reports a caller and envelope schema conflict as incompatible', () => {
        const workspace = createWorkspace({
            artifactSchemaVersion: 1,
            files: {
                'distributed-import-artifact.json': JSON.stringify({
                    artifactSchemaVersion: 2,
                    distributedRunId: 'distributed-import',
                    generatedAtEpochMs: 7_171,
                    files: serverV2Files(),
                }),
            },
        });

        expect(workspace).toMatchObject({
            family: 'distributed-run',
            source: 'bundle-envelope',
            support: 'incompatible',
        });
        expect(workspace.analysis).toBeUndefined();
        expect(workspace.snapshots).toBeUndefined();
        expect(workspace.bundle).toBeUndefined();
        expect(inventoryStatus(workspace, '$artifactSchemaVersion')).toBe('incompatible');
        expect(workspace.issues).toContainEqual(expect.objectContaining({
            code: 'schema-version-conflict',
        }));
    });

    it('keeps valid siblings usable when optional evidence is malformed or incompatible', () => {
        const workspace = createWorkspace({
            files: serverV2Files({
                'events.jsonl': `${JSON.stringify({
                    kind: 'diagnostic',
                    agentId: 'agent-eu',
                    payload: { severity: 'warning', message: 'Valid sibling row.' },
                })}\nnot-json`,
                'results.jsonl': `${JSON.stringify({
                    kind: 'result',
                    agentId: 'agent-eu',
                    commandId: 'command-a',
                    status: 'FAILURE',
                })}\n`,
                'failures.json': '{not-json',
                'metadata.json': '[]',
            }),
            generatedAtEpochMs: 8_181,
        });

        expect(workspace.support).toBe('supported');
        expect(workspace.analysis).toMatchObject({
            artifactSchemaVersion: 2,
            distributedRunId: 'distributed-import',
        });
        expect(workspace.analysis.parseWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ fileName: 'events.jsonl', lineNumber: 2 }),
            expect.objectContaining({ fileName: 'failures.json' }),
        ]));
        expect(inventoryStatus(workspace, 'events.jsonl')).toBe('malformed');
        expect(inventoryStatus(workspace, 'failures.json')).toBe('malformed');
        expect(inventoryStatus(workspace, 'metadata.json')).toBe('incompatible');
        expect(inventoryStatus(workspace, 'results.jsonl')).toBe('loaded');
        expect(inventoryStatus(workspace, 'report.json')).toBe('loaded');
    });

    it('distinguishes missing, malformed, and incompatible core files', () => {
        const missing = createWorkspace({
            files: serverV2Files({ 'control-run.json': undefined }),
            generatedAtEpochMs: 9_191,
        });
        const malformed = createWorkspace({
            files: serverV2Files({ 'distributed-run.json': '{bad' }),
            generatedAtEpochMs: 9_192,
        });
        const incompatible = createWorkspace({
            files: serverV2Files({ 'distributed-run.json': '[]' }),
            generatedAtEpochMs: 9_193,
        });

        expect(missing.support).toBe('incomplete');
        expect(inventoryStatus(missing, 'control-run.json')).toBe('missing-core');
        expect(missing.analysis).toMatchObject({
            distributedRunId: 'distributed-import',
            controlRunId: 'control-import',
        });
        expect(missing.snapshots).toMatchObject({
            distributedRun: { distributedRunId: 'distributed-import' },
            controlRun: { runId: 'control-import' },
        });
        expect(missing.bundle).toBeUndefined();
        expect(malformed.support).toBe('incompatible');
        expect(inventoryStatus(malformed, 'distributed-run.json')).toBe('malformed');
        expect(malformed.analysis?.parseWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ fileName: 'distributed-run.json' }),
        ]));
        expect(incompatible.support).toBe('incompatible');
        expect(inventoryStatus(incompatible, 'distributed-run.json')).toBe('incompatible');
        expect(incompatible.analysis).toBeDefined();
    });

    it('marks unknown schema versions without coercing them to a supported version', () => {
        const workspace = createWorkspace({
            files: {
                'distributed-import-artifact.json': JSON.stringify({
                    artifactSchemaVersion: 99,
                    distributedRunId: 'distributed-import',
                    generatedAtEpochMs: 10_101,
                    files: serverV2Files(),
                }),
            },
        });

        expect(workspace).toMatchObject({
            family: 'distributed-run',
            artifactSchemaVersion: 99,
            support: 'unsupported',
        });
        expect(inventoryStatus(workspace, '$artifactSchemaVersion')).toBe('unknown-version');
        expect(workspace.analysis).toMatchObject({
            artifactSchemaVersion: 99,
            distributedRunId: 'distributed-import',
        });
        expect(workspace.snapshots?.artifactBundle?.artifactSchemaVersion).toBe(99);
        expect(workspace.bundle?.artifactSchemaVersion).toBe(99);
    });

    it('rejects an envelope mixed with loose artifact files instead of choosing one silently', () => {
        const files = serverV2Files();
        const workspace = createWorkspace({
            generatedAtEpochMs: 10_202,
            files: {
                'manifest.json': files['manifest.json'],
                'distributed-import-artifact.json': JSON.stringify({
                    artifactSchemaVersion: 2,
                    distributedRunId: 'distributed-import',
                    generatedAtEpochMs: 10_202,
                    files,
                }),
            },
        });

        expect(workspace).toMatchObject({
            source: 'bundle-envelope',
            support: 'incompatible',
        });
        expect(workspace.analysis).toBeUndefined();
        expect(workspace.issues).toContainEqual(expect.objectContaining({
            code: 'ambiguous-envelope',
            severity: 'error',
        }));
    });

    it('retains analysis but rejects an envelope whose declared run differs from inner evidence', () => {
        const workspace = createWorkspace({
            files: {
                'distributed-import-artifact.json': JSON.stringify({
                    artifactSchemaVersion: 2,
                    distributedRunId: 'distributed-other',
                    generatedAtEpochMs: 10_303,
                    files: serverV2Files(),
                }),
            },
        });

        expect(workspace).toMatchObject({
            source: 'bundle-envelope',
            support: 'incompatible',
            distributedRunId: 'distributed-import',
            analysis: { distributedRunId: 'distributed-import' },
        });
        expect(workspace.issues).toContainEqual(expect.objectContaining({
            code: 'identity-conflict',
            severity: 'error',
            fileName: 'distributed-import-artifact.json',
        }));
    });

    it('retains usable evidence but rejects conflicting loose-file run identities', () => {
        const files = serverV2Files();
        const manifest = JSON.parse(files['manifest.json'] ?? '{}');
        const controlRun = JSON.parse(files['control-run.json'] ?? '{}');
        const report = JSON.parse(files['report.json'] ?? '{}');
        manifest.distributedRunId = 'distributed-manifest-other';
        controlRun.runId = 'control-other';
        report.distributedRunId = 'distributed-report-other';
        const workspace = createWorkspace({
            files: {
                ...files,
                'manifest.json': JSON.stringify(manifest),
                'control-run.json': JSON.stringify(controlRun),
                'report.json': JSON.stringify(report),
            },
            generatedAtEpochMs: 10_353,
        });

        expect(workspace).toMatchObject({
            family: 'distributed-run',
            support: 'incompatible',
            analysis: { distributedRunId: 'distributed-import' },
        });
        expect(workspace.issues.filter(issue => issue.code === 'identity-conflict'))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ fileName: 'manifest.json' }),
                expect.objectContaining({ fileName: 'control-run.json' }),
                expect.objectContaining({ fileName: 'report.json' }),
            ]));
    });

    it('reports an envelope-shaped wrong root precisely', () => {
        const workspace = createWorkspace({
            files: {
                'broken-artifact.json': JSON.stringify({
                    artifactSchemaVersion: '2',
                    distributedRunId: 42,
                    generatedAtEpochMs: 'today',
                    files: [],
                }),
            },
            generatedAtEpochMs: 10_404,
        });

        expect(workspace).toMatchObject({
            source: 'bundle-envelope',
            support: 'incompatible',
        });
        expect(workspace.issues).toContainEqual(expect.objectContaining({
            code: 'incompatible-file',
            fileName: 'broken-artifact.json',
        }));
    });

    it('identifies generic black-box-runner artifacts as a separate unsupported family', () => {
        const workspace = createWorkspace({
            files: {
                'report.json': JSON.stringify({
                    schemaVersion: 1,
                    summary: { total: 1, success: 0, failure: 1 },
                    resultsList: [{ resultKey: 'http-i1-r1', status: 'FAILURE' }],
                    outputs: {},
                }),
                'failures.json': JSON.stringify({
                    summary: { total: 1, success: 0, failure: 1 },
                    failures: [],
                    outputs: {},
                }),
                'metadata.json': JSON.stringify({
                    artifactSchemaVersion: 1,
                    execution: 'run',
                    command: ['deno', 'run', 'scenario-black-box.ts'],
                }),
                'events.jsonl': '',
            },
            generatedAtEpochMs: 11_111,
        });

        expect(workspace).toMatchObject({
            family: 'black-box-runner',
            source: 'loose-files',
            support: 'unsupported',
        });
        expect(workspace.analysis).toBeUndefined();
        expect(workspace.snapshots).toBeUndefined();
        expect(workspace.bundle).toBeUndefined();
        expect(workspace.issues).toContainEqual(expect.objectContaining({
            code: 'unsupported-family',
        }));
    });

    it('records unknown loose files as ignored inventory and issues', () => {
        const workspace = createWorkspace({
            files: serverV2Files({
                'ci-notes.txt': 'retry on a different host',
                'mystery.json': '{}',
            }),
            generatedAtEpochMs: 12_121,
        });

        expect(workspace.support).toBe('supported');
        expect(inventoryStatus(workspace, 'ci-notes.txt')).toBe('ignored');
        expect(inventoryStatus(workspace, 'mystery.json')).toBe('ignored');
        expect(workspace.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'ignored-file', fileName: 'ci-notes.txt' }),
            expect.objectContaining({ code: 'ignored-file', fileName: 'mystery.json' }),
        ]));
    });
});
