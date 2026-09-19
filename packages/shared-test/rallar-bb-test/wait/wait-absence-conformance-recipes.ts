import type { RallarBlackBoxCompositeConformanceRecipeOptions } from '../composite-conformance.ts';
import {
    toCloseCommand,
    toConfigureCommand,
    toConformanceMessageWait,
    toConformanceProbeCommands,
    toStatsCommand
} from '../conformance/composite-conformance-command-fixtures.ts';
import { toRecipeId, toRecipeMetadata } from '../conformance/composite-conformance-recipe-values.ts';
import type { RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

export function waitAbsenceHoldRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('wait-absence-hold', options),
        name: 'Composite conformance: wait absence holds',
        continueOnFailure: false,
        metadata: toRecipeMetadata('wait-absence-hold'),
        commands: [
            toConfigureCommand('wait-absence-hold', options),
            ...toConformanceProbeCommands({
                caseId: 'wait-absence-hold',
                commandPrefix: 'wait-absence-hold',
                options,
                data: {
                    topic: 'rallar.conformance.wait-absence-hold',
                    marker: 'wait-absence-hold'
                }
            }),
            toConformanceMessageWait({
                commandId: 'wait-absence-hold-positive-control',
                timeoutMs: options.timeoutMs,
                topic: 'rallar.conformance.wait-absence-hold',
                caseId: 'wait-absence-hold'
            }),
            toConformanceMessageWait({
                commandId: 'wait-absence-hold-absent',
                timeoutMs: 1_500,
                absent: true,
                topic: 'rallar.conformance.wait-absence-other-room',
                caseId: 'wait-absence-hold'
            }),
            toStatsCommand('wait-absence-hold-stats', 'wait-absence-hold'),
            toCloseCommand('wait-absence-hold-close', 'wait-absence-hold')
        ]
    };
}

export function waitAbsenceViolatedRecipe(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId: toRecipeId('wait-absence-violated', options),
        name: 'Composite conformance: wait absence violated control',
        continueOnFailure: false,
        metadata: toRecipeMetadata('wait-absence-violated'),
        commands: [
            toConfigureCommand('wait-absence-violated', options),
            ...toConformanceProbeCommands({
                caseId: 'wait-absence-violated',
                commandPrefix: 'wait-absence-violated',
                options,
                data: {
                    topic: 'rallar.conformance.wait-absence-violated',
                    marker: 'wait-absence-violated'
                }
            }),
            toConformanceMessageWait({
                commandId: 'wait-absence-violated-positive-control',
                timeoutMs: options.timeoutMs,
                topic: 'rallar.conformance.wait-absence-violated',
                caseId: 'wait-absence-violated'
            }),
            toConformanceMessageWait({
                commandId: 'wait-absence-violated-absent',
                timeoutMs: 1_500,
                absent: true,
                topic: 'rallar.conformance.wait-absence-violated',
                caseId: 'wait-absence-violated'
            })
        ]
    };
}
