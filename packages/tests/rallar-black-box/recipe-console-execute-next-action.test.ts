import { describe, expect, it } from 'vitest';
import {
    deriveExecuteNextAction,
    type ExecuteNextActionInput,
} from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-next-action.ts';
import {
    deriveExecuteActionPolicy,
    type ExecuteActionPolicyInput,
} from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-action-policy.ts';

function policy(overrides: Partial<ExecuteActionPolicyInput> = {}) {
    return deriveExecuteActionPolicy({
        connection: 'live',
        runState: undefined,
        hasKnownRun: false,
        unknownDistributedRunId: false,
        recipeAvailable: true,
        schemaValid: true,
        preflightValid: true,
        selectedTargetsSafe: true,
        manifestValid: true,
        resolutionCurrent: false,
        ...overrides,
    });
}

function input(overrides: Partial<ExecuteNextActionInput> = {}): ExecuteNextActionInput {
    return {
        connection: 'live',
        policy: policy(),
        targetCount: 3,
        targetableCount: 3,
        launchedExpectedCount: 0,
        launchedReadyCount: 0,
        ...overrides,
    };
}

describe('Recipe Console Execute next action', () => {
    it.each([
        ['no agents', input({ targetCount: 0, targetableCount: 0 }), 'connect-agents', 'Connect agents to continue.'],
        ['registering', input({ targetCount: 0, targetableCount: 0, launchedExpectedCount: 3, launchedReadyCount: 2 }), 'registering', '2 of 3 browser agents ready'],
        ['registering beside existing agents', input({
            targetableCount: 1,
            launchedExpectedCount: 3,
            launchedReadyCount: 1,
        }), 'registering', '1 of 3 browser agents ready'],
        ['selecting a fully registered cohort', input({
            targetableCount: 4,
            launchedExpectedCount: 3,
            launchedReadyCount: 3,
            launchedCohortSelectionPending: true,
        }), 'registering', '3 of 3 browser agents ready'],
        ['manual target adjustment after cohort selection', input({
            targetCount: 2,
            targetableCount: 3,
            launchedExpectedCount: 3,
            launchedReadyCount: 3,
            launchedCohortSelectionPending: false,
        }), 'resolve', 'Resolve 2 targets'],
        ['resolve', input(), 'resolve', 'Resolve 3 targets'],
        ['create', input({ policy: policy({ resolutionCurrent: true }) }), 'create', 'Create draft'],
        ['stage', input({
            runState: 'draft',
            policy: policy({ runState: 'draft', hasKnownRun: true, resolutionCurrent: true }),
        }), 'stage', 'Stage 3 agents'],
        ['wait for ACK', input({
            runState: 'waiting-for-ack',
            ackReadyCount: 2,
            ackExpectedCount: 3,
            policy: policy({ runState: 'waiting-for-ack', hasKnownRun: true, resolutionCurrent: true }),
        }), 'waiting-for-ack', '2 of 3 agents acknowledged staging'],
        ['review start', input({
            runState: 'ready',
            policy: policy({ runState: 'ready', hasKnownRun: true, resolutionCurrent: true }),
        }), 'review-start', 'Review and start'],
        ['monitor running', input({
            runState: 'running',
            policy: policy({ runState: 'running', hasKnownRun: true, resolutionCurrent: true }),
        }), 'monitor', 'Monitor run'],
        ['monitor terminal', input({
            runState: 'passed',
            policy: policy({ runState: 'passed', hasKnownRun: true, resolutionCurrent: true }),
        }), 'monitor', 'Monitor run'],
        ['monitor terminal after agents disconnect', input({
            targetableCount: 0,
            runState: 'passed',
            policy: policy({
                runState: 'passed',
                hasKnownRun: true,
                resolutionCurrent: true,
                selectedTargetsSafe: false,
            }),
        }), 'monitor', 'Monitor run'],
    ] as const)('derives %s as one current step', (_label, facts, step, actionLabel) => {
        expect(deriveExecuteNextAction(facts)).toMatchObject({
            step,
            label: actionLabel,
        });
    });

    it.each(['connecting', 'offline', 'error', 'auth-required', 'credential-trust'] as const)(
        'uses one precise Refresh blocker for %s control truth',
        connection => {
            expect(deriveExecuteNextAction(input({
                connection,
                policy: policy({ connection }),
            }))).toMatchObject({
                step: 'refresh-control',
                label: 'Refresh control data',
            });
        },
    );
});
