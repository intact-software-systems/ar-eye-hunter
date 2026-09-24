import {
    describe,
    expect,
    it
} from 'vitest';

import { replaceCommandPlaceholders } from '@shared-test/rallar-bb-test/browser/browser-command-placeholders.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario,
    type CreateAlmConformanceRecipesInput
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { formatJsonSchemaValidationErrors, validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';

/**
 * `ordering-resync` and `not-yet-in-sync` (once per variant) are withheld from `ws`: their first hop must be RTC.
 * `cross-carrier-duplicate` needs both transports, once per order.
 */
const CARRIER_SCENARIO_IDS = {
    ws: ['bounded-rejection', 'deadline-expiry', 'delivery-baseline', 'delivery-lifecycle', 'delivery-reload'],
    rtc: [
        'bounded-rejection',
        'deadline-expiry',
        'delivery-baseline',
        'delivery-lifecycle',
        'delivery-reload',
        'ordering-resync',
        'not-yet-in-sync',
        'not-yet-in-sync'
    ],
    'rtc-with-ws-fallback': [
        'bounded-rejection',
        'deadline-expiry',
        'delivery-baseline',
        'delivery-lifecycle',
        'delivery-reload',
        'ordering-resync',
        'cross-carrier-duplicate',
        'cross-carrier-duplicate',
        'not-yet-in-sync',
        'not-yet-in-sync'
    ]
} as const;

function toConformanceInput(
    carrier: CreateAlmConformanceRecipesInput['carrier']
): CreateAlmConformanceRecipesInput {
    return {
        group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
        carrier,
        typeId: 'alm.conformance',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000
    };
}

function toRecipes(scenarios: readonly AlmConformanceScenario[]): readonly RallarBlackBoxTestRecipe[] {
    return scenarios.flatMap((scenario) => [scenario.sender, scenario.receiver]);
}

describe('ALM conformance recipe validation', () => {
    it('produces carrier-scoped scenarios with distinct command ids and valid schemas', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));

            expect(scenarios.map((scenario) => scenario.scenarioId)).toEqual(CARRIER_SCENARIO_IDS[carrier]);
            const commandIds = toRecipes(scenarios)
                .flatMap((recipe) => recipe.commands.map((command) => command.commandId));
            expect(new Set(commandIds).size).toBe(commandIds.length);
            for (const recipe of toRecipes(scenarios)) {
                const validated = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe);
                expect(
                    validated.ok,
                    validated.ok ? undefined : formatJsonSchemaValidationErrors(validated.errors)
                ).toBe(true);
            }
        }
    });

    it.each([
        { name: 'actual fallback run', runId: 'alm-rtc-with-ws-fallback-1789846914072-83fc' },
        { name: 'oversized runtime identities', runId: `oversized-run-${'r'.repeat(1_000)}` }
    ])('keeps expanded mutation identities API-valid and distinct for $name', ({ runId }) => {
        const requestIds = new Set<string>();
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const recipe of toRecipes(createAlmConformanceRecipes(toConformanceInput(carrier)))) {
                const values = {
                    session: undefined,
                    wsTicket: undefined,
                    config: { runId, agentId: `${recipe.metadata?.role}-${'a'.repeat(1_000)}` }
                };
                for (const command of recipe.commands) {
                    if (command.kind !== 'http.request') {
                        continue;
                    }
                    const template = command.request.path!.split('/').at(-1)!;
                    const requestId = replaceCommandPlaceholders(template, values);
                    expect(assertApiMutationRequestId(requestId)).toBe(requestId);
                    expect(replaceCommandPlaceholders(template, values)).toBe(requestId);
                    expect(requestIds.has(requestId), command.commandId).toBe(false);
                    requestIds.add(requestId);
                }
            }
        }
    });

    it('accepts every command over the control protocol', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const recipe of toRecipes(createAlmConformanceRecipes(toConformanceInput(carrier)))) {
                for (const command of recipe.commands) {
                    const validated = validateRallarBlackBoxTestCommand(command);
                    expect(validated.ok, validated.ok ? undefined : validated.error).toBe(true);
                }
            }
        }
    });
});
