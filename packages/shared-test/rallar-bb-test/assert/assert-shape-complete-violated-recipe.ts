import type { RallarBlackBoxCompositeConformanceRecipeOptions } from '../composite-conformance.ts';
import {
    toConfigureCommand,
    toConformanceMessageWait,
    toConformanceProbeCommands
} from '../conformance/composite-conformance-command-fixtures.ts';
import {
    toCommandMetadata,
    toRecipeId,
    toRecipeMetadata
} from '../conformance/composite-conformance-recipe-values.ts';
import type { RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

export function assertShapeCompleteViolatedRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('assert-shape-complete-violated', options),
        name: 'Composite conformance: assert shape complete violated control',
        continueOnFailure: false,
        metadata: toRecipeMetadata('assert-shape-complete-violated'),
        commands: [
            toConfigureCommand('assert-shape-complete-violated', options),
            ...toConformanceProbeCommands({
                caseId: 'assert-shape-complete-violated',
                commandPrefix: 'assert-shape-violated',
                options,
                data: {
                    topic: 'rallar.conformance.assert-shape',
                    items: ['expected-item', 'unexpected-item']
                }
            }),
            toConformanceMessageWait({
                commandId: 'assert-shape-violated-wait',
                timeoutMs: options.timeoutMs,
                topic: 'rallar.conformance.assert-shape',
                caseId: 'assert-shape-complete-violated'
            }),
            {
                kind: 'assert',
                commandId: 'assert-shape-violated-complete',
                source: 'messages.0.payload.data',
                operator: 'matchesShapeComplete',
                expected: {
                    topic: 'rallar.conformance.assert-shape',
                    items: ['expected-item']
                },
                metadata: toCommandMetadata('assert-shape-complete-violated', 'assert-shape-violated-complete')
            }
        ]
    };
}
