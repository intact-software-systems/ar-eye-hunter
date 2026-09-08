import {
    describe,
    expect,
    it
} from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario,
    type CreateAlmConformanceRecipesInput
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control-protocol.ts';
import {
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    validateJsonSchema
} from '@shared-test/rallar-bb-test/schema.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';

const group = { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' };

function conformanceInput(
    carrier: CreateAlmConformanceRecipesInput['carrier']
): CreateAlmConformanceRecipesInput {
    return {
        group,
        carrier,
        typeId: 'alm.conformance',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 5_000
    };
}

function recipesOf(scenarios: readonly AlmConformanceScenario[]): readonly RallarBlackBoxTestRecipe[] {
    return scenarios.flatMap((scenario) => [scenario.sender, scenario.receiver]);
}

describe('alm-conformance recipe family', () => {
    it('produces four valid scenarios per carrier with distinct command ids', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(conformanceInput(carrier));

            expect(scenarios.map((scenario) => scenario.scenarioId)).toEqual([
                'bounded-rejection',
                'deadline-expiry',
                'delivery-baseline',
                'ordering-resync'
            ]);
            const commandIds = recipesOf(scenarios).flatMap((recipe) => recipe.commands.map((command) => command.commandId));
            expect(new Set(commandIds).size).toBe(commandIds.length);
            for (const recipe of recipesOf(scenarios)) {
                const validated = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe);
                expect(
                    validated.ok,
                    validated.ok ? undefined : formatJsonSchemaValidationErrors(validated.errors)
                ).toBe(true);
            }
        }
    });

    it('accepts every command over the control protocol', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const recipe of recipesOf(createAlmConformanceRecipes(conformanceInput(carrier)))) {
                for (const command of recipe.commands) {
                    const validated = validateRallarBlackBoxTestCommand(command);
                    expect(validated.ok, validated.ok ? undefined : validated.error).toBe(true);
                }
            }
        }
    });

    it('tags bounded-rejection and delivery-baseline as smoke', () => {
        const scenarios = createAlmConformanceRecipes(conformanceInput('ws'));

        expect(
            scenarios.filter((scenario) => scenario.tags.includes('smoke')).map((scenario) => scenario.scenarioId)
        ).toEqual(['bounded-rejection', 'delivery-baseline']);
        expect(scenarios.map((scenario) => scenario.tags)).toEqual([
            ['smoke', 'full'],
            ['full'],
            ['smoke', 'full'],
            ['full']
        ]);
    });
});
