import { describe, expect, it } from 'vitest';

import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

interface RttRecipeStep {
    readonly name?: string;
}

interface RttRecipeFragment {
    readonly steps?: readonly RttRecipeStep[];
}

interface RttRecipe {
    readonly steps?: readonly RttRecipeStep[];
    readonly fragments?: Readonly<Record<string, RttRecipeFragment>>;
}

describe('API-v1 RTC RTT recipe semantics', () => {
    it('orients every synthetic RTT report from the canonical session', () => {
        const cases = [
            {
                recipePath: 'tests/api-v1/api-v1-group-formation-criterion.json',
                reporterStepName: 'deriveRttReporter',
                resourceStepName: 'deriveRttResource',
                sendStepName: 'reportTheObservedEdge',
                reporterOutput: 'rttReporter',
                firstSessionPath: 'outputs.aliceSessionId',
                secondSessionPath: 'outputs.bobSessionId',
                firstConnection: 'wsAlice',
                secondConnection: 'wsBob'
            },
            {
                recipePath: 'tests/api-v1/api-v1-match-preset.json',
                reporterStepName: 'deriveArenaRttReporter',
                resourceStepName: 'deriveArenaRttResource',
                sendStepName: 'reportTheArenaEdge',
                reporterOutput: 'arenaRttReporter',
                firstSessionPath: 'outputs.carolSessionId',
                secondSessionPath: 'outputs.danSessionId',
                firstConnection: 'wsCarol',
                secondConnection: 'wsDan'
            },
            {
                recipePath: 'tests/api-v1/api-v1-group-formation-managed-burst-medium.json',
                fragmentName: 'report-rtt-pair',
                reporterStepName: 'deriveRtt{i}x{j}Reporter',
                resourceStepName: 'deriveRtt{i}x{j}Resource',
                sendStepName: 'reportRtt{i}x{j}',
                reporterOutput: 'rtt{i}x{j}Reporter',
                firstSessionPath: 'outputs.client{i}SessionId',
                secondSessionPath: 'outputs.client{j}SessionId',
                firstConnection: 'ws-client-{i}',
                secondConnection: 'ws-client-{j}'
            },
            {
                recipePath: 'tests/api-v1/api-v1-group-formation-managed-burst-large.json',
                fragmentName: 'report-rtt-pair',
                reporterStepName: 'deriveRtt{i}x{j}Reporter',
                resourceStepName: 'deriveRtt{i}x{j}Resource',
                sendStepName: 'reportRtt{i}x{j}',
                reporterOutput: 'rtt{i}x{j}Reporter',
                firstSessionPath: 'outputs.client{i}SessionId',
                secondSessionPath: 'outputs.client{j}SessionId',
                firstConnection: 'ws-client-{i}',
                secondConnection: 'ws-client-{j}'
            }
        ] as const;

        for (const testCase of cases) {
            const recipe = readApiV1Recipe(testCase.recipePath) as RttRecipe;
            const steps = 'fragmentName' in testCase
                ? recipe.fragments?.[testCase.fragmentName]?.steps ?? []
                : recipe.steps ?? [];
            const reporterStep = steps.find(
                (step) => step.name === testCase.reporterStepName
            );
            const resourceStep = steps.find(
                (step) => step.name === testCase.resourceStepName
            );
            const sendStep = steps.find(
                (step) => step.name === testCase.sendStepName
            );

            expect(reporterStep, testCase.recipePath).toMatchObject({
                type: 'set',
                output: testCase.reporterOutput,
                transform: {
                    if: {
                        condition: {
                            operator: 'lexicallyBefore',
                            values: [
                                { path: testCase.firstSessionPath },
                                { path: testCase.secondSessionPath }
                            ]
                        },
                        then: {
                            connection: testCase.firstConnection,
                            sessionIdFrom: { path: testCase.firstSessionPath },
                            sessionIdTo: { path: testCase.secondSessionPath }
                        },
                        else: {
                            connection: testCase.secondConnection,
                            sessionIdFrom: { path: testCase.secondSessionPath },
                            sessionIdTo: { path: testCase.firstSessionPath }
                        }
                    }
                }
            });
            expect(resourceStep, testCase.recipePath).toMatchObject({
                type: 'set',
                transform: {
                    concat: expect.arrayContaining([
                        { path: `outputs.${testCase.reporterOutput}.sessionIdFrom` },
                        { path: `outputs.${testCase.reporterOutput}.sessionIdTo` }
                    ])
                }
            });
            expect(sendStep, testCase.recipePath).toMatchObject({
                type: 'ws.send',
                connection: `{${testCase.reporterOutput}.connection}`,
                request: {
                    send: {
                        id: {
                            senderId: `{${testCase.reporterOutput}.sessionIdFrom}`,
                            sessionId: `{${testCase.reporterOutput}.sessionIdFrom}`
                        }
                    }
                }
            });
        }
    });
});
