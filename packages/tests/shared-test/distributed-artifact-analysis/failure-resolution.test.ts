import { describe, expect, it } from 'vitest';

import {
    computeDistributedRunArtifactAnalysis,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import {
    createControlRunSnapshot,
    createDistributedRunSnapshot,
    createQueuedCommandSnapshot,
    toDistributedRunArtifactFiles
} from './distributed-artifact-files-fixture.ts';

function analyzedRun(files: DistributedRunArtifactFiles): DistributedRunAnalysis {
    const analyzed = computeDistributedRunArtifactAnalysis({ files, generatedAtEpochMs: 123 });
    if (analyzed.right?.variant !== 'distributed-run') {
        throw new Error(`Expected a distributed run analysis, got ${JSON.stringify(analyzed.left ?? analyzed.right)}`);
    }
    return analyzed.right.analysis;
}

describe('distributed run artifact failure resolution', () => {
    it('creates a fix proposal from failed fleet signatures and command evidence', () => {
        const analysis = analyzedRun(toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-failed',
                controlRunId: 'run-failed',
                state: 'failed',
                agentIds: ['controller-01', 'controller-02'],
                startedAtEpochMs: 1_000,
                completedAtEpochMs: 4_000,
                commandLinks: [
                    { phase: 'start', agentId: 'controller-02', commandId: 'send-rtc', queuedAtEpochMs: 1_100 }
                ],
                summary: { passedParticipants: 1, failedParticipants: 1 }
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-failed',
                agents: [
                    { agentId: 'controller-01', receivedEventCount: 2 },
                    { agentId: 'controller-02', reconnectCount: 1, receivedEventCount: 3 }
                ],
                commands: [
                    createQueuedCommandSnapshot({
                        runId: 'run-failed',
                        agentId: 'controller-02',
                        commandId: 'send-rtc',
                        command: { kind: 'rtc.send', transport: 'realtime' },
                        queuedAtEpochMs: 1_100,
                        dispatchedAtEpochMs: 1_150,
                        completedAtEpochMs: 2_400
                    })
                ],
                results: [{
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-failed',
                    agentId: 'controller-02',
                    commandId: 'send-rtc',
                    ok: false,
                    error: { code: 'RTC_NO_ROUTE', message: 'No route to peer.' }
                }]
            }),
            files: {
                'results.jsonl': JSON.stringify({
                    resultKey: 'controller-02:send-rtc',
                    status: 'FAILURE',
                    transport: 'realtime',
                    action: 'rtc.send',
                    agentId: 'controller-02',
                    commandId: 'send-rtc',
                    actual: {
                        code: 'RTC_NO_ROUTE',
                        message: 'No route to peer.'
                    }
                }),
                'events.jsonl': JSON.stringify({
                    kind: 'rtc-diagnostic',
                    status: 'diagnostic',
                    transport: 'realtime',
                    agentId: 'controller-02',
                    commandId: 'send-rtc',
                    value: {
                        diagnosticTypeId: 'rallar.browser.rtc.no_route',
                        severity: 'error',
                        message: 'No RTC route to receiver.'
                    }
                }),
                'failures.json': JSON.stringify({
                    failures: [
                        {
                            agentId: 'controller-02',
                            commandId: 'send-rtc',
                            error: {
                                code: 'RTC_NO_ROUTE',
                                message: 'No route to peer.'
                            }
                        }
                    ]
                }),
                'fleet-report.json': JSON.stringify({
                    distributedRunId: 'dist-failed',
                    state: 'failed',
                    ok: false,
                    summary: {
                        agents: 2,
                        regions: 1,
                        passed: 1,
                        failed: 1,
                        missing: 0,
                        flaky: 0,
                        stale: 0,
                        passRate: 0.5,
                        failureGroups: 1
                    },
                    failureSignatures: [
                        {
                            signatureId: 'diagnostic-rtc-no-route',
                            category: 'diagnostic',
                            title: 'RTC route failure',
                            normalizedMessage: 'no rtc route to receiver',
                            transport: 'realtime',
                            count: 1,
                            affectedAgents: ['controller-02'],
                            affectedRegions: ['eu-north'],
                            affectedRuns: ['dist-failed'],
                            likelyCause: 'Runtime transport diagnostics correlated with the distributed run.',
                            nextAction: 'Inspect RTC lane, peer, group, and topic evidence for affected agents.'
                        }
                    ],
                    timing: {
                        run: { count: 1, p50Ms: 3_000, p95Ms: 3_000, maxMs: 3_000 },
                        commands: { count: 1, p50Ms: 1_250, p95Ms: 1_250, maxMs: 1_250 }
                    }
                })
            }
        }));

        expect(analysis.ok).toBe(false);
        expect(analysis.status).toBe('failed');
        expect(analysis.failure?.category).toBe('diagnostic');
        expect(analysis.failure?.affectedAgents).toEqual(['controller-02']);
        expect(analysis.failure?.minimalFixArea).toBe('RTC/TURN');
        expect(analysis.failure?.verificationCommand).toContain('live-rtc-3');
        expect(analysis.fixProposalMarkdown).toContain('RTC route failure');
        expect(analysis.fixProposalMarkdown).toContain('send-rtc');
        expect(analysis.summaryMarkdown).toContain('dist-failed');
        expect(analysis.spa?.verdict.title).toBe('Outcome failed');
        expect(analysis.spa?.report.nextActions[0]?.category).toBe('command');
    });

    it('falls back to distributed and control artifacts when fleet report is missing', () => {
        const analysis = analyzedRun(toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-no-fleet',
                controlRunId: 'run-no-fleet',
                state: 'timed-out',
                agentIds: ['controller-01', 'controller-03'],
                startedAtEpochMs: 2_000,
                completedAtEpochMs: 12_000,
                failures: [
                    {
                        kind: 'participant',
                        key: 'controller-03',
                        state: 'timed-out',
                        required: true,
                        error: {
                            code: 'ACK_TIMEOUT',
                            message: 'Missing stage ACK before timeout.'
                        }
                    }
                ]
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-no-fleet',
                agents: [
                    { agentId: 'controller-01', receivedEventCount: 1 },
                    { agentId: 'controller-03', connected: false, reconnectCount: 2 }
                ]
            }),
            files: {
                'results.jsonl': '',
                'events.jsonl': '',
                'failures.json': JSON.stringify({ failures: [] })
            }
        }));

        expect(analysis.ok).toBe(false);
        expect(analysis.status).toBe('timed-out');
        expect(analysis.failure?.category).toBe('readiness');
        expect(analysis.failure?.affectedAgents).toEqual(['controller-03']);
        expect(analysis.fixProposalMarkdown).toContain('Agent did not ACK staging');
        expect(analysis.fixProposalMarkdown).toContain('controller-03');
    });

    it('uses payload diagnostic evidence when the fleet report fails a run whose rollup holds no failure evidence', () => {
        const analysis = analyzedRun(toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-payload-diagnostic',
                controlRunId: 'run-payload-diagnostic',
                state: 'passed',
                agentIds: ['agent-a'],
                startedAtEpochMs: 100,
                completedAtEpochMs: 200
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-payload-diagnostic',
                agents: [{ agentId: 'agent-a' }]
            }),
            files: {
                'fleet-report.json': JSON.stringify({ ok: false }),
                'events.jsonl': JSON.stringify({
                    kind: 'diagnostic',
                    transport: 'realtime',
                    agentId: 'agent-a',
                    commandId: 'cmd-payload',
                    payload: {
                        severity: 'error',
                        message: 'Payload-only RTC route diagnostic.'
                    }
                })
            }
        }));

        expect(analysis.ok).toBe(false);
        expect(analysis.failure).toMatchObject({
            category: 'diagnostic',
            title: 'Payload-only RTC route diagnostic.',
            likelyCause: 'Payload-only RTC route diagnostic.',
            affectedAgents: ['agent-a'],
            commandId: 'cmd-payload',
            evidenceFile: 'events.jsonl'
        });
    });
});
