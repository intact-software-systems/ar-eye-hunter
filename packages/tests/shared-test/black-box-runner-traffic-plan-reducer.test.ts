import { describe, expect, it } from 'vitest';
import { reduceBlackBoxTrafficPlanFailure } from '../../shared-test/black-box-runner/traffic-plan-reducer.ts';

function isJsonRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function step(name: string, sequence?: number): Record<string, unknown> {
    return {
        name,
        type: name.startsWith('wait') ? 'rtc.wait' : 'rtc.send',
        ...(sequence
            ? {
                trafficSequence: sequence,
                trafficOperation: `operation-${sequence}`
            }
            : {})
    };
}

function deterministicExpandedPlan(): Record<string, unknown> {
    const steps = [
        {
            name: 'connectActors',
            type: 'rtc.connect'
        },
        step('send1', 1),
        step('wait1', 1),
        step('send2', 2),
        step('wait2', 2),
        step('send3', 3),
        step('wait3', 3),
        step('send4', 4),
        step('wait4', 4),
        step('send5', 5),
        step('wait5', 5),
        {
            name: 'closeActors',
            type: 'rtc.close'
        }
    ];

    return {
        version: 1,
        schemaVersion: 1,
        seed: 20260601,
        replay: false,
        generator: {
            count: 5
        },
        decisions: [1, 2, 3, 4, 5].map((sequence) => ({
            sequence,
            operation: `operation-${sequence}`,
            operationIndex: sequence
        })),
        steps,
        replayRecipe: {
            execution: {
                trafficPlan: {
                    expandedPlan: {
                        version: 1,
                        seed: 20260601,
                        steps
                    }
                }
            },
            steps
        }
    };
}

describe('black-box traffic-plan reducer', () => {
    it('keeps setup, cleanup, and traffic through the first failing operation', () => {
        const result = reduceBlackBoxTrafficPlanFailure({
            expandedPlan: deterministicExpandedPlan(),
            artifactIndex: {
                firstFailure: {
                    name: 'wait3',
                    status: 'FAILURE',
                    interactionExecutionNumber: 7
                }
            }
        });

        expect(result.plan.kind).toBe('black-box-runner.reduced-plan');
        expect(result.plan.replay).toBe(true);
        expect((result.plan.steps as Array<{ name: string; }>).map((item) => item.name)).toEqual([
            'connectActors',
            'send1',
            'wait1',
            'send2',
            'wait2',
            'send3',
            'wait3',
            'closeActors'
        ]);
        expect((result.plan.decisions as Array<{ sequence: number; }>).map((item) => item.sequence)).toEqual([1, 2, 3]);
        expect(result.summary).toMatchObject({
            strategy: 'truncate-after-first-failure',
            firstFailure: {
                stepName: 'wait3',
                trafficSequence: 3
            },
            original: {
                stepCount: 12,
                decisionCount: 5
            },
            reduced: {
                stepCount: 8,
                decisionCount: 3
            },
            removed: {
                stepCount: 4,
                decisionCount: 2
            }
        });
        const removed = result.summary.removed;
        if (!isJsonRecord(removed)) {
            throw new Error('Reduction summary must expose a removed record.');
        }
        expect(removed.operations).toEqual([
            {
                sequence: 4,
                operation: 'operation-4',
                operationIndex: 4,
                stepCount: 2
            },
            {
                sequence: 5,
                operation: 'operation-5',
                operationIndex: 5,
                stepCount: 2
            }
        ]);
        expect(result.plan.replayRecipe).toMatchObject({
            execution: {
                trafficPlan: {
                    expandedPlan: {
                        seed: 20260601,
                        reduction: {
                            strategy: 'truncate-after-first-failure'
                        }
                    }
                }
            }
        });
    });

    it('can use failures.json evidence when artifact-index is unavailable', () => {
        const result = reduceBlackBoxTrafficPlanFailure({
            expandedPlan: deterministicExpandedPlan(),
            failures: {
                failures: [
                    {
                        name: 'send2',
                        status: 'FAILURE'
                    }
                ]
            }
        });

        expect((result.plan.steps as Array<{ name: string; }>).map((item) => item.name)).toEqual([
            'connectActors',
            'send1',
            'wait1',
            'send2',
            'wait2',
            'closeActors'
        ]);
        expect((result.plan.decisions as Array<{ sequence: number; }>).map((item) => item.sequence)).toEqual([1, 2]);
    });

    it('keeps decisions when legacy expanded-plan steps have no traffic sequence metadata', () => {
        const result = reduceBlackBoxTrafficPlanFailure({
            expandedPlan: {
                seed: 42,
                replay: false,
                decisions: [
                    {
                        sequence: 1,
                        operation: 'legacy'
                    }
                ],
                steps: [
                    {
                        name: 'legacyTrafficStep',
                        type: 'rtc.send'
                    }
                ],
                replayRecipe: {
                    execution: {
                        trafficPlan: {
                            expandedPlan: {
                                seed: 42,
                                steps: [
                                    {
                                        name: 'legacyTrafficStep',
                                        type: 'rtc.send'
                                    }
                                ]
                            }
                        }
                    },
                    steps: [
                        {
                            name: 'legacyTrafficStep',
                            type: 'rtc.send'
                        }
                    ]
                }
            },
            firstFailureName: 'legacyTrafficStep'
        });

        expect(result.summary.removed).toMatchObject({
            stepCount: 0,
            decisionCount: 0
        });
        expect((result.plan.decisions as Array<{ sequence: number; }>).map((item) => item.sequence)).toEqual([1]);
    });

    it('reports actionable errors when first-failure evidence is missing', () => {
        expect(() =>
            reduceBlackBoxTrafficPlanFailure({
                expandedPlan: deterministicExpandedPlan()
            })
        ).toThrow('requires first-failure evidence');
    });
});
