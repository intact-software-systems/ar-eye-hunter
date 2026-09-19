import { describe, expect, it } from 'vitest';

import {
    ANALYSIS_GENERATED_AT_EPOCH_MS,
    computeDistributedRunAnalysis,
    computeFailedDistributedRunAnalysis,
    createControlRunSnapshot,
    createDistributedRunSnapshot,
    toDistributedRunArtifactFiles
} from './distributed-artifact-files-fixture.ts';

describe('distributed run artifact stream performance', () => {
    it('derives stream performance from rtc.stream JSONL result summaries', () => {
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-passed',
                    controlRunId: 'run-stream-passed',
                    state: 'passed',
                    agentIds: ['controller-01', 'controller-02'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 7_000,
                    commandLinks: [
                        { phase: 'start', agentId: 'controller-01', commandId: 'stream-a', queuedAtEpochMs: 1_000 },
                        { phase: 'start', agentId: 'controller-02', commandId: 'stream-b', queuedAtEpochMs: 1_000 }
                    ]
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-passed',
                    agents: [
                        { agentId: 'controller-01', receivedEventCount: 30 },
                        { agentId: 'controller-02', receivedEventCount: 35 }
                    ]
                }),
                files: {
                    'results.jsonl': [
                        JSON.stringify({
                            agentId: 'controller-01',
                            commandId: 'stream-a',
                            action: 'rtc.stream',
                            status: 'OK',
                            ok: true,
                            result: {
                                commandId: 'rtc-realtime-position-stream',
                                transport: 'realtime',
                                plannedFrames: 3,
                                scheduledFrames: 3,
                                attemptedFrames: 3,
                                completedFrames: 3,
                                failedFrames: 0,
                                droppedFrames: 0,
                                backpressureCount: 0,
                                pacing: { lateFrameCount: 0 },
                                requestedRateHz: 20,
                                achievedScheduleHz: 20,
                                achievedCompletionHz: 20,
                                duration: { minMs: 10, p50Ms: 20, p95Ms: 30, p99Ms: 30, maxMs: 30, averageMs: 20 },
                                observations: [
                                    { index: 0, iteration: 1, durationMs: 10, ok: true },
                                    { index: 1, iteration: 2, durationMs: 20, ok: true },
                                    { index: 2, iteration: 3, durationMs: 30, ok: true }
                                ],
                                thresholdFailures: []
                            }
                        }),
                        JSON.stringify({
                            agentId: 'controller-02',
                            commandId: 'stream-b',
                            action: 'rtc.stream',
                            status: 'OK',
                            ok: true,
                            result: {
                                commandId: 'rtc-realtime-position-stream',
                                transport: 'realtime',
                                plannedFrames: 2,
                                scheduledFrames: 2,
                                attemptedFrames: 2,
                                completedFrames: 2,
                                failedFrames: 0,
                                droppedFrames: 0,
                                backpressureCount: 1,
                                pacing: { lateFrameCount: 0 },
                                requestedRateHz: 20,
                                achievedScheduleHz: 18,
                                achievedCompletionHz: 18,
                                duration: { minMs: 40, p50Ms: 40, p95Ms: 50, p99Ms: 50, maxMs: 50, averageMs: 45 },
                                observations: [
                                    { index: 0, iteration: 1, durationMs: 40, ok: true, backpressured: true },
                                    { index: 1, iteration: 2, durationMs: 50, ok: true }
                                ],
                                thresholdFailures: []
                            }
                        })
                    ].join('\n'),
                    'events.jsonl': ''
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 2,
            plannedFrames: 5,
            scheduledFrames: 5,
            attemptedFrames: 5,
            completedFrames: 5,
            failedFrames: 0,
            droppedFrames: 0,
            backpressureCount: 1,
            sendSuccessRatio: 1,
            duration: {
                count: 5,
                minMs: 10,
                p50Ms: 30,
                p95Ms: 50,
                p99Ms: 50,
                maxMs: 50,
                averageMs: 30,
                outlierCount: 1
            }
        });
        expect(analysis.performance?.streamTiming?.slowestAgents[0]).toMatchObject({
            agentId: 'controller-02',
            streamCount: 1,
            completedFrames: 2,
            maxMs: 50
        });
        expect(analysis.performanceMarkdown).toContain('Stream timing: streams=2, frames=5/5');
        expect(analysis.performanceMarkdown).toContain('p99=50ms');
    });

    it('counts only observations that record a dropped frame as dropped', () => {
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-dropped-flag',
                    controlRunId: 'run-stream-dropped-flag',
                    state: 'passed',
                    agentIds: ['controller-01']
                }),
                controlRun: createControlRunSnapshot({ runId: 'run-stream-dropped-flag' }),
                files: {
                    'results.jsonl': JSON.stringify({
                        agentId: 'controller-01',
                        commandId: 'stream-a',
                        status: 'OK',
                        ok: true,
                        result: {
                            commandId: 'stream-a',
                            plannedFrames: 4,
                            scheduledFrames: 4,
                            attemptedFrames: 4,
                            completedFrames: 3,
                            failedFrames: 0,
                            droppedFrames: 1,
                            backpressureCount: 0,
                            pacing: { lateFrameCount: 0 },
                            duration: {},
                            observations: [
                                { index: 0, durationMs: 10, ok: true, dropped: false },
                                { index: 1, durationMs: 20, ok: true, dropped: 'false' },
                                { index: 2, durationMs: 30, ok: true },
                                { index: 3, durationMs: 90, ok: false, dropped: true },
                                'not an observation'
                            ],
                            thresholdFailures: []
                        }
                    })
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.performance?.streamTiming?.duration).toMatchObject({
            count: 3,
            minMs: 10,
            maxMs: 30
        });
    });

    it('repeats a single stream duration record without inventing its sample or outlier counts', () => {
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-duration-record',
                    controlRunId: 'run-stream-duration-record',
                    state: 'passed',
                    agentIds: ['controller-01']
                }),
                controlRun: createControlRunSnapshot({ runId: 'run-stream-duration-record' }),
                files: {
                    'results.jsonl': JSON.stringify({
                        agentId: 'controller-01',
                        commandId: 'stream-a',
                        status: 'OK',
                        ok: true,
                        result: {
                            commandId: 'stream-a',
                            plannedFrames: 2,
                            scheduledFrames: 2,
                            attemptedFrames: 2,
                            completedFrames: 2,
                            failedFrames: 0,
                            droppedFrames: 0,
                            inFlightLimitDropCount: 0,
                            backpressureCount: 0,
                            pacing: { lateFrameCount: 0 },
                            duration: { p50Ms: 40, p95Ms: 50, maxMs: 50 },
                            observations: [],
                            thresholdFailures: []
                        }
                    })
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.performance?.streamTiming?.duration).toEqual({
            p50Ms: 40,
            p95Ms: 50,
            maxMs: 50,
            spreadRatio: 1.25
        });
    });

    it('suppresses stream timing when another agent has only progress evidence', () => {
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-mixed-evidence',
                    controlRunId: 'run-stream-mixed-evidence',
                    state: 'passed',
                    agentIds: ['controller-01', 'controller-02']
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-mixed-evidence',
                    agents: [
                        { agentId: 'controller-01' },
                        { agentId: 'controller-02' }
                    ]
                }),
                files: {
                    'results.jsonl': [
                        JSON.stringify({
                            resultKey: 'controller-01:stream-complete',
                            agentId: 'controller-01',
                            commandId: 'stream-command',
                            action: 'rtc.stream',
                            ok: true,
                            result: {
                                commandId: 'rtc-realtime-position-stream',
                                plannedFrames: 3,
                                scheduledFrames: 3,
                                attemptedFrames: 3,
                                completedFrames: 3,
                                failedFrames: 0,
                                droppedFrames: 0,
                                inFlightLimitDropCount: 0,
                                backpressureCount: 0,
                                pacing: { lateFrameCount: 0 }
                            }
                        })
                    ].join('\n'),
                    'events.jsonl': JSON.stringify({
                        kind: 'diagnostic',
                        topic: 'rallar.bb.rtc.stream_progress',
                        severity: 'info',
                        agentId: 'controller-02',
                        commandId: 'rtc-realtime-position-stream',
                        payload: {
                            topic: 'rallar.bb.rtc.stream_progress',
                            severity: 'info',
                            data: {
                                plannedFrames: 3,
                                scheduledFrames: 2,
                                completedFrames: 2,
                                failedFrames: 0,
                                droppedFrames: 0,
                                inFlightFrames: 0
                            }
                        }
                    })
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        // The events.jsonl rows are not control event envelopes, so each one is named as a row that cannot stand in for one.
        expect(analysis.parseWarnings).toEqual([
            {
                fileName: 'events.jsonl',
                lineNumber: 1,
                message: 'events.jsonl:1 cannot stand in for a control event: atEpochMs must be a finite number.'
            }
        ]);
        expect(analysis.performance).toBeDefined();
        expect(analysis.performance?.streamTiming).toBeUndefined();
    });

    it('leaves stream timing unknown when a terminal summary does not record every frame counter', () => {
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-unrecorded-counters',
                    controlRunId: 'run-stream-unrecorded-counters',
                    state: 'passed',
                    agentIds: ['controller-01']
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-unrecorded-counters',
                    agents: [{ agentId: 'controller-01' }]
                }),
                files: {
                    'results.jsonl': JSON.stringify({
                        resultKey: 'controller-01:stream-command',
                        agentId: 'controller-01',
                        commandId: 'stream-command',
                        action: 'rtc.stream',
                        ok: true,
                        result: {
                            commandId: 'rtc-realtime-position-stream',
                            plannedFrames: 3,
                            completedFrames: 3,
                            failedFrames: 0,
                            droppedFrames: 0
                        }
                    }),
                    'events.jsonl': ''
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.performance).toBeDefined();
        expect(analysis.performance?.streamTiming).toBeUndefined();
    });

    it('leaves stream timing unknown when a terminal summary records neither in-flight drops nor frame observations', () => {
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-unrecorded-in-flight-drops',
                    controlRunId: 'run-stream-unrecorded-in-flight-drops',
                    state: 'passed',
                    agentIds: ['controller-01']
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-unrecorded-in-flight-drops',
                    agents: [{ agentId: 'controller-01' }]
                }),
                files: {
                    'results.jsonl': JSON.stringify({
                        resultKey: 'controller-01:stream-command',
                        agentId: 'controller-01',
                        commandId: 'stream-command',
                        action: 'rtc.stream',
                        ok: true,
                        result: {
                            commandId: 'rtc-realtime-position-stream',
                            plannedFrames: 3,
                            scheduledFrames: 3,
                            attemptedFrames: 3,
                            completedFrames: 3,
                            failedFrames: 0,
                            droppedFrames: 0,
                            backpressureCount: 0,
                            pacing: { lateFrameCount: 0 }
                        }
                    }),
                    'events.jsonl': ''
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.performance).toBeDefined();
        expect(analysis.performance?.streamTiming).toBeUndefined();
    });

    it('reads a recorded empty observation list as no in-flight drops, so a stream that scheduled no frames keeps run timing', () => {
        const streamResult = (
            commandId: string,
            frames: number,
            recorded: { readonly inFlightLimitDropCount?: number; readonly observations?: readonly object[]; }
        ) => JSON.stringify({
            resultKey: `controller-01:${commandId}`,
            agentId: 'controller-01',
            commandId,
            action: 'rtc.stream',
            ok: true,
            result: {
                commandId: `rtc-${commandId}`,
                plannedFrames: frames,
                scheduledFrames: frames,
                attemptedFrames: frames,
                completedFrames: frames,
                failedFrames: 0,
                droppedFrames: 0,
                backpressureCount: 0,
                pacing: { lateFrameCount: 0 },
                ...recorded
            }
        });
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-empty-observations',
                    controlRunId: 'run-stream-empty-observations',
                    state: 'passed',
                    agentIds: ['controller-01']
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-empty-observations',
                    agents: [{ agentId: 'controller-01' }]
                }),
                files: {
                    'results.jsonl': [
                        streamResult('stream-frames', 3, { inFlightLimitDropCount: 0 }),
                        streamResult('stream-no-frames', 0, { observations: [] })
                    ].join('\n'),
                    'events.jsonl': ''
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 2,
            plannedFrames: 3,
            inFlightLimitDropCount: 0
        });
    });

    it('names only the frame counts a failed stream recorded', () => {
        const analysis = computeFailedDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-failed-unrecorded-counts',
                    controlRunId: 'run-stream-failed-unrecorded-counts',
                    state: 'failed',
                    agentIds: ['controller-01'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 9_000
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-failed-unrecorded-counts',
                    agents: [{ agentId: 'controller-01', receivedEventCount: 1 }]
                }),
                files: {
                    'results.jsonl': '',
                    'events.jsonl': JSON.stringify({
                        kind: 'diagnostic',
                        topic: 'rallar.bb.rtc.stream_failed',
                        severity: 'error',
                        agentId: 'controller-01',
                        commandId: 'rtc-realtime-position-stream',
                        payload: {
                            topic: 'rallar.bb.rtc.stream_failed',
                            severity: 'error',
                            data: {
                                plannedFrames: 100,
                                pacing: { maxStartDriftMs: 900 },
                                thresholdFailures: [{ name: 'maxStartDriftMs', category: 'pacing', threshold: 50, actual: 900 }]
                            }
                        }
                    })
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.failure.category).toBe('rtc-stream-performance');
        expect(analysis.failure.likelyCause).toBe(
            'RTC stream rtc-realtime-position-stream exceeded pacing/backlog thresholds: max drift 900ms.'
        );
    });

    it('does not report zero completed frames for a stopped stream that recorded no completed count', () => {
        const analysis = computeFailedDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-timeout-unrecorded-count',
                    controlRunId: 'run-stream-timeout-unrecorded-count',
                    state: 'timed-out',
                    agentIds: ['controller-01'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 61_000
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-timeout-unrecorded-count',
                    agents: [{ agentId: 'controller-01', receivedEventCount: 1 }]
                }),
                files: {
                    'results.jsonl': '',
                    'events.jsonl': JSON.stringify({
                        kind: 'diagnostic',
                        topic: 'rallar.bb.rtc.stream_progress',
                        severity: 'info',
                        agentId: 'controller-01',
                        commandId: 'rtc-realtime-position-stream',
                        payload: {
                            topic: 'rallar.bb.rtc.stream_progress',
                            severity: 'info',
                            data: { plannedFrames: 100, scheduledFrames: 40 }
                        }
                    })
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.failure).toMatchObject({
            category: 'rtc-stream',
            likelyCause: 'RTC stream rtc-realtime-position-stream reported no completed frame count before the run stopped.'
        });
    });

    it('uses the latest stream event when result JSONL is bounded', () => {
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-events',
                    controlRunId: 'run-stream-events',
                    state: 'passed',
                    agentIds: ['controller-01'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 7_000
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-events',
                    agents: [
                        { agentId: 'controller-01', receivedEventCount: 3 }
                    ]
                }),
                files: {
                    'results.jsonl': '',
                    'events.jsonl': [
                        JSON.stringify({
                            kind: 'diagnostic',
                            topic: 'rallar.bb.rtc.stream_started',
                            severity: 'info',
                            agentId: 'controller-01',
                            commandId: 'rtc-realtime-position-stream',
                            payload: {
                                topic: 'rallar.bb.rtc.stream_started',
                                severity: 'info',
                                data: { plannedFrames: 100, scheduledFrames: 0, completedFrames: 0 }
                            }
                        }),
                        JSON.stringify({
                            kind: 'diagnostic',
                            topic: 'rallar.bb.rtc.stream_progress',
                            severity: 'info',
                            agentId: 'controller-01',
                            commandId: 'rtc-realtime-position-stream',
                            payload: {
                                topic: 'rallar.bb.rtc.stream_progress',
                                severity: 'info',
                                data: { plannedFrames: 100, scheduledFrames: 80, attemptedFrames: 80, completedFrames: 80 }
                            }
                        }),
                        JSON.stringify({
                            kind: 'diagnostic',
                            topic: 'rallar.bb.rtc.stream_completed',
                            severity: 'info',
                            agentId: 'controller-01',
                            commandId: 'rtc-realtime-position-stream',
                            payload: {
                                topic: 'rallar.bb.rtc.stream_completed',
                                severity: 'info',
                                data: {
                                    plannedFrames: 100,
                                    scheduledFrames: 100,
                                    attemptedFrames: 100,
                                    completedFrames: 100,
                                    failedFrames: 0,
                                    droppedFrames: 0,
                                    inFlightLimitDropCount: 0,
                                    backpressureCount: 0,
                                    pacing: { lateFrameCount: 0 },
                                    duration: { p50Ms: 25, p95Ms: 40, p99Ms: 45, maxMs: 50 }
                                }
                            }
                        })
                    ].join('\n')
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        // The events.jsonl rows are not control event envelopes, so each one is named as a row that cannot stand in for one.
        expect(analysis.parseWarnings).toEqual([
            {
                fileName: 'events.jsonl',
                lineNumber: 1,
                message: 'events.jsonl:1 cannot stand in for a control event: atEpochMs must be a finite number.'
            },
            {
                fileName: 'events.jsonl',
                lineNumber: 2,
                message: 'events.jsonl:2 cannot stand in for a control event: atEpochMs must be a finite number.'
            },
            {
                fileName: 'events.jsonl',
                lineNumber: 3,
                message: 'events.jsonl:3 cannot stand in for a control event: atEpochMs must be a finite number.'
            }
        ]);
        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 100,
            scheduledFrames: 100,
            attemptedFrames: 100,
            completedFrames: 100,
            duration: {
                p50Ms: 25,
                p95Ms: 40,
                p99Ms: 45,
                maxMs: 50
            }
        });
    });

    it('uses stream progress evidence when timed-out runs have no failed result', () => {
        const analysis = computeFailedDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-timeout',
                    controlRunId: 'run-stream-timeout',
                    state: 'timed-out',
                    agentIds: ['controller-01'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 61_000
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-timeout',
                    agents: [
                        { agentId: 'controller-01', receivedEventCount: 5 }
                    ]
                }),
                files: {
                    'results.jsonl': '',
                    'events.jsonl': [
                        JSON.stringify({
                            kind: 'diagnostic',
                            topic: 'rallar.bb.rtc.stream_started',
                            severity: 'info',
                            agentId: 'controller-01',
                            commandId: 'rtc-realtime-position-stream',
                            payload: {
                                topic: 'rallar.bb.rtc.stream_started',
                                severity: 'info',
                                data: { plannedFrames: 100, scheduledFrames: 0, completedFrames: 0 }
                            }
                        }),
                        JSON.stringify({
                            kind: 'diagnostic',
                            topic: 'rallar.bb.rtc.stream_progress',
                            severity: 'info',
                            agentId: 'controller-01',
                            commandId: 'rtc-realtime-position-stream',
                            payload: {
                                topic: 'rallar.bb.rtc.stream_progress',
                                severity: 'info',
                                data: {
                                    plannedFrames: 100,
                                    scheduledFrames: 100,
                                    attemptedFrames: 100,
                                    completedFrames: 98,
                                    failedFrames: 0,
                                    droppedFrames: 0,
                                    inFlightFrames: 2
                                }
                            }
                        })
                    ].join('\n')
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        // The events.jsonl rows are not control event envelopes, so each one is named as a row that cannot stand in for one.
        expect(analysis.parseWarnings).toEqual([
            {
                fileName: 'events.jsonl',
                lineNumber: 1,
                message: 'events.jsonl:1 cannot stand in for a control event: atEpochMs must be a finite number.'
            },
            {
                fileName: 'events.jsonl',
                lineNumber: 2,
                message: 'events.jsonl:2 cannot stand in for a control event: atEpochMs must be a finite number.'
            }
        ]);
        expect(analysis.failure).toMatchObject({
            category: 'rtc-stream',
            title: 'RTC stream did not finish before the distributed run timed out.',
            likelyCause: 'RTC stream rtc-realtime-position-stream reached 98 of 100 completed frames before the run stopped.',
            commandId: 'rtc-realtime-position-stream',
            evidenceFile: 'events.jsonl',
            minimalFixArea: 'RTC/TURN'
        });
        expect(analysis.fixProposalMarkdown).toContain('RTC stream did not finish');
        expect(analysis.fixProposalMarkdown).not.toContain('no specific failure evidence was exported');
    });

    it('derives stream performance from nested recipe.run JSONL results without double-counting direct samples', () => {
        const controller01Stream = {
            commandId: 'rtc-realtime-position-stream',
            transport: 'realtime',
            plannedFrames: 3,
            scheduledFrames: 3,
            attemptedFrames: 3,
            completedFrames: 3,
            failedFrames: 0,
            droppedFrames: 0,
            backpressureCount: 0,
            pacing: { lateFrameCount: 0 },
            requestedRateHz: 20,
            achievedScheduleHz: 20,
            achievedCompletionHz: 20,
            duration: { minMs: 10, p50Ms: 20, p95Ms: 30, p99Ms: 30, maxMs: 30, averageMs: 20 },
            observations: [
                { index: 0, iteration: 1, durationMs: 10, ok: true },
                { index: 1, iteration: 2, durationMs: 20, ok: true },
                { index: 2, iteration: 3, durationMs: 30, ok: true }
            ],
            thresholdFailures: []
        };
        const controller02Stream = {
            commandId: 'rtc-realtime-position-stream',
            transport: 'realtime',
            plannedFrames: 2,
            scheduledFrames: 2,
            attemptedFrames: 2,
            completedFrames: 2,
            failedFrames: 0,
            droppedFrames: 0,
            backpressureCount: 1,
            pacing: { lateFrameCount: 0 },
            requestedRateHz: 20,
            achievedScheduleHz: 18,
            achievedCompletionHz: 18,
            duration: { minMs: 40, p50Ms: 40, p95Ms: 50, p99Ms: 50, maxMs: 50, averageMs: 45 },
            observations: [
                { index: 0, iteration: 1, durationMs: 40, ok: true, backpressured: true },
                { index: 1, iteration: 2, durationMs: 50, ok: true }
            ],
            thresholdFailures: []
        };
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-nested-stream-passed',
                    controlRunId: 'run-nested-stream-passed',
                    state: 'passed',
                    agentIds: ['controller-01', 'controller-02'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 7_000
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-nested-stream-passed',
                    agents: [
                        { agentId: 'controller-01', receivedEventCount: 30 },
                        { agentId: 'controller-02', receivedEventCount: 35 }
                    ]
                }),
                files: {
                    'results.jsonl': [
                        JSON.stringify({
                            agentId: 'controller-01',
                            commandId: 'distributed-start-controller-01-rtc-realtime',
                            action: 'recipe.run',
                            status: 'SUCCESS',
                            ok: true,
                            actual: {
                                recipeId: 'rtc-realtime',
                                results: [
                                    {
                                        commandId: 'rtc-realtime-position-stream',
                                        kind: 'rtc.stream',
                                        status: 'ok',
                                        ok: true,
                                        durationMs: 300,
                                        value: controller01Stream
                                    }
                                ]
                            }
                        }),
                        JSON.stringify({
                            agentId: 'controller-02',
                            commandId: 'distributed-start-controller-02-rtc-realtime',
                            action: 'recipe.run',
                            status: 'SUCCESS',
                            ok: true,
                            actual: {
                                recipeId: 'rtc-realtime',
                                results: [
                                    {
                                        commandId: 'rtc-realtime-position-stream',
                                        kind: 'rtc.stream',
                                        status: 'ok',
                                        ok: true,
                                        durationMs: 200,
                                        value: controller02Stream
                                    }
                                ]
                            }
                        }),
                        JSON.stringify({
                            agentId: 'controller-02',
                            commandId: 'rtc-realtime-position-stream',
                            action: 'rtc.stream',
                            status: 'SUCCESS',
                            ok: true,
                            actual: controller02Stream
                        })
                    ].join('\n'),
                    'events.jsonl': ''
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 2,
            plannedFrames: 5,
            scheduledFrames: 5,
            attemptedFrames: 5,
            completedFrames: 5,
            failedFrames: 0,
            droppedFrames: 0,
            backpressureCount: 1,
            sendSuccessRatio: 1,
            duration: {
                count: 5,
                minMs: 10,
                p50Ms: 30,
                p95Ms: 50,
                p99Ms: 50,
                maxMs: 50,
                averageMs: 30,
                outlierCount: 1
            }
        });
        expect(analysis.performance?.streamTiming?.slowestAgents.map((agent) => agent.agentId)).toEqual([
            'controller-02',
            'controller-01'
        ]);
    });

    it('counts repeated nested recipe.run stream executions separately', () => {
        const firstStream = {
            commandId: 'rtc-realtime-position-stream',
            transport: 'realtime',
            plannedFrames: 2,
            scheduledFrames: 2,
            attemptedFrames: 2,
            completedFrames: 2,
            failedFrames: 0,
            droppedFrames: 0,
            backpressureCount: 0,
            pacing: { lateFrameCount: 0 },
            requestedRateHz: 10,
            achievedCompletionHz: 10,
            duration: { minMs: 10, p50Ms: 12, p95Ms: 14, p99Ms: 14, maxMs: 14, averageMs: 12 },
            observations: [
                { index: 0, iteration: 1, durationMs: 10, ok: true },
                { index: 1, iteration: 2, durationMs: 14, ok: true }
            ],
            thresholdFailures: []
        };
        const secondStream = {
            commandId: 'rtc-realtime-position-stream',
            transport: 'realtime',
            plannedFrames: 3,
            scheduledFrames: 3,
            attemptedFrames: 3,
            completedFrames: 3,
            failedFrames: 0,
            droppedFrames: 0,
            backpressureCount: 0,
            pacing: { lateFrameCount: 0 },
            requestedRateHz: 10,
            achievedCompletionHz: 10,
            duration: { minMs: 20, p50Ms: 24, p95Ms: 28, p99Ms: 28, maxMs: 28, averageMs: 24 },
            observations: [
                { index: 0, iteration: 1, durationMs: 20, ok: true },
                { index: 1, iteration: 2, durationMs: 24, ok: true },
                { index: 2, iteration: 3, durationMs: 28, ok: true }
            ],
            thresholdFailures: []
        };
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-repeated-nested-streams',
                    controlRunId: 'run-repeated-nested-streams',
                    state: 'passed',
                    agentIds: ['controller-01'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 9_000
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-repeated-nested-streams',
                    agents: [
                        { agentId: 'controller-01', receivedEventCount: 60 }
                    ]
                }),
                files: {
                    'results.jsonl': [
                        JSON.stringify({
                            agentId: 'controller-01',
                            commandId: 'distributed-start-controller-01-rtc-realtime-pass-1',
                            action: 'recipe.run',
                            status: 'SUCCESS',
                            ok: true,
                            actual: {
                                recipeId: 'rtc-realtime',
                                results: [
                                    {
                                        commandId: 'rtc-realtime-position-stream',
                                        kind: 'rtc.stream',
                                        status: 'ok',
                                        ok: true,
                                        value: firstStream
                                    }
                                ]
                            }
                        }),
                        JSON.stringify({
                            agentId: 'controller-01',
                            commandId: 'distributed-start-controller-01-rtc-realtime-pass-2',
                            action: 'recipe.run',
                            status: 'SUCCESS',
                            ok: true,
                            actual: {
                                recipeId: 'rtc-realtime',
                                results: [
                                    {
                                        commandId: 'rtc-realtime-position-stream',
                                        kind: 'rtc.stream',
                                        status: 'ok',
                                        ok: true,
                                        value: secondStream
                                    }
                                ]
                            }
                        })
                    ].join('\n'),
                    'events.jsonl': ''
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 2,
            plannedFrames: 5,
            scheduledFrames: 5,
            attemptedFrames: 5,
            completedFrames: 5,
            droppedFrames: 0,
            duration: {
                count: 5,
                minMs: 10,
                p50Ms: 20,
                p95Ms: 28,
                p99Ms: 28,
                maxMs: 28
            }
        });
        expect(analysis.performance?.streamTiming?.slowestAgents[0]).toMatchObject({
            agentId: 'controller-01',
            streamCount: 2,
            completedFrames: 5,
            maxMs: 28
        });
    });

    it('keeps failed rtc.stream result summaries available for performance analysis', () => {
        const analysis = computeDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-stream-failed',
                    controlRunId: 'run-stream-failed',
                    state: 'failed',
                    agentIds: ['controller-01'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 8_000,
                    failures: [{
                        kind: 'participant',
                        key: 'controller-01',
                        state: 'failed',
                        error: { code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED', message: 'RTC stream did not satisfy configured thresholds.' }
                    }]
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-stream-failed',
                    agents: [
                        { agentId: 'controller-01', reconnectCount: 1, receivedEventCount: 20 }
                    ]
                }),
                files: {
                    'results.jsonl': [
                        JSON.stringify({
                            agentId: 'controller-01',
                            commandId: 'rtc-realtime-position-stream',
                            action: 'rtc.stream',
                            status: 'FAILURE',
                            ok: false,
                            actual: {
                                code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                                message: 'RTC stream did not satisfy configured thresholds.',
                                value: {
                                    commandId: 'rtc-realtime-position-stream',
                                    transport: 'realtime',
                                    plannedFrames: 100,
                                    scheduledFrames: 100,
                                    attemptedFrames: 88,
                                    completedFrames: 88,
                                    failedFrames: 0,
                                    droppedFrames: 12,
                                    backpressureCount: 0,
                                    pacing: { lateFrameCount: 0 },
                                    requestedRateHz: 20,
                                    achievedScheduleHz: 20,
                                    achievedCompletionHz: 17.6,
                                    duration: { minMs: 4, p50Ms: 8, p95Ms: 15, p99Ms: 18, maxMs: 18, averageMs: 9 },
                                    observations: [
                                        { index: 0, iteration: 1, durationMs: 4, ok: true },
                                        { index: 1, iteration: 2, durationMs: 8, ok: true },
                                        { index: 2, iteration: 3, durationMs: 18, ok: true },
                                        { index: 3, iteration: 4, durationMs: 0, ok: false, dropped: true }
                                    ],
                                    thresholdFailures: [
                                        {
                                            name: 'maxDroppedFrames',
                                            category: 'delivery',
                                            threshold: 0,
                                            actual: 12
                                        }
                                    ]
                                }
                            }
                        })
                    ].join('\n'),
                    'events.jsonl': ''
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 100,
            scheduledFrames: 100,
            attemptedFrames: 88,
            completedFrames: 88,
            failedFrames: 0,
            droppedFrames: 12,
            sendSuccessRatio: 1,
            duration: {
                count: 3,
                minMs: 4,
                p50Ms: 8,
                p95Ms: 18,
                p99Ms: 18,
                maxMs: 18
            }
        });
        expect(analysis.performanceMarkdown).toContain('Stream timing: streams=1, frames=88/100');
        expect(analysis.performanceMarkdown).toContain('dropped=12');
    });

    it('does not classify tolerated drops from a successful stream as stream failure', () => {
        const toleratedStream = {
            commandId: 'rtc-realtime-position-stream',
            transport: 'realtime',
            plannedFrames: 50,
            scheduledFrames: 50,
            attemptedFrames: 48,
            completedFrames: 48,
            failedFrames: 0,
            droppedFrames: 2,
            inFlightLimitDropCount: 1,
            backpressureCount: 0,
            pacing: { lateFrameCount: 0 },
            requestedRateHz: 10,
            achievedCompletionHz: 9.6,
            duration: { minMs: 10, p50Ms: 12, p95Ms: 16, p99Ms: 16, maxMs: 16, averageMs: 12.5 },
            observations: [
                { index: 0, iteration: 1, durationMs: 10, ok: true },
                {
                    index: 48,
                    iteration: 49,
                    durationMs: 0,
                    ok: false,
                    dropped: true,
                    errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT'
                }
            ],
            thresholdFailures: []
        };
        const analysis = computeFailedDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-tolerated-stream-drops',
                    controlRunId: 'run-tolerated-stream-drops',
                    state: 'failed',
                    agentIds: ['controller-01'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 8_000
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-tolerated-stream-drops',
                    agents: [
                        { agentId: 'controller-01', receivedEventCount: 50 }
                    ]
                }),
                files: {
                    'results.jsonl': [
                        JSON.stringify({
                            agentId: 'controller-01',
                            commandId: 'rtc-realtime-position-stream',
                            action: 'rtc.stream',
                            status: 'SUCCESS',
                            ok: true,
                            actual: toleratedStream
                        }),
                        JSON.stringify({
                            agentId: 'controller-01',
                            commandId: 'assert-post-stream-state',
                            action: 'assert',
                            status: 'FAILURE',
                            ok: false,
                            actual: {
                                code: 'ASSERT_FAILED',
                                message: 'Expected post-stream state to be visible.'
                            }
                        })
                    ].join('\n'),
                    'events.jsonl': ''
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.failure).toMatchObject({
            category: 'command',
            minimalFixArea: 'recipe assertion',
            commandId: 'assert-post-stream-state',
            evidenceFile: 'results.jsonl'
        });
        expect(analysis.failure.likelyCause).toBe('Expected post-stream state to be visible.');
        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 1,
            completedFrames: 48,
            droppedFrames: 2,
            inFlightLimitDropCount: 1
        });
    });

    it('classifies nested recipe.run stream threshold failures as pacing performance', () => {
        const failedStreamValue = {
            commandId: 'rtc-realtime-position-stream',
            transport: 'realtime',
            plannedFrames: 100,
            scheduledFrames: 100,
            attemptedFrames: 90,
            completedFrames: 90,
            failedFrames: 0,
            droppedFrames: 10,
            backpressureCount: 0,
            requestedRateHz: 20,
            achievedScheduleHz: 20,
            achievedCompletionHz: 18,
            pacing: {
                intervalMs: 50,
                maxStartDriftMs: 2_000,
                lateFrameCount: 12
            },
            duration: { minMs: 10, p50Ms: 20, p95Ms: 40, p99Ms: 45, maxMs: 45, averageMs: 22 },
            observations: [
                { index: 0, iteration: 1, durationMs: 10, ok: true },
                { index: 89, iteration: 90, durationMs: 45, ok: true },
                { index: 90, iteration: 91, durationMs: 0, ok: false, dropped: true }
            ],
            thresholdFailures: [
                {
                    name: 'maxDroppedFrames',
                    category: 'delivery',
                    threshold: 5,
                    actual: 10
                }
            ]
        };
        const analysis = computeFailedDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-nested-stream-failed',
                    controlRunId: 'run-nested-stream-failed',
                    state: 'failed',
                    agentIds: ['controller-02'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 9_000
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-nested-stream-failed',
                    agents: [
                        { agentId: 'controller-02', receivedEventCount: 30 }
                    ]
                }),
                files: {
                    'results.jsonl': JSON.stringify({
                        agentId: 'controller-02',
                        commandId: 'distributed-start-controller-02-rtc-realtime',
                        action: 'recipe.run',
                        status: 'FAILURE',
                        ok: false,
                        actual: {
                            recipeId: 'rtc-realtime',
                            results: [
                                {
                                    commandId: 'rtc-realtime-position-stream',
                                    kind: 'rtc.stream',
                                    status: 'failed',
                                    ok: false,
                                    value: failedStreamValue,
                                    error: {
                                        code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                                        message: 'RTC stream did not satisfy configured thresholds.'
                                    }
                                }
                            ]
                        }
                    }),
                    'events.jsonl': ''
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        expect(analysis.failure).toMatchObject({
            category: 'rtc-stream-performance',
            minimalFixArea: 'RTC stream pacing/performance',
            affectedAgents: ['controller-02'],
            commandId: 'rtc-realtime-position-stream',
            evidenceFile: 'results.jsonl'
        });
        expect(analysis.failure.likelyCause).toContain('completed 90/100 frames');
        expect(analysis.failure.likelyCause).toContain('dropped 10');
        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 100,
            completedFrames: 90,
            droppedFrames: 10
        });
    });

    it('classifies stream threshold failures as pacing performance and keeps sibling stream evidence', () => {
        const failedStreamValue = {
            commandId: 'rtc-realtime-position-stream',
            transport: 'realtime',
            plannedFrames: 100,
            scheduledFrames: 100,
            attemptedFrames: 79,
            completedFrames: 79,
            failedFrames: 21,
            droppedFrames: 21,
            backpressureCount: 0,
            requestedRateHz: 20,
            achievedScheduleHz: 10.45,
            achievedCompletionHz: 8.25,
            pacing: {
                intervalMs: 50,
                maxStartDriftMs: 7_046,
                averageStartDriftMs: 4_255.9,
                maxJitterMs: 7_024,
                lateFrameCount: 98
            },
            duration: { minMs: 530, p50Ms: 1_768, p95Ms: 1_771, p99Ms: 1_772, maxMs: 1_772, averageMs: 1_534.85 },
            observations: [
                { index: 0, iteration: 1, durationMs: 530, ok: true },
                { index: 78, iteration: 79, durationMs: 1_767, ok: true },
                { index: 79, iteration: 80, durationMs: 0, ok: false, dropped: true, errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT' },
                { index: 80, iteration: 81, durationMs: 0, ok: false, dropped: true, errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT' }
            ],
            thresholdFailures: [
                {
                    name: 'maxDroppedFrames',
                    category: 'delivery',
                    threshold: 20,
                    actual: 21
                }
            ]
        };
        const completedStreamValue = {
            commandId: 'rtc-realtime-position-stream',
            transport: 'realtime',
            plannedFrames: 100,
            scheduledFrames: 100,
            attemptedFrames: 84,
            completedFrames: 84,
            failedFrames: 16,
            droppedFrames: 16,
            backpressureCount: 0,
            requestedRateHz: 20,
            achievedScheduleHz: 12,
            achievedCompletionHz: 10,
            pacing: {
                intervalMs: 50,
                maxStartDriftMs: 5_000,
                averageStartDriftMs: 2_500,
                maxJitterMs: 4_000,
                lateFrameCount: 80
            },
            duration: { minMs: 400, p50Ms: 1_500, p95Ms: 1_550, p99Ms: 1_553, maxMs: 1_553, averageMs: 1_307.55 },
            observations: [
                { index: 0, iteration: 1, durationMs: 400, ok: true },
                { index: 83, iteration: 84, durationMs: 1_553, ok: true },
                { index: 84, iteration: 85, durationMs: 0, ok: false, dropped: true, errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT' }
            ],
            thresholdFailures: []
        };
        const analysis = computeFailedDistributedRunAnalysis(
            toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-rtc-stream-performance',
                    controlRunId: 'run-rtc-stream-performance',
                    state: 'failed',
                    agentIds: ['controller-01', 'controller-02'],
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 30_000
                }),
                controlRun: createControlRunSnapshot({
                    runId: 'run-rtc-stream-performance',
                    agents: [
                        { agentId: 'controller-01', receivedEventCount: 230 },
                        { agentId: 'controller-02', receivedEventCount: 234 }
                    ]
                }),
                files: {
                    'results.jsonl': JSON.stringify({
                        agentId: 'controller-02',
                        commandId: 'distributed-start-controller-02-rtc-realtime',
                        action: 'recipe.run',
                        status: 'FAILURE',
                        ok: false,
                        actual: {
                            code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                            message: 'RTC stream did not satisfy configured thresholds.',
                            details: {
                                code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                                details: {
                                    thresholdFailures: failedStreamValue.thresholdFailures,
                                    value: failedStreamValue
                                }
                            }
                        }
                    }),
                    'events.jsonl': [
                        JSON.stringify({
                            kind: 'diagnostic',
                            topic: 'rallar.bb.rtc.stream_completed',
                            severity: 'info',
                            agentId: 'controller-01',
                            commandId: 'rtc-realtime-position-stream',
                            payload: completedStreamValue
                        }),
                        JSON.stringify({
                            kind: 'diagnostic',
                            topic: 'rallar.bb.rtc.stream_failed',
                            severity: 'error',
                            agentId: 'controller-02',
                            commandId: 'rtc-realtime-position-stream',
                            payload: failedStreamValue
                        })
                    ].join('\n')
                }
            }),
            ANALYSIS_GENERATED_AT_EPOCH_MS
        );

        // The events.jsonl rows are not control event envelopes, so each one is named as a row that cannot stand in for one.
        expect(analysis.parseWarnings).toEqual([
            {
                fileName: 'events.jsonl',
                lineNumber: 1,
                message: 'events.jsonl:1 cannot stand in for a control event: atEpochMs must be a finite number.'
            },
            {
                fileName: 'events.jsonl',
                lineNumber: 2,
                message: 'events.jsonl:2 cannot stand in for a control event: atEpochMs must be a finite number.'
            }
        ]);
        expect(analysis.failure).toMatchObject({
            category: 'rtc-stream-performance',
            minimalFixArea: 'RTC stream pacing/performance',
            affectedAgents: ['controller-02'],
            commandId: 'rtc-realtime-position-stream'
        });
        expect(analysis.failure.likelyCause).toContain('completed 79/100 frames');
        expect(analysis.failure.likelyCause).toContain('dropped 21');
        expect(analysis.failure.likelyCause).toContain('in-flight limit drops 2');
        expect(analysis.failure.likelyCause).toContain('max drift 7046ms');
        expect(analysis.performance?.streamTiming).toMatchObject({
            streamCount: 2,
            plannedFrames: 200,
            completedFrames: 163,
            droppedFrames: 37,
            inFlightLimitDropCount: 3,
            maxStartDriftMs: 7_046,
            lateFrameCount: 178
        });
        expect(analysis.performance?.streamTiming?.slowestAgents.map((agent) => agent.agentId)).toEqual([
            'controller-02',
            'controller-01'
        ]);
        expect(analysis.performanceMarkdown).toContain('in-flight drops=3');
        expect(analysis.performanceMarkdown).toContain('max drift=7046ms');
        expect(analysis.performanceMarkdown).toContain(
            'Frame disposition: streams=2, planned=200, completed=163, failed=37, dropped=37, in-flight drops=3'
        );
        expect(analysis.performanceMarkdown).toContain('Slowest stream agents: controller-02');
    });
});
