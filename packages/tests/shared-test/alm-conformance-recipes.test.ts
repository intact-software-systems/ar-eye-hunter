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
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/types.ts';

type ConnectCommand = Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect'; }>;

const group = { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' };

const CARRIER_CONNECT_TRANSPORTS = {
    ws: 'messages.ws',
    rtc: 'messages.rtc',
    'rtc-with-ws-fallback': 'messages.rtc'
} as const;

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

function connectCommandsOf(scenarios: readonly AlmConformanceScenario[]): readonly ConnectCommand[] {
    return recipesOf(scenarios).flatMap((recipe) => recipe.commands.filter((command): command is ConnectCommand => command.kind === 'rtc.connect'));
}

/** Every field a scenario's commands route by, so one assertion can prove they share one typeId. */
function routedTypeIdsOf(command: RallarBlackBoxTestCommand): readonly string[] {
    switch (command.kind) {
        case 'rtc.connect':
            return [String(command.rallar?.typeId), String(command.rallar?.topicId)];
        case 'messages.send':
            return command.topicId === undefined
                ? [command.typeId]
                : [command.typeId, command.topicId];
        case 'messages.received':
            return [command.typeId];
        case 'fault.inject':
            return command.match.typeId === undefined ? [] : [command.match.typeId];
        default:
            return [];
    }
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

    it('connects both roles on the carrier transport that subscribes the typed inbound channel', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(conformanceInput(carrier));
            const connects = connectCommandsOf(scenarios);

            expect(connects).toHaveLength(scenarios.length * 2);
            for (const connect of connects) {
                expect(connect.transport).toBe(CARRIER_CONNECT_TRANSPORTS[carrier]);
                expect(connect.rallar?.typeId).toMatch(/^alm\.conformance\./);
            }
        }
    });

    it('scopes every routed field of a scenario to that scenario typeId', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(conformanceInput(carrier))) {
                const routed = recipesOf([scenario])
                    .flatMap((recipe) => recipe.commands.flatMap(routedTypeIdsOf));

                expect(routed.length).toBeGreaterThan(0);
                expect(new Set(routed)).toEqual(new Set([`alm.conformance.${scenario.scenarioId}`]));
            }
        }
    });

    it('rejects a deadline shorter than the longest observation window', () => {
        expect(() => createAlmConformanceRecipes({ ...conformanceInput('ws'), deadlineMs: 3_499 }))
            .toThrow(new RangeError('createAlmConformanceRecipes requires deadlineMs of at least 3500.'));
        expect(() => createAlmConformanceRecipes({ ...conformanceInput('ws'), deadlineMs: 3_500 })).not.toThrow();
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
