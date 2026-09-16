import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeDistributedRunArtifactAnalysis } from '../../../../apps/rallar-black-box/scripts/write-distributed-run-artifact-analysis.ts';
import type {
    DistributedRunAnalysis,
    DistributedRunArtifactFiles,
    DistributedRunControlRequestFailureAnalysis,
    DistributedRunFailedAnalysis
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import {
    createControlRunSnapshot,
    createDistributedRunSnapshot,
    createQueuedCommandSnapshot,
    toDistributedRunArtifactFiles
} from './distributed-artifact-files-fixture.ts';

const GENERATED_AT_EPOCH_MS = 123;

async function createArtifactDirectory(prefix: string, files: DistributedRunArtifactFiles): Promise<string> {
    const artifactDir = await mkdtemp(path.join(tmpdir(), prefix));
    await Promise.all(
        Object.entries(files).map(async ([fileName, text]) => {
            if (text !== undefined) {
                await writeFile(path.join(artifactDir, fileName), text);
            }
        })
    );
    return artifactDir;
}

async function readAnalysisJson<Analysis>(outDir: string): Promise<Analysis> {
    return JSON.parse(await readFile(path.join(outDir, 'analysis.json'), 'utf8')) as Analysis;
}

describe('distributed run artifact analysis CLI', () => {
    it('writes CLI analysis files for failed and passed artifact directories', async () => {
        const artifactDir = await createArtifactDirectory(
            'rallar-distributed-artifacts-',
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-cli',
                    controlRunId: 'run-cli',
                    state: 'failed',
                    agentIds: ['agent-a'],
                    startedAtEpochMs: 1,
                    completedAtEpochMs: 5,
                    failures: [{
                        kind: 'participant',
                        key: 'agent-a',
                        state: 'failed',
                        required: true,
                        error: { code: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT', message: 'Missing ACK.' }
                    }]
                }),
                controlRun: createControlRunSnapshot({ runId: 'run-cli' })
            })
        );
        const outDir = path.join(artifactDir, 'analysis');

        const analyzed = await writeDistributedRunArtifactAnalysis({
            artifactDir,
            outDir,
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        const analysis = await readAnalysisJson<DistributedRunFailedAnalysis>(outDir);
        expect(analyzed.right?.analysis).toEqual(analysis);
        expect(analysis).toMatchObject({
            artifactSchemaVersion: 1,
            controlRunId: 'run-cli',
            ok: false,
            performance: expect.any(Object),
            spa: { report: expect.any(Object), verdict: expect.any(Object) },
            fixProposalMarkdown: expect.stringContaining('# Fix Proposal: dist-cli'),
            performanceMarkdown: expect.stringContaining('# Performance: dist-cli')
        });
        expect(analysis.failure.minimalFixArea).toBe('headless agent readiness');
        expect(analysis.parseWarnings).toEqual([]);
        await expect(readFile(path.join(outDir, 'summary.md'), 'utf8')).resolves.toContain('dist-cli');
        await expect(readFile(path.join(outDir, 'fix-proposal.md'), 'utf8')).resolves.toContain('Suggested verification');
    });

    it('writes passed-run performance files with percentile and diagnostic severity counts', async () => {
        const artifactDir = await createArtifactDirectory(
            'rallar-distributed-passed-artifacts-',
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-cli-passed',
                    controlRunId: 'run-cli-passed',
                    state: 'passed',
                    agentIds: ['agent-a', 'agent-b'],
                    startedAtEpochMs: 100,
                    completedAtEpochMs: 900,
                    commandLinks: [
                        { phase: 'start', agentId: 'agent-a', commandId: 'cmd-a', queuedAtEpochMs: 100 },
                        { phase: 'start', agentId: 'agent-b', commandId: 'cmd-b', queuedAtEpochMs: 100 },
                        { phase: 'start', agentId: 'agent-b', commandId: 'cmd-c', queuedAtEpochMs: 100 }
                    ]
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-cli-passed',
                    agents: [
                        { agentId: 'agent-a', receivedEventCount: 2 },
                        { agentId: 'agent-b', reconnectCount: 1, receivedEventCount: 3 }
                    ],
                    commands: [
                        createQueuedCommandSnapshot({
                            runId: 'run-cli-passed',
                            agentId: 'agent-a',
                            commandId: 'cmd-a',
                            queuedAtEpochMs: 100,
                            dispatchedAtEpochMs: 110,
                            completedAtEpochMs: 130
                        }),
                        createQueuedCommandSnapshot({
                            runId: 'run-cli-passed',
                            agentId: 'agent-b',
                            commandId: 'cmd-b',
                            queuedAtEpochMs: 100,
                            dispatchedAtEpochMs: 120,
                            completedAtEpochMs: 160
                        }),
                        createQueuedCommandSnapshot({
                            runId: 'run-cli-passed',
                            agentId: 'agent-b',
                            commandId: 'cmd-c',
                            queuedAtEpochMs: 100,
                            dispatchedAtEpochMs: 130,
                            completedAtEpochMs: 530
                        })
                    ]
                }),
                files: {
                    'events.jsonl': [
                        JSON.stringify({ kind: 'runtime', value: { severity: 'info', message: 'loaded' } }),
                        JSON.stringify({ kind: 'runtime', value: { severity: 'warning', message: 'slow route' } })
                    ].join('\n')
                }
            })
        );
        const outDir = path.join(artifactDir, 'analysis');

        await writeDistributedRunArtifactAnalysis({ artifactDir, outDir, generatedAtEpochMs: GENERATED_AT_EPOCH_MS });

        const analysis = await readAnalysisJson<DistributedRunAnalysis>(outDir);
        expect(analysis.ok).toBe(true);
        expect(analysis).not.toHaveProperty('failure');
        expect(analysis).not.toHaveProperty('fixProposalMarkdown');
        await expect(access(path.join(outDir, 'fix-proposal.md'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(analysis.performance?.diagnosticCount).toBe(1);
        expect(analysis.performance?.warningDiagnosticCount).toBe(1);
        expect(analysis.performance?.errorDiagnosticCount).toBe(0);
        expect(analysis.performance?.commandTiming.p99Ms).toBe(400);
        expect(analysis.performance?.commandTiming.outlierCount).toBe(1);
        const performance = await readFile(path.join(outDir, 'performance.md'), 'utf8');
        expect(performance).toContain('p99=400ms');
        expect(performance).toContain('Warning diagnostics: 1');
        expect(performance).toContain('Error diagnostics: 0');
    });

    it('names group-assertion failures with their own category and fix area', async () => {
        const artifactDir = await createArtifactDirectory(
            'rallar-distributed-ga-artifacts-',
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-ga',
                    controlRunId: 'run-ga',
                    state: 'failed',
                    agentIds: ['agent-a', 'agent-b'],
                    startedAtEpochMs: 1,
                    completedAtEpochMs: 5,
                    summary: { failedGroupAssertions: 1 },
                    failures: [{
                        kind: 'group-assertion',
                        key: 'members-converge',
                        state: 'failed',
                        required: true,
                        error: {
                            code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
                            message: 'Group assertion members-converge failed: 2 distinct values across 2 participants.',
                            details: {
                                aggregate: 'allEqual',
                                violatingAgentIds: ['agent-b'],
                                perAgent: [
                                    { agentId: 'agent-a', evidence: 'resolved', verdict: 'agreeing', value: 2 },
                                    { agentId: 'agent-b', evidence: 'resolved', verdict: 'violating', value: 3 }
                                ]
                            }
                        }
                    }]
                }),
                controlRun: createControlRunSnapshot({ runId: 'run-ga' })
            })
        );
        const outDir = path.join(artifactDir, 'analysis');

        await writeDistributedRunArtifactAnalysis({ artifactDir, outDir, generatedAtEpochMs: GENERATED_AT_EPOCH_MS });

        const analysis = await readAnalysisJson<DistributedRunFailedAnalysis>(outDir);
        expect(analysis.failure.category).toBe('group-assertion');
        expect(analysis.failure.minimalFixArea).toBe('group assertion contract or fleet evidence');
        await expect(readFile(path.join(outDir, 'fix-proposal.md'), 'utf8')).resolves.toContain(
            'rallar-bb-test-group-assertion-conformance.test.ts'
        );
    });

    it('analyzes a runner folder without control-run.json and omits only the performance it cannot measure', async () => {
        const distributedRun = createDistributedRunSnapshot({
            distributedRunId: 'dist-cli-no-control-run',
            controlRunId: 'run-cli-no-control-run',
            state: 'passed',
            agentIds: ['agent-a', 'agent-b'],
            startedAtEpochMs: 100,
            completedAtEpochMs: 900
        });
        const artifactDir = await createArtifactDirectory('rallar-distributed-no-control-run-', {
            'manifest.json': JSON.stringify(distributedRun.manifest),
            'distributed-run.json': JSON.stringify(distributedRun),
            'runner-summary.json': JSON.stringify({
                distributedRunId: 'dist-cli-no-control-run',
                controlRunId: 'run-cli-no-control-run',
                state: 'passed',
                ok: true,
                artifactDir: '/artifacts/dist-cli-no-control-run'
            })
        });
        const outDir = path.join(artifactDir, 'analysis');

        const analyzed = await writeDistributedRunArtifactAnalysis({
            artifactDir,
            outDir,
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(analyzed.left).toBeUndefined();
        const analysis = await readAnalysisJson<DistributedRunAnalysis>(outDir);
        expect(analysis).toMatchObject({
            distributedRunId: 'dist-cli-no-control-run',
            controlRunId: 'run-cli-no-control-run',
            status: 'passed',
            ok: true,
            summary: { passRate: 1, failureGroups: 0, blockingFailures: 0 },
            spa: { report: expect.any(Object), verdict: expect.any(Object) }
        });
        expect(analysis).not.toHaveProperty('performance');
        expect(analysis).not.toHaveProperty('performanceMarkdown');
        expect(analysis.summary).not.toHaveProperty('agents');
        expect(analysis.parseWarnings).toEqual([
            {
                fileName: 'control-run.json',
                message: 'control-run.json is missing or empty, so the artifacts hold no control run snapshot.'
            },
            {
                fileName: 'control-run.json',
                message: 'control-run.json is required to form a distributed-run artifact bundle.'
            }
        ]);
        const summary = await readFile(path.join(outDir, 'summary.md'), 'utf8');
        expect(summary).toContain('Agents: unknown');
        expect(summary).toContain(
            'Performance: not analyzed, because it needs the control run snapshot that control-run.json records.'
        );
        await expect(access(path.join(outDir, 'performance.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('writes a control request failure summary and fix proposal without a performance report', async () => {
        const artifactDir = await createArtifactDirectory('rallar-distributed-post-failure-', {
            'runner-summary.json': JSON.stringify({
                distributedRunId: 'dist-cli-post-failure',
                controlRunId: 'run-cli-post-failure',
                state: 'failed',
                ok: false,
                artifactDir: '/artifacts/dist-cli-post-failure'
            }),
            'control-post-create-error.json': '{"error":"bad manifest","message":"target policy rejected"}',
            'control-post-error-metadata.json': JSON.stringify({
                phase: 'create',
                method: 'POST',
                path: '/distributed-runs',
                httpStatus: '400',
                curlStatus: 0,
                exitStatus: 22,
                responseFile: 'control-post-create-error.json',
                atEpochSeconds: 1_700_000_000
            })
        });
        const outDir = path.join(artifactDir, 'analysis');

        const analyzed = await writeDistributedRunArtifactAnalysis({
            artifactDir,
            outDir,
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        const analysis = await readAnalysisJson<DistributedRunControlRequestFailureAnalysis>(outDir);
        expect(analyzed.right?.variant).toBe('control-request-failure');
        expect(analysis.failure.likelyCause).toBe('target policy rejected');
        await expect(readFile(path.join(outDir, 'summary.md'), 'utf8')).resolves.toContain(
            'Control Request Failure: dist-cli-post-failure'
        );
        await expect(readFile(path.join(outDir, 'fix-proposal.md'), 'utf8')).resolves.toContain(
            'Evidence: control-post-create-error.json'
        );
        await expect(access(path.join(outDir, 'performance.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('returns the rejection and writes nothing for artifacts without a distributed run or failed request record', async () => {
        const artifactDir = await createArtifactDirectory('rallar-distributed-rejected-', {
            'control-run.json': JSON.stringify(createControlRunSnapshot({ runId: 'run-rejected' }))
        });
        const outDir = path.join(artifactDir, 'analysis');

        const analyzed = await writeDistributedRunArtifactAnalysis({
            artifactDir,
            outDir,
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(analyzed.left?.fileName).toBe('distributed-run.json');
        await expect(access(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
