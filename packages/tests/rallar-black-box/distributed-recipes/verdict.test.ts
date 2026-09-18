import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { createRallarBlackBoxRtcRealtimeStabilityRecipe } from '@shared-test/rallar-bb-test/fixtures/rtc-realtime-recipes.ts';
import { describe, expect, it } from 'vitest';
import {
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView
} from '../../../../apps/rallar-black-box/src/distributed-recipes.ts';
import { distributedArtifactBundle, distributedControlRun, distributedRun } from './distributed-run-fixture.ts';

describe('distributed recipes verdict', () => {
    it('derives an evidence-first passed run verdict with warnings', () => {
        const passedRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            state: 'passed',
            rollup: {
                ...distributedRun.rollup,
                state: 'passed',
                ok: true,
                failures: [],
                summary: {
                    ...distributedRun.rollup.summary,
                    passedParticipants: 2,
                    failedParticipants: 0,
                    passedRecipes: 1,
                    failedRecipes: 0,
                    blockingFailures: 0
                }
            }
        };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: passedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun: passedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle,
            snapshotBounds: {
                commands: 4,
                results: 4,
                events: 1
            }
        });
        const verdict = deriveRunVerdictView({
            distributedRun: passedRun,
            monitor,
            report,
            refreshedAtEpochMs: 2_800
        });

        expect(verdict).toMatchObject({
            verdict: 'passed',
            tone: 'warn',
            title: 'Outcome passed; evidence needs review',
            runId: 'dist-1',
            recipeLabel: 'health-only smoke',
            targetCount: 2,
            artifactStatus: 'valid'
        });
        expect(verdict.primaryEvidence.map((entry) => entry.label)).toEqual([
            'Commands',
            'Evidence',
            'Evidence warnings',
            'Slowest',
            'Artifact'
        ]);
        expect(verdict.warningSignals.join(' ')).toContain('Evidence warning: snapshot');
        expect(verdict.successSignals.join(' ')).toContain('3 completed commands');
    });

    it('derives clean pass verdict wording separately from evidence warnings', () => {
        const passedRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            state: 'passed',
            rollup: {
                ...distributedRun.rollup,
                state: 'passed',
                ok: true,
                failures: [],
                summary: {
                    ...distributedRun.rollup.summary,
                    passedParticipants: 2,
                    failedParticipants: 0,
                    passedRecipes: 1,
                    failedRecipes: 0,
                    blockingFailures: 0
                }
            }
        };
        const cleanControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            results: distributedControlRun.results.map((result) =>
                result.commandId === 'start-b' && result.result
                    ? {
                        ...result,
                        ok: true,
                        error: undefined,
                        result: {
                            ...result.result,
                            status: 'ok',
                            ok: true,
                            error: undefined
                        }
                    }
                    : result
            )
        };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: passedRun,
            controlRun: cleanControlRun,
            artifactBundle: distributedArtifactBundle
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun: passedRun,
            controlRun: cleanControlRun,
            artifactBundle: distributedArtifactBundle
        });
        const verdict = deriveRunVerdictView({
            distributedRun: passedRun,
            monitor,
            report
        });

        expect(verdict).toMatchObject({
            verdict: 'passed',
            tone: 'good',
            title: 'Outcome passed'
        });
        expect(verdict.warningSignals).toEqual([]);
        expect(verdict.successSignals.join(' ')).toContain('Artifact bundle is valid');
    });

    it('derives a failed run verdict with a causal trail and linked evidence counts', () => {
        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle
        });
        const verdict = deriveRunVerdictView({
            distributedRun,
            monitor,
            report,
            refreshedAtEpochMs: 2_800
        });

        expect(verdict).toMatchObject({
            verdict: 'failed',
            tone: 'bad',
            title: 'Outcome failed',
            likelyCause: 'No received payload.',
            nextAction: expect.stringContaining('Open command start-b')
        });
        expect(verdict.causalTrail.map((entry) => entry.kind)).toEqual([
            'failure-category',
            'command-result',
            'diagnostic',
            'artifact',
            'events'
        ]);
        expect(verdict.causalTrail[1]).toMatchObject({
            commandId: 'start-b',
            agentId: 'agent-b',
            recipeId: 'health-only',
            targetKind: 'command',
            targetId: 'start-b',
            actionLabel: 'Open command start-b'
        });
        expect(verdict.causalTrail[2]).toMatchObject({
            targetKind: 'diagnostic',
            actionLabel: expect.stringContaining('Filter diagnostics')
        });
        expect(verdict.causalTrail[3]).toMatchObject({
            targetKind: 'artifact',
            targetId: 'valid',
            actionLabel: 'Inspect artifact evidence'
        });
        expect(verdict.primaryEvidence.map((entry) => [entry.label, entry.value])).toContainEqual([
            'Linked evidence',
            '1 failure / 0 diagnostics / 1 event'
        ]);
    });

    it('adds stream-performance causal trail evidence for RTC stream threshold failures', () => {
        const streamRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            manifest: {
                ...distributedRun.manifest,
                recipes: [{
                    recipeId: 'rtc-realtime-stability',
                    recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
                        readyPeerCount: 1
                    }),
                    profile: 'rtc',
                    variables: {}
                }]
            },
            commandLinks: [
                {
                    phase: 'start',
                    agentId: 'agent-a',
                    commandId: 'rtc-realtime-position-stream',
                    recipeId: 'rtc-realtime-stability',
                    queuedAtEpochMs: 1_510
                }
            ],
            rollup: {
                ...distributedRun.rollup,
                failures: [{
                    kind: 'recipe',
                    key: 'rtc-realtime-stability',
                    state: 'failed',
                    error: {
                        code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                        message: 'RTC stream did not satisfy configured thresholds.'
                    }
                }]
            }
        };
        const streamControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            commands: [{
                envelope: {
                    kind: 'command',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-a',
                    commandId: 'rtc-realtime-position-stream',
                    command: {
                        kind: 'rtc.stream',
                        commandId: 'rtc-realtime-position-stream',
                        connection: 'rtcRealtime',
                        roomId: 'bb-group',
                        count: 25,
                        intervalMs: 200,
                        send: { data: { topic: 'room.black-box.rtc-realtime.position' } }
                    }
                },
                queuedAtEpochMs: 1_510,
                dispatchedAtEpochMs: 1_530,
                completedAtEpochMs: 3_000,
                dispatchCount: 1
            }],
            results: [{
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'rtc-realtime-position-stream',
                ok: false,
                error: {
                    code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                    message: 'RTC stream did not satisfy configured thresholds.'
                },
                result: {
                    commandId: 'rtc-realtime-position-stream',
                    kind: 'rtc.stream',
                    status: 'failed',
                    ok: false,
                    startedAtEpochMs: 1_530,
                    endedAtEpochMs: 3_000,
                    durationMs: 1_470,
                    value: {
                        commandId: 'rtc-realtime-position-stream',
                        plannedFrames: 25,
                        scheduledFrames: 25,
                        attemptedFrames: 23,
                        completedFrames: 23,
                        failedFrames: 2,
                        droppedFrames: 2,
                        inFlightLimitDropCount: 1,
                        pacing: {
                            maxStartDriftMs: 620,
                            lateFrameCount: 3
                        },
                        duration: {
                            p50Ms: 35,
                            p95Ms: 140,
                            p99Ms: 180,
                            maxMs: 180
                        },
                        thresholdFailures: [{
                            name: 'maxDroppedFrames',
                            category: 'delivery',
                            threshold: 1,
                            actual: 2,
                            message: 'Dropped frame count was 2, above the configured 1 maximum.'
                        }]
                    },
                    error: {
                        code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                        message: 'RTC stream did not satisfy configured thresholds.'
                    }
                }
            }],
            events: [{
                kind: 'diagnostic',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'rtc-realtime-position-stream',
                eventId: 'stream-failed',
                atEpochMs: 3_000,
                payload: {
                    topic: 'rallar.bb.rtc.stream_failed',
                    severity: 'error',
                    commandId: 'rtc-realtime-position-stream',
                    plannedFrames: 25,
                    completedFrames: 23,
                    droppedFrames: 2,
                    inFlightLimitDropCount: 1,
                    thresholdFailures: [{ name: 'maxDroppedFrames' }]
                }
            }]
        };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: streamRun,
            controlRun: streamControlRun
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun: streamRun,
            controlRun: streamControlRun
        });
        const verdict = deriveRunVerdictView({
            distributedRun: streamRun,
            monitor,
            report
        });

        expect(report.nextActions[0]).toMatchObject({
            category: 'rtc-stream-performance',
            title: 'RTC stream pacing/backlog threshold failed'
        });
        expect(verdict.causalTrail.map((entry) => entry.kind)).toContain('stream-performance');
        expect(verdict.causalTrail.find((entry) => entry.kind === 'stream-performance')).toMatchObject({
            label: 'Stream pacing evidence',
            commandId: 'rtc-realtime-position-stream',
            agentId: 'agent-a',
            targetKind: 'command',
            actionLabel: 'Inspect stream pacing'
        });
        expect(verdict.summary).toContain('rtc-stream-performance');
    });

    it('does not classify generic in-flight command failures as RTC stream performance', () => {
        const apiRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            commandLinks: [{
                phase: 'start',
                agentId: 'agent-a',
                commandId: 'api-submit',
                recipeId: 'health-only',
                queuedAtEpochMs: 1_510
            }],
            rollup: {
                ...distributedRun.rollup,
                failures: [{
                    kind: 'recipe',
                    key: 'health-only',
                    state: 'failed',
                    error: {
                        code: 'HTTP_REQUEST_FAILED',
                        message: 'Request already in-flight for this user.'
                    }
                }]
            }
        };
        const apiControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            commands: [{
                envelope: {
                    kind: 'command',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-a',
                    commandId: 'api-submit',
                    command: {
                        kind: 'http.request',
                        commandId: 'api-submit',
                        request: {
                            method: 'POST',
                            path: '/api/submit'
                        }
                    }
                },
                queuedAtEpochMs: 1_510,
                dispatchedAtEpochMs: 1_530,
                completedAtEpochMs: 1_620,
                dispatchCount: 1
            }],
            results: [{
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'api-submit',
                ok: false,
                error: {
                    code: 'HTTP_REQUEST_FAILED',
                    message: 'Request already in-flight for this user.'
                },
                result: {
                    commandId: 'api-submit',
                    kind: 'http.request',
                    status: 'failed',
                    ok: false,
                    startedAtEpochMs: 1_530,
                    endedAtEpochMs: 1_620,
                    durationMs: 90,
                    error: {
                        code: 'HTTP_REQUEST_FAILED',
                        message: 'Request already in-flight for this user.'
                    }
                }
            }]
        };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: apiRun,
            controlRun: apiControlRun
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun: apiRun,
            controlRun: apiControlRun
        });
        const verdict = deriveRunVerdictView({
            distributedRun: apiRun,
            monitor,
            report
        });

        expect(report.firstFailure?.category).toBe('command');
        expect(report.nextActions[0]).toMatchObject({
            category: 'command',
            title: 'Distributed command failed'
        });
        expect(verdict.causalTrail.map((entry) => entry.kind)).not.toContain('stream-performance');
        expect(verdict.summary).not.toContain('rtc-stream-performance');
    });

    it('calls out missing artifacts in the run verdict', () => {
        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun,
            controlRun: distributedControlRun
        });
        const verdict = deriveRunVerdictView({
            distributedRun,
            monitor,
            report
        });

        expect(verdict.artifactStatus).toBe('not-loaded');
        expect(verdict.warningSignals.join(' ')).toContain('Evidence warning: artifact not loaded');
        expect(verdict.primaryEvidence).toContainEqual(expect.objectContaining({
            label: 'Artifact',
            tone: 'warn'
        }));
    });
});
