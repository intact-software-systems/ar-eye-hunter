import type { RallarBlackBoxTestRecipe } from '../types.ts';

import type { RallarBlackBoxCompositeConformanceRecipeOptions } from '../composite-conformance.ts';
import {
    commandMetadata,
    configureCommand,
    recipeId,
    recipeMetadata,
    statsCommand,
    timeoutMs
} from '../conformance/composite-conformance-command-fixtures.ts';

export function loopUntilConvergenceRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    return {
        recipeId: recipeId('loop-until-convergence', options),
        name: 'Composite conformance: loop until convergence',
        continueOnFailure: false,
        metadata: recipeMetadata('loop-until-convergence'),
        commands: [
            configureCommand('loop-until-convergence', options),
            {
                kind: 'loop',
                commandId: 'loop-until-convergence-poll',
                until: 'first-success',
                count: 10,
                intervalMs: 10,
                metadata: commandMetadata('loop-until-convergence', 'loop-until-convergence-poll'),
                commands: [
                    {
                        kind: 'http.request',
                        commandId: 'loop-until-poll-request',
                        timeoutMs: timeoutMs(options),
                        request: {
                            path: '/api/config',
                            method: 'GET'
                        },
                        metadata: commandMetadata(
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
                        metadata: commandMetadata(
                            'loop-until-convergence',
                            'loop-until-poll-converged'
                        )
                    }
                ]
            },
            statsCommand('loop-until-convergence-stats', 'loop-until-convergence')
        ]
    };
}

export function loopUntilExhaustedRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    return {
        recipeId: recipeId('loop-until-exhausted', options),
        name: 'Composite conformance: loop until exhausted control',
        continueOnFailure: false,
        metadata: recipeMetadata('loop-until-exhausted'),
        commands: [
            configureCommand('loop-until-exhausted', options),
            {
                kind: 'loop',
                commandId: 'loop-until-exhausted-poll',
                until: 'first-success',
                backoffMultiplier: 2,
                count: 3,
                intervalMs: 5,
                metadata: commandMetadata('loop-until-exhausted', 'loop-until-exhausted-poll'),
                commands: [
                    {
                        kind: 'assert',
                        commandId: 'loop-until-never-converges',
                        source: 'state.commandHistory.length',
                        operator: 'lte',
                        expected: -1,
                        metadata: commandMetadata(
                            'loop-until-exhausted',
                            'loop-until-never-converges'
                        )
                    }
                ]
            }
        ]
    };
}
