import { describe, expect, it } from 'vitest';
import { compareDistributedRunTuningPerformance } from '../../../packages/shared-test/rallar-bb-test/distributed-run-tuning-decisions.ts';
import { tuningPerformance } from './recipe-console-tuning-decisions-fixtures.ts';

describe('Recipe Console narrow tuning performance comparison', () => {
    it.each(
        [
            ['command-duration', 'p95', 'ms', 200, 350, 150],
            ['stream-send-duration', 'p95', 'ms', 100, 250, 150],
            ['stream-drift', 'max', 'ms', 20, 120, 100],
            ['stream-cadence', 'achieved-completion', 'hz', 20, 16, -4]
        ] as const
    )('compares %s through its deterministic statistic', (
        timingMetric,
        statistic,
        unit,
        left,
        right,
        delta
    ) => {
        const comparison = compareDistributedRunTuningPerformance({
            timingMetric,
            left: tuningPerformance({
                commandP95Ms: 200,
                stream: {
                    duration: {
                        count: 100,
                        minMs: 20,
                        p50Ms: 50,
                        p95Ms: 100,
                        p99Ms: 120,
                        maxMs: 140,
                        averageMs: 55,
                        spreadRatio: 2,
                        outlierCount: 1
                    },
                    maxStartDriftMs: 20,
                    achievedCompletionHz: 20
                }
            }),
            right: tuningPerformance({
                commandP95Ms: 350,
                stream: {
                    duration: {
                        count: 100,
                        minMs: 30,
                        p50Ms: 100,
                        p95Ms: 250,
                        p99Ms: 300,
                        maxMs: 320,
                        averageMs: 120,
                        spreadRatio: 2.5,
                        outlierCount: 4
                    },
                    maxStartDriftMs: 120,
                    achievedCompletionHz: 16
                }
            })
        });

        expect(comparison).toMatchObject({
            availability: 'complete',
            timingMetric,
            selected: { statistic, unit, left, right, delta }
        });
    });

    it('compares RTC frame cadence drift drop and backpressure evidence together', () => {
        const comparison = compareDistributedRunTuningPerformance({
            timingMetric: 'stream-send-duration',
            left: tuningPerformance({
                stream: {
                    plannedFrames: 200,
                    completedFrames: 195,
                    failedFrames: 5,
                    droppedFrames: 5,
                    inFlightLimitDropCount: 1,
                    backpressureCount: 2,
                    requestedRateHz: 20,
                    achievedCompletionHz: 19.5,
                    maxStartDriftMs: 50,
                    lateFrameCount: 3
                }
            }),
            right: tuningPerformance({
                stream: {
                    plannedFrames: 200,
                    completedFrames: 160,
                    failedFrames: 40,
                    droppedFrames: 40,
                    inFlightLimitDropCount: 9,
                    backpressureCount: 12,
                    requestedRateHz: 20,
                    achievedCompletionHz: 12.5,
                    maxStartDriftMs: 4_000,
                    lateFrameCount: 80
                }
            })
        });

        expect(comparison.rtc).toMatchObject({
            plannedFrames: { left: 200, right: 200, delta: 0 },
            completedFrames: { left: 195, right: 160, delta: -35 },
            failedFrames: { left: 5, right: 40, delta: 35 },
            droppedFrames: { left: 5, right: 40, delta: 35 },
            inFlightLimitDropCount: { left: 1, right: 9, delta: 8 },
            backpressureCount: { left: 2, right: 12, delta: 10 },
            achievedCompletionHz: { left: 19.5, right: 12.5, delta: -7 },
            maxStartDriftMs: { left: 50, right: 4_000, delta: 3_950 },
            lateFrameCount: { left: 3, right: 80, delta: 77 }
        });
    });

    it('returns partial comparison without inventing a missing-side delta', () => {
        const comparison = compareDistributedRunTuningPerformance({
            timingMetric: 'command-duration',
            right: tuningPerformance({ commandP95Ms: 350 })
        });

        expect(comparison.availability).toBe('partial');
        expect(comparison.selected).toMatchObject({ right: 350 });
        expect(comparison.selected.left).toBeUndefined();
        expect(comparison.selected.delta).toBeUndefined();
    });
});
