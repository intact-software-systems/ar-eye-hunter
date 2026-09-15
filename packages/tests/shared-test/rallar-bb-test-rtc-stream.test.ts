import { describe, expect, it } from 'vitest';
import {
    planRallarBlackBoxRtcStreamFrames,
    replaceRallarBlackBoxRtcStreamPlaceholders,
    summarizeRallarBlackBoxRtcStreamObservations
} from '../../shared-test/rallar-bb-test/rtc-stream.ts';

describe('rallar-bb-test rtc stream helpers', () => {
    it('plans count, duration, and rate based frame schedules', () => {
        expect(planRallarBlackBoxRtcStreamFrames({ count: 3, intervalMs: 50 })).toEqual({
            intervalMs: 50,
            requestedRateHz: 20,
            frames: [
                { index: 0, iteration: 1, scheduledElapsedMs: 0 },
                { index: 1, iteration: 2, scheduledElapsedMs: 50 },
                { index: 2, iteration: 3, scheduledElapsedMs: 100 }
            ]
        });

        expect(planRallarBlackBoxRtcStreamFrames({ durationMs: 125, intervalMs: 50 }).frames).toEqual([
            { index: 0, iteration: 1, scheduledElapsedMs: 0 },
            { index: 1, iteration: 2, scheduledElapsedMs: 50 },
            { index: 2, iteration: 3, scheduledElapsedMs: 100 }
        ]);

        const twentyHz = planRallarBlackBoxRtcStreamFrames({ durationMs: 5_000, rateHz: 20 });
        expect(twentyHz.intervalMs).toBe(50);
        expect(twentyHz.requestedRateHz).toBe(20);
        expect(twentyHz.frames).toHaveLength(100);
        expect(twentyHz.frames.at(-1)).toEqual({
            index: 99,
            iteration: 100,
            scheduledElapsedMs: 4_950
        });
    });

    it('replaces stream placeholders inside nested send payloads', () => {
        const resolved = replaceRallarBlackBoxRtcStreamPlaceholders({
            data: {
                commandId: '{stream.commandId}',
                index: '{stream.index}',
                iteration: '{stream.iteration}',
                elapsedMs: '{stream.elapsedMs}',
                scheduledElapsedMs: '{stream.scheduledElapsedMs}',
                label: 'frame-{stream.iteration}-at-{stream.scheduledElapsedMs}'
            }
        }, {
            commandId: 'stream-position',
            index: 4,
            iteration: 5,
            elapsedMs: 213,
            scheduledElapsedMs: 200
        });

        expect(resolved).toEqual({
            data: {
                commandId: 'stream-position',
                index: 4,
                iteration: 5,
                elapsedMs: 213,
                scheduledElapsedMs: 200,
                label: 'frame-5-at-200'
            }
        });
    });

    it('summarizes stream observations with percentiles, pacing, and threshold failures', () => {
        const summary = summarizeRallarBlackBoxRtcStreamObservations({
            commandId: 'stream-position',
            transport: 'realtime',
            startedAtEpochMs: 1_000,
            endedAtEpochMs: 1_320,
            intervalMs: 50,
            requestedRateHz: 20,
            plannedFrames: 5,
            observations: [
                {
                    commandId: 'stream-position:f1',
                    index: 0,
                    iteration: 1,
                    scheduledAtEpochMs: 1_000,
                    startedAtEpochMs: 1_000,
                    completedAtEpochMs: 1_024,
                    startDriftMs: 0,
                    durationMs: 24,
                    ok: true
                },
                {
                    commandId: 'stream-position:f2',
                    index: 1,
                    iteration: 2,
                    scheduledAtEpochMs: 1_050,
                    startedAtEpochMs: 1_055,
                    completedAtEpochMs: 1_085,
                    startDriftMs: 5,
                    durationMs: 30,
                    ok: true
                },
                {
                    commandId: 'stream-position:f3',
                    index: 2,
                    iteration: 3,
                    scheduledAtEpochMs: 1_100,
                    startedAtEpochMs: 1_112,
                    completedAtEpochMs: 1_147,
                    startDriftMs: 12,
                    durationMs: 35,
                    ok: true
                },
                {
                    commandId: 'stream-position:f4',
                    index: 3,
                    iteration: 4,
                    scheduledAtEpochMs: 1_150,
                    startedAtEpochMs: 1_170,
                    completedAtEpochMs: 1_215,
                    startDriftMs: 20,
                    durationMs: 45,
                    ok: true,
                    backpressured: true
                },
                {
                    commandId: 'stream-position:f5',
                    index: 4,
                    iteration: 5,
                    scheduledAtEpochMs: 1_200,
                    startedAtEpochMs: 1_260,
                    completedAtEpochMs: 1_320,
                    startDriftMs: 60,
                    durationMs: 60,
                    ok: false,
                    dropped: true,
                    errorCode: 'STREAM_DROPPED'
                }
            ],
            thresholds: {
                maxP95SendDurationMs: 40,
                maxDroppedFrames: 0
            }
        });

        expect(summary).toMatchObject({
            commandId: 'stream-position',
            transport: 'realtime',
            plannedFrames: 5,
            scheduledFrames: 5,
            attemptedFrames: 4,
            completedFrames: 4,
            failedFrames: 1,
            droppedFrames: 1,
            backpressureCount: 1,
            elapsedMs: 320,
            requestedRateHz: 20,
            achievedScheduleHz: 15.625,
            achievedCompletionHz: 12.5,
            pacing: {
                intervalMs: 50,
                maxStartDriftMs: 60,
                averageStartDriftMs: 19.4,
                maxJitterMs: 40,
                lateFrameCount: 1
            },
            duration: {
                minMs: 24,
                p50Ms: 30,
                p95Ms: 45,
                p99Ms: 45,
                maxMs: 45,
                averageMs: 33.5
            }
        });
        expect(summary.thresholdFailures.map((failure) => failure.name)).toEqual([
            'maxDroppedFrames',
            'maxP95SendDurationMs'
        ]);
    });
});
