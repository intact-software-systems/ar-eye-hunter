import type { RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

import type { RallarBlackBoxCompositeConformanceRecipeOptions } from '../composite-conformance.ts';
import {
    toCommandMetadata,
    toConfigureCommand,
    toRecipeId,
    toRecipeMetadata,
    toStatsCommand,
    toTimeoutMs
} from '../conformance/composite-conformance-command-fixtures.ts';

export function loopUntilConvergenceRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('loop-until-convergence', options),
        name: 'Composite conformance: loop until convergence',
        continueOnFailure: false,
        metadata: toRecipeMetadata('loop-until-convergence'),
        commands: [
            toConfigureCommand('loop-until-convergence', options),
            {
                kind: 'loop',
                commandId: 'loop-until-convergence-poll',
                until: 'first-success',
                count: 10,
                intervalMs: 10,
                metadata: toCommandMetadata('loop-until-convergence', 'loop-until-convergence-poll'),
                commands: [
                    {
                        kind: 'http.request',
                        commandId: 'loop-until-poll-request',
                        timeoutMs: toTimeoutMs(options),
                        request: {
                            path: '/api/config',
                            method: 'GET'
                        },
                        metadata: toCommandMetadata(
                            'loop-until-convergence',
                            'loop-until-poll-request'
                        )
                    },
                    {
                        kind: 'assert',
                        commandId: 'loop-until-poll-converged',
                        source: 'state.commandHistory.length',
                        operator: 'gte',
                        expected: 6,
                        metadata: toCommandMetadata(
                            'loop-until-convergence',
                            'loop-until-poll-converged'
                        )
                    }
                ]
            },
            toStatsCommand('loop-until-convergence-stats', 'loop-until-convergence')
        ]
    };
}

export function loopUntilExhaustedRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('loop-until-exhausted', options),
        name: 'Composite conformance: loop until exhausted control',
        continueOnFailure: false,
        metadata: toRecipeMetadata('loop-until-exhausted'),
        commands: [
            toConfigureCommand('loop-until-exhausted', options),
            {
                kind: 'loop',
                commandId: 'loop-until-exhausted-poll',
                until: 'first-success',
                backoffMultiplier: 2,
                count: 3,
                intervalMs: 5,
                metadata: toCommandMetadata('loop-until-exhausted', 'loop-until-exhausted-poll'),
                commands: [
                    {
                        kind: 'assert',
                        commandId: 'loop-until-never-converges',
                        source: 'state.commandHistory.length',
                        operator: 'lte',
                        expected: -1,
                        metadata: toCommandMetadata(
                            'loop-until-exhausted',
                            'loop-until-never-converges'
                        )
                    }
                ]
            }
        ]
    };
}
