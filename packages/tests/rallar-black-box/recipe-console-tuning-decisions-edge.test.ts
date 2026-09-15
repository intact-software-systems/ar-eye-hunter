import { describe, expect, it } from 'vitest';
import { deriveDistributedRunTuningDecisions } from '../../../packages/shared-test/rallar-bb-test/distributed-run-tuning-decisions.ts';
import {
    failure,
    streamCommand,
    targetResolution,
    tuningAnalysis,
    tuningInventory,
    tuningManifest,
    tuningPerformance
} from './recipe-console-tuning-decisions-fixtures.ts';

describe('Recipe Console tuning decision limitations', () => {
    it('returns an explicit insufficient state without performance evidence', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({ targetResolution: targetResolution() }),
            inventory: tuningInventory()
        });

        expect(result).toMatchObject({
            state: 'insufficient',
            hints: [{ kind: 'insufficient-evidence', category: 'evidence-quality' }],
            issues: [{ code: 'no-performance-evidence' }]
        });
    });

    it('treats an empty performance envelope as insufficient evidence', () => {
        const performance = {
            ...tuningPerformance({ stream: false, slowestAgents: [] }),
            commandTiming: { count: 0, outlierCount: 0 }
        };
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                ok: true,
                performance,
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory()
        });

        expect(result).toMatchObject({
            state: 'insufficient',
            hints: [{ kind: 'insufficient-evidence' }],
            issues: [{ code: 'no-performance-evidence' }]
        });
    });

    it('suppresses prescriptive hints for explicitly partial evidence', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance({ stream: { droppedFrames: 50 } }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory(),
            completeness: 'partial'
        });

        expect(result.state).toBe('insufficient');
        expect(result.hints.map((hint) => hint.kind)).toEqual(['insufficient-evidence']);
        expect(result.issues).toContainEqual(expect.objectContaining({
            code: 'partial-evidence'
        }));
    });

    it('keeps a reference-only recipe visible but pointer-free', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance({ stream: { droppedFrames: 20 } }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory(tuningManifest({ referenceOnly: true }))
        });

        expect(result.state).toBe('ambiguous');
        expect(result.issues).toContainEqual(expect.objectContaining({
            code: 'reference-only-recipe'
        }));
        expect(result.hints.find((hint) => hint.kind === 'lower-cadence')?.knob)
            .toBeUndefined();
    });

    it('reports a clean run without manufacturing a tuning change', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                ok: true,
                performance: tuningPerformance(),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory()
        });

        expect(result.state).toBe('clean');
        expect(result.hints).toEqual([]);
        expect(result.issues).toEqual([]);
    });

    it('suppresses an exact knob for multiple stream command paths', () => {
        const manifest = tuningManifest({
            commands: [
                streamCommand({ commandId: 'stream-a' }),
                streamCommand({ commandId: 'stream-b' })
            ]
        });
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance({
                    stream: { streamCount: 2, droppedFrames: 30 }
                }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory(manifest)
        });

        const cadence = result.hints.find((hint) => hint.kind === 'lower-cadence');
        expect(result.state).toBe('ambiguous');
        expect(cadence?.knob).toBeUndefined();
        expect(cadence?.candidatePointers).toHaveLength(2);
        expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
            'multiple-streams',
            'pointer-ambiguity'
        ]));
    });

    it('reports duplicate command identity separately from pointer ambiguity', () => {
        const duplicate = streamCommand({ commandId: 'duplicate-stream' });
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance({
                    stream: { streamCount: 2, backpressureCount: 4 }
                }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory(tuningManifest({ commands: [duplicate, duplicate] }))
        });

        expect(result.hints.find((hint) => hint.kind === 'lower-cadence')?.knob)
            .toBeUndefined();
        expect(result.issues.map((issue) => issue.code)).toContain('duplicate-command-id');
    });

    it('returns each effective cadence path for mixed multi-stream pacing', () => {
        const manifest = tuningManifest({
            commands: [
                streamCommand({ commandId: 'interval-stream', intervalMs: 50 }),
                streamCommand({ commandId: 'rate-stream', rateHz: 20 })
            ]
        });
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance({
                    stream: { streamCount: 2, droppedFrames: 12 }
                }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory(manifest)
        });

        const cadence = result.hints.find((hint) => hint.kind === 'lower-cadence');
        expect(cadence?.knob).toBeUndefined();
        expect(cadence?.candidatePointers).toEqual([
            '/recipes/0/recipe/commands/0/intervalMs',
            '/recipes/0/recipe/commands/1/rateHz'
        ]);
    });

    it('does not call equal slow agents an isolated outlier', () => {
        const equal = [
            { agentId: 'agent-a', commandCount: 1, averageMs: 500, maxMs: 1_000 },
            { agentId: 'agent-b', commandCount: 1, averageMs: 500, maxMs: 1_000 }
        ];
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance({ slowestAgents: equal }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory()
        });

        expect(result.hints.some((hint) => hint.kind === 'investigate-agent')).toBe(false);
        expect(result.issues.map((issue) => issue.code)).toContain('equal-slow-agents');
    });

    it('keeps priority and evidence ordering deterministic', () => {
        const input = {
            analysis: tuningAnalysis({
                failure: failure('rtc-stream-performance', 'Stream threshold failed.'),
                performance: tuningPerformance({
                    stream: {
                        droppedFrames: 4,
                        backpressureCount: 3,
                        duration: {
                            count: 200,
                            minMs: 20,
                            p50Ms: 80,
                            p95Ms: 350,
                            p99Ms: 400,
                            maxMs: 450,
                            averageMs: 90,
                            spreadRatio: 4.38,
                            outlierCount: 5
                        }
                    }
                }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory()
        } as const;

        const first = deriveDistributedRunTuningDecisions(input);
        const second = deriveDistributedRunTuningDecisions(input);

        expect(second).toEqual(first);
        expect(first.hints.map((hint) => hint.kind)).toEqual([
            'lower-cadence',
            'adjust-stream-threshold',
            'investigate-agent'
        ]);
        expect(first.hints.map((hint) => hint.priority)).toEqual([20, 30, 40]);
    });
});
