import { describe, expect, it } from 'vitest';

import { executeBlackBox } from '@shared-test/black-box-runner/execute-black-box.ts';
import type { ScenarioRecipe } from '@shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts';

import { readApiV1Matrix, readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

interface AtomicCompletionAssertionStep {
    readonly name?: string;
    readonly expect?: {
        readonly anyOf?: ReadonlyArray<{
            readonly atomicCompletionFailures: number;
            readonly intermediateMutationIntentCount: number;
            readonly completedAppInboxStatus: string;
            readonly naturalBoundedRetryObserved: boolean;
            readonly mutationStatus: string;
        }>;
    };
}

describe('API-v1 medium-scale recipe', () => {
    it('retains the isolated three-service workload and its bounded concurrency and polling budgets', () => {
        // Owner: Rallar shared-test maintainers. These supplementary workload/budget inventories
        // are removed when the executor report exposes expanded lane/client counts and scheduled
        // poll budgets, allowing these acceptance limits to be asserted from runtime results.
        // Settlement behavior itself belongs to api-v1-medium-scale-settlement.test.ts.
        const { entries } = readApiV1Matrix();
        const entry = entries.find((candidate) => candidate.id === 'api-v1-state-medium-scale-churn');
        expect(entry).toMatchObject({
            category: 'api-v1-black-box',
            mode: 'run',
            profiles: ['api-v1-black-box-medium-scale'],
            expectedExitCode: 0
        });
        expect(entry?.requires?.httpServices).toHaveLength(3);
        expect(entry?.requires?.playwright).not.toBe(true);

        const recipe = readApiV1Recipe(entry!.recipe);
        const steps = recipe.steps ?? [];
        const connections = Object.values(recipe.connections as Record<string, { timeoutMs: number; }>);
        expect(connections.map((connection) => connection.timeoutMs)).toEqual([15_000, 15_000, 15_000]);

        const churn = steps.find((step) => step.name === 'runMediumScaleStateChurn');
        expect(churn).toMatchObject({ maxConcurrency: 15, timeoutMs: 300_000 });
        const lanes = churn?.groups as ReadonlyArray<{
            readonly name: string;
            readonly steps: NonNullable<ScenarioRecipe['steps']>;
        }>;
        expect(lanes).toHaveLength(15);
        const clientLanes = lanes.filter((lane) => lane.name.startsWith('client-lane-'));
        const controlLanes = lanes.filter((lane) => lane.name.startsWith('group-control-lane-'));
        expect(clientLanes).toHaveLength(10);
        expect(controlLanes).toHaveLength(5);
        const clientCounts = clientLanes.map((lane) => lane.steps.find((step) => step.type === 'loop')?.count);
        const controlCounts = controlLanes.map((lane) => lane.steps.find((step) => step.type === 'loop')?.count);
        expect(clientCounts).toEqual(Array(10).fill(10));
        expect(clientCounts.reduce<number>((total, count) => total + Number(count), 0)).toBe(100);
        expect(controlCounts).toEqual(Array(5).fill(10));

        expect(steps.find((step) => step.name === 'runBoundedEqualDuplicateWave')).toMatchObject({
            maxConcurrency: 3,
            timeoutMs: 30_000
        });
        expect(steps.find((step) => step.name === 'runBoundedChangedDuplicateWave')).toMatchObject({
            maxConcurrency: 2,
            timeoutMs: 30_000
        });
        const pollDelays = steps.filter((step) => String(step.name).startsWith('delayBeforeConvergencePoll'))
            .map((step) => Number((step.request as { delayMs: number; }).delayMs));
        expect(pollDelays).toEqual([500, 1000, 2000, 4000, 8000]);
        expect(pollDelays.reduce((total, delay) => total + delay, 0)).toBeLessThanOrEqual(30_000);
        const polls = steps.filter((step) => String(step.name).startsWith('pollConvergenceAttempt'));
        expect(polls).toHaveLength(5);
        for (const poll of polls) {
            expect(poll).toMatchObject({ maxConcurrency: 15 });
            expect(poll.groups).toHaveLength(15);
        }
        expect(steps.find((step) => step.name === 'pollFinalTopologyEffects')).toMatchObject({
            count: 5,
            intervalMs: 5_000
        });
    });

    it('accepts a run with no natural retry while preserving exact atomic completion', async () => {
        const { entries } = readApiV1Matrix();
        const entry = entries.find((candidate) => candidate.id === 'api-v1-state-medium-scale-churn');
        const recipe = readApiV1Recipe(entry!.recipe);
        const assertion = (recipe.steps as AtomicCompletionAssertionStep[]).find(
            (step) => step.name === 'assertAtomicAppInboxCompletion'
        );
        const report = await executeBlackBox(
            [
                {
                    ASSERT: {
                        request: {
                            actual: {
                                atomicCompletionFailures: 0,
                                intermediateMutationIntentCount: 0,
                                completedAppInboxStatus: 'COMPLETED',
                                naturalBoundedRetryObserved: false,
                                mutationStatus: 'SUCCESS'
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                            repeatIndex: 1
                        },
                        response: assertion?.expect
                    },
                    assertAtomicAppInboxCompletion: { type: 'assert' }
                }
            ],
            0
        );

        expect(report.summary).toMatchObject({ total: 1, success: 1, failure: 0 });
    });
});
