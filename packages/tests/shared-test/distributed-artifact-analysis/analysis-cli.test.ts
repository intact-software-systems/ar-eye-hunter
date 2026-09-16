import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeDistributedRunArtifactDirectory } from '../../../../apps/rallar-black-box/scripts/analyze-distributed-run-artifacts.ts';

describe('distributed run artifact analysis CLI', () => {
    it('writes CLI analysis files for failed and passed artifact directories', async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), 'rallar-distributed-artifacts-'));
        const outDir = path.join(artifactDir, 'analysis');
        await writeFile(
            path.join(artifactDir, 'distributed-run.json'),
            JSON.stringify({
                distributedRunId: 'dist-cli',
                controlRunId: 'run-cli',
                state: 'failed',
                startedAtEpochMs: 1,
                completedAtEpochMs: 5,
                rollup: {
                    ok: false,
                    failures: [{
                        kind: 'participant',
                        key: 'agent-a',
                        state: 'failed',
                        error: { code: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT', message: 'Missing ACK.' }
                    }],
                    summary: { blockingFailures: 1 }
                },
                manifest: { recipes: [], group: { groupId: 'bb-group' } },
                targetAgentIds: ['agent-a'],
                commandLinks: []
            })
        );
        await writeFile(
            path.join(artifactDir, 'control-run.json'),
            JSON.stringify({
                runId: 'run-cli',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            })
        );

        await analyzeDistributedRunArtifactDirectory(artifactDir, outDir);

        const analysis = JSON.parse(await readFile(path.join(outDir, 'analysis.json'), 'utf8')) as {
            failure?: { minimalFixArea?: string; };
            parseWarnings: unknown[];
        };
        expect(analysis.failure?.minimalFixArea).toBe('headless agent readiness');
        expect(analysis.parseWarnings).toEqual([]);
        await expect(readFile(path.join(outDir, 'summary.md'), 'utf8')).resolves.toContain('dist-cli');
        await expect(readFile(path.join(outDir, 'fix-proposal.md'), 'utf8')).resolves.toContain('Suggested verification');
    });

    it('writes passed-run performance files with percentile and diagnostic severity counts', async () => {
        const artifactDir = await mkdtemp(path.join(tmpdir(), 'rallar-distributed-passed-artifacts-'));
        const outDir = path.join(artifactDir, 'analysis');
        await writeFile(
            path.join(artifactDir, 'distributed-run.json'),
            JSON.stringify({
                distributedRunId: 'dist-cli-passed',
                controlRunId: 'run-cli-passed',
                state: 'passed',
                startedAtEpochMs: 100,
                completedAtEpochMs: 900,
                rollup: { ok: true, failures: [], summary: { blockingFailures: 0 } },
                manifest: { recipes: [], group: { groupId: 'bb-group' } },
                targetAgentIds: ['agent-a', 'agent-b'],
                commandLinks: [
                    { phase: 'start', agentId: 'agent-a', commandId: 'cmd-a', queuedAtEpochMs: 100 },
                    { phase: 'start', agentId: 'agent-b', commandId: 'cmd-b', queuedAtEpochMs: 100 },
                    { phase: 'start', agentId: 'agent-b', commandId: 'cmd-c', queuedAtEpochMs: 100 }
                ]
            })
        );
        await writeFile(
            path.join(artifactDir, 'control-run.json'),
            JSON.stringify({
                runId: 'run-cli-passed',
                agents: [
                    { agentId: 'agent-a', connected: true, reconnectCount: 0, receivedEventCount: 2 },
                    { agentId: 'agent-b', connected: true, reconnectCount: 1, receivedEventCount: 3 }
                ],
                commands: [
                    { envelope: { agentId: 'agent-a', commandId: 'cmd-a', command: { kind: 'health' } }, dispatchedAtEpochMs: 110, completedAtEpochMs: 130 },
                    { envelope: { agentId: 'agent-b', commandId: 'cmd-b', command: { kind: 'health' } }, dispatchedAtEpochMs: 120, completedAtEpochMs: 160 },
                    { envelope: { agentId: 'agent-b', commandId: 'cmd-c', command: { kind: 'health' } }, dispatchedAtEpochMs: 130, completedAtEpochMs: 530 }
                ],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            })
        );
        await writeFile(
            path.join(artifactDir, 'events.jsonl'),
            [
                JSON.stringify({ kind: 'runtime', value: { severity: 'info', message: 'loaded' } }),
                JSON.stringify({ kind: 'runtime', value: { severity: 'warning', message: 'slow route' } })
            ].join('\n')
        );

        await analyzeDistributedRunArtifactDirectory(artifactDir, outDir);

        const analysis = JSON.parse(await readFile(path.join(outDir, 'analysis.json'), 'utf8')) as {
            performance?: {
                diagnosticCount: number;
                warningDiagnosticCount: number;
                errorDiagnosticCount: number;
                commandTiming: {
                    p99Ms?: number;
                    outlierCount?: number;
                };
            };
        };
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
        const artifactDir = await mkdtemp(path.join(tmpdir(), 'rallar-distributed-ga-artifacts-'));
        const outDir = path.join(artifactDir, 'analysis');
        await writeFile(
            path.join(artifactDir, 'distributed-run.json'),
            JSON.stringify({
                distributedRunId: 'dist-ga',
                controlRunId: 'run-ga',
                state: 'failed',
                startedAtEpochMs: 1,
                completedAtEpochMs: 5,
                rollup: {
                    ok: false,
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
                    }],
                    summary: { blockingFailures: 1, failedGroupAssertions: 1 }
                },
                manifest: { recipes: [], group: { groupId: 'bb-group' } },
                targetAgentIds: ['agent-a', 'agent-b'],
                commandLinks: []
            })
        );
        await writeFile(
            path.join(artifactDir, 'control-run.json'),
            JSON.stringify({
                runId: 'run-ga',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            })
        );

        await analyzeDistributedRunArtifactDirectory(artifactDir, outDir);

        const analysis = JSON.parse(await readFile(path.join(outDir, 'analysis.json'), 'utf8')) as {
            failure?: { category?: string; minimalFixArea?: string; };
        };
        expect(analysis.failure?.category).toBe('group-assertion');
        expect(analysis.failure?.minimalFixArea).toBe('group assertion contract or fleet evidence');
        await expect(readFile(path.join(outDir, 'fix-proposal.md'), 'utf8')).resolves.toContain(
            'rallar-bb-test-group-assertion-conformance.test.ts'
        );
    });
});
