import { describe, expect, it } from 'vitest';
import {
    deriveDistributedRunTuningDecisions,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-tuning-decisions.ts';
import {
    failure,
    streamCommand,
    targetResolution,
    tuningAnalysis,
    tuningInventory,
    tuningManifest,
    tuningPerformance,
} from './recipe-console-tuning-decisions-fixtures.ts';

describe('Recipe Console evidence-backed tuning decisions', () => {
    it.each([
        ['missing participants', { missingExpectedParticipants: 1 }],
        ['stale agent', { blockers: 1, staleAgents: 1, blockingAgentIds: ['stale-a'] }],
        ['offline agent', { blockers: 1, offlineAgents: 1, blockingAgentIds: ['offline-a'] }],
        ['wrong group', { blockers: 1, wrongGroupAgents: 1, blockingAgentIds: ['wrong-a'] }],
        ['missing identity', { blockers: 1, agentsWithoutIdentity: 1, blockingAgentIds: ['identity-a'] }],
    ])('prioritizes %s before every numeric tuning hint', (_label, blockers) => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                failure: failure('rtc-stream-performance', 'Stream thresholds failed.'),
                performance: tuningPerformance({
                    stream: {
                        completedFrames: 120,
                        droppedFrames: 80,
                        inFlightLimitDropCount: 10,
                        backpressureCount: 20,
                        achievedCompletionHz: 8,
                        maxStartDriftMs: 5_000,
                    },
                }),
                targetResolution: targetResolution(blockers),
            }),
            inventory: tuningInventory(),
        });

        expect(result.state).toBe('blocked');
        expect(result.hints.map(hint => hint.kind)).toEqual(['fix-target-readiness']);
        expect(result.hints[0]?.category).toBe('target-readiness');
        expect(result.hints[0]?.evidence.join(' ')).toMatch(/\d/);
        expect(result.hints[0]?.knob).toBeUndefined();
    });

    it('recommends the one effective cadence knob from numeric stream pressure', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance({
                    stream: {
                        completedFrames: 140,
                        failedFrames: 60,
                        droppedFrames: 60,
                        inFlightLimitDropCount: 8,
                        backpressureCount: 13,
                        achievedCompletionHz: 9,
                        maxStartDriftMs: 4_200,
                        lateFrameCount: 90,
                    },
                }),
                targetResolution: targetResolution(),
            }),
            inventory: tuningInventory(),
        });

        const cadence = result.hints.find(hint => hint.kind === 'lower-cadence');
        expect(cadence).toMatchObject({
            category: 'rtc-stream-performance',
            knob: {
                name: 'rateHz',
                pointer: '/recipes/0/recipe/commands/0/rateHz',
            },
        });
        expect(cadence?.evidence).toEqual(expect.arrayContaining([
            '60 dropped frames',
            '8 in-flight-limit drops',
            '13 backpressure events',
            '9Hz achieved vs 20Hz requested',
            '4200ms max start drift',
        ]));
        expect(result.hints.some(hint => hint.knob?.name === 'maxInFlight')).toBe(false);
    });

    it('uses intervalMs instead of a shadowed rateHz knob', () => {
        const manifest = tuningManifest({
            commands: [streamCommand({ intervalMs: 50, rateHz: 20 })],
        });
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance({ stream: { droppedFrames: 2 } }),
                targetResolution: targetResolution(),
            }),
            inventory: tuningInventory(manifest),
        });

        expect(result.hints.find(hint => hint.kind === 'lower-cadence')?.knob)
            .toMatchObject({
                name: 'intervalMs',
                pointer: '/recipes/0/recipe/commands/0/intervalMs',
            });
        expect(result.hints.some(hint => hint.knob?.name === 'maxInFlight')).toBe(false);
    });

    it.each([
        ['readiness', 'Agent ACK timed out after ackTimeoutMs.', 'raise-ack-timeout', '/ackTimeoutMs'],
        ['barrier', 'Distributed barrier timed out.', 'raise-barrier-timeout', '/barrier/timeoutMs'],
    ] as const)('links clean %s timeout evidence to its exact knob', (
        category,
        title,
        kind,
        pointer,
    ) => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                failure: failure(category, title),
                performance: tuningPerformance({ stream: false }),
                targetResolution: targetResolution(),
            }),
            inventory: tuningInventory(),
        });

        expect(result.hints.find(hint => hint.kind === kind)).toMatchObject({
            category,
            knob: { pointer },
        });
    });

    it('cites a breached stream threshold and the exact threshold path', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                failure: failure('rtc-stream-performance', 'Send duration threshold failed.'),
                performance: tuningPerformance({
                    stream: {
                        duration: {
                            count: 200,
                            minMs: 20,
                            p50Ms: 100,
                            p95Ms: 350,
                            p99Ms: 420,
                            maxMs: 500,
                            averageMs: 120,
                            spreadRatio: 3.5,
                            outlierCount: 4,
                        },
                    },
                }),
                targetResolution: targetResolution(),
            }),
            inventory: tuningInventory(),
        });

        const threshold = result.hints.find(
            hint => hint.kind === 'adjust-stream-threshold',
        );
        expect(threshold).toMatchObject({
            category: 'rtc-stream-threshold',
            knob: {
                name: 'thresholds.maxP95SendDurationMs',
                pointer: '/recipes/0/recipe/commands/0/thresholds/maxP95SendDurationMs',
            },
        });
        expect(threshold?.evidence).toContain('350ms observed vs 200ms configured');
    });

    it('identifies one isolated slow agent and its unambiguous stream path', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance(),
                targetResolution: targetResolution(),
            }),
            inventory: tuningInventory(),
        });

        expect(result.hints.find(hint => hint.kind === 'investigate-agent'))
            .toMatchObject({
                category: 'agent-outlier',
                agentId: 'agent-a',
                evidencePointer: '/recipes/0/recipe/commands/0/rateHz',
            });
    });
});
