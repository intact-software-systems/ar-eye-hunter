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
import { validateRallarWsUserTopicId } from '@shared/api/rallar-validation.ts';

type ConnectCommand = Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect'; }>;
type ReceivedCommand = Extract<RallarBlackBoxTestCommand, { kind: 'messages.received'; }>;

const CONFORMANCE_TOPIC_ID = 'room.alm-conformance';

const group = { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' };

const CARRIER_CONNECT_TRANSPORTS = {
    ws: 'messages.ws',
    rtc: 'messages.rtc',
    'rtc-with-ws-fallback': 'messages.rtc'
} as const;

/** `ordering-resync` is withheld from `ws`: see the family's own carrier-scoping comment. */
const CARRIER_SCENARIO_IDS = {
    ws: ['bounded-rejection', 'deadline-expiry', 'delivery-baseline'],
    rtc: ['bounded-rejection', 'deadline-expiry', 'delivery-baseline', 'ordering-resync'],
    'rtc-with-ws-fallback': ['bounded-rejection', 'deadline-expiry', 'delivery-baseline', 'ordering-resync']
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

/** Every field a scenario's commands match on, so one assertion can prove they share one typeId. */
function routedTypeIdsOf(command: RallarBlackBoxTestCommand): readonly string[] {
    switch (command.kind) {
        case 'rtc.connect':
            return [String(command.rallar?.typeId)];
        case 'messages.send':
        case 'messages.received':
            return [command.typeId];
        case 'fault.inject':
            return command.match.typeId === undefined ? [] : [command.match.typeId];
        default:
            return [];
    }
}

/** The WS topic every command routes over, which the product admits only under `app.` or `room.`. */
function routedTopicIdsOf(command: RallarBlackBoxTestCommand): readonly string[] {
    switch (command.kind) {
        case 'rtc.connect':
            return command.rallar?.topicId === undefined ? [] : [String(command.rallar.topicId)];
        case 'messages.send':
            return command.topicId === undefined ? [] : [command.topicId];
        default:
            return [];
    }
}

function receivedCommandsOf(scenarios: readonly AlmConformanceScenario[]): readonly ReceivedCommand[] {
    return recipesOf(scenarios).flatMap((recipe) => recipe.commands.filter((command): command is ReceivedCommand => command.kind === 'messages.received'));
}

describe('alm-conformance recipe family', () => {
    it('produces the carrier-scoped scenarios with distinct command ids', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(conformanceInput(carrier));

            expect(scenarios.map((scenario) => scenario.scenarioId)).toEqual(CARRIER_SCENARIO_IDS[carrier]);
            if (carrier === 'ws') {
                // WS typed sends carry no ordering block in this release, so ordering-resync cannot hold on ws.
                expect(scenarios.some((scenario) => scenario.scenarioId === 'ordering-resync')).toBe(false);
            }
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

    it('scopes every matched field of a scenario to that scenario typeId', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(conformanceInput(carrier))) {
                const routed = recipesOf([scenario])
                    .flatMap((recipe) => recipe.commands.flatMap(routedTypeIdsOf));

                expect(routed.length).toBeGreaterThan(0);
                expect(new Set(routed)).toEqual(new Set([`alm.conformance.${scenario.scenarioId}`]));
            }
        }
    });

    it('routes every carrier over one WS topic the product admits', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const topicIds = recipesOf(createAlmConformanceRecipes(conformanceInput(carrier)))
                .flatMap((recipe) => recipe.commands.flatMap(routedTopicIdsOf));

            expect(topicIds.length).toBeGreaterThan(0);
            expect(new Set(topicIds)).toEqual(new Set([CONFORMANCE_TOPIC_ID]));
            expect(validateRallarWsUserTopicId(CONFORMANCE_TOPIC_ID).errors).toEqual([]);
        }
    });

    it('opens every receive window across the sender prologue up to the deadline', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const received = receivedCommandsOf(
                createAlmConformanceRecipes({ ...conformanceInput(carrier), deadlineMs: 15_000 })
            );

            expect(received.length).toBeGreaterThan(0);
            for (const command of received) {
                expect({ windowMs: command.windowMs, timeoutMs: command.timeoutMs })
                    .toEqual({ windowMs: 14_000, timeoutMs: 15_000 });
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
            ['smoke', 'full']
        ]);
    });
});
