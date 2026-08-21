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

describe('Recipe Console tuning decision safety', () => {
    it('requires target-resolution evidence before timeout advice', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                failure: failure('readiness', 'Agent ACK timed out after ackTimeoutMs.'),
                performance: tuningPerformance({ stream: false })
            }),
            inventory: tuningInventory()
        });

        expect(result.hints.map((hint) => hint.kind)).toContain('fix-target-readiness');
        expect(result.hints.map((hint) => hint.kind)).not.toContain('raise-ack-timeout');
        expect(result.hints[0]?.evidence).toContain('Target resolution evidence is unavailable.');
    });

    it('suppresses exact knobs when reference or traversal limitations hide recipe truth', () => {
        const inline = tuningManifest();
        const mixed = {
            ...inline,
            recipes: [...inline.recipes, { recipeId: 'remote-reference' }]
        };
        const truncated = tuningManifest({
            commands: [
                streamCommand(),
                ...Array.from({ length: 2_000 }, (_, index) => ({
                    kind: 'health' as const,
                    commandId: `health-${index}`
                }))
            ]
        });

        for (const manifest of [mixed, truncated]) {
            const result = deriveDistributedRunTuningDecisions({
                analysis: tuningAnalysis({
                    performance: tuningPerformance({ stream: { droppedFrames: 2 } }),
                    targetResolution: targetResolution()
                }),
                inventory: tuningInventory(manifest)
            });
            expect(result.hints.find((hint) => hint.kind === 'lower-cadence')?.knob)
                .toBeUndefined();
            expect(result.issues.length).toBeGreaterThan(0);
        }
    });

    it('does not compare aggregate multi-execution counters to one stream threshold', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                failure: failure('rtc-stream-performance', 'Stream threshold failed.'),
                performance: tuningPerformance({
                    stream: { streamCount: 2, droppedFrames: 6 }
                }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory()
        });

        expect(result.hints.some((hint) =>
            hint.kind === 'adjust-stream-threshold' &&
            hint.knob?.name === 'thresholds.maxDroppedFrames'
        )).toBe(false);
        expect(result.issues).toContainEqual(expect.objectContaining({
            code: 'aggregate-threshold-evidence'
        }));
    });

    it('keeps threshold-free aggregate cadence evidence exact and unambiguous', () => {
        const command = { ...streamCommand(), thresholds: undefined };
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                performance: tuningPerformance({
                    stream: { streamCount: 2, droppedFrames: 6 }
                }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory(tuningManifest({ commands: [command] }))
        });

        expect(result.hints.find((hint) => hint.kind === 'lower-cadence')?.knob)
            .toMatchObject({ pointer: '/recipes/0/recipe/commands/0/rateHz' });
        expect(result.issues.map((issue) => issue.code))
            .not.toContain('aggregate-threshold-evidence');
        expect(result.state).toBe('ready');
    });

    it.each([
        undefined,
        { enabled: false, timeoutMs: 7_500 }
    ])('keeps a missing or disabled barrier non-prescriptive %#', (barrier) => {
        const manifest = barrier === undefined
            ? { ...tuningManifest(), barrier: undefined }
            : tuningManifest({ barrier });
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                failure: failure('barrier', 'Distributed barrier timed out.'),
                performance: tuningPerformance({ stream: false }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory(manifest)
        });

        expect(result.hints.map((hint) => hint.kind)).not.toContain('raise-barrier-timeout');
        expect(result.hints.map((hint) => hint.kind)).not.toContain('investigate-agent');
        expect(result.hints.flatMap((hint) => hint.candidatePointers ?? []))
            .not.toContain('/barrier/timeoutMs');
        expect(result.issues).toContainEqual(expect.objectContaining({
            code: 'blocked-knob'
        }));
    });

    it('does not treat a barrier disconnect as timeout tuning evidence', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                failure: failure('barrier', 'Agent disconnected during barrier.'),
                performance: tuningPerformance({ stream: false, slowestAgents: [] }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory()
        });

        expect(result.hints.map((hint) => hint.kind)).not.toContain('raise-barrier-timeout');
        expect(result.hints.flatMap((hint) => hint.candidatePointers ?? []))
            .not.toContain('/barrier/timeoutMs');
    });

    it('uses stream outlier evidence for an RTC stream failure', () => {
        const result = deriveDistributedRunTuningDecisions({
            analysis: tuningAnalysis({
                failure: failure('rtc-stream-performance', 'Stream latency failed.'),
                performance: tuningPerformance({
                    slowestAgents: [
                        { agentId: 'command-a', commandCount: 2, maxMs: 4_000 },
                        { agentId: 'command-b', commandCount: 2, maxMs: 1_000 }
                    ],
                    stream: {
                        slowestAgents: [
                            {
                                agentId: 'stream-b',
                                streamCount: 1,
                                plannedFrames: 100,
                                completedFrames: 100,
                                maxMs: 5_000
                            },
                            {
                                agentId: 'stream-a',
                                streamCount: 1,
                                plannedFrames: 100,
                                completedFrames: 100,
                                maxMs: 100
                            }
                        ]
                    }
                }),
                targetResolution: targetResolution()
            }),
            inventory: tuningInventory()
        });

        expect(result.hints.find((hint) => hint.kind === 'investigate-agent'))
            .toMatchObject({
                agentId: 'stream-b',
                evidence: ['stream-b max 5000ms vs 100ms']
            });
    });
});
