import {
    describe,
    expect,
    it
} from 'vitest';

import { replaceCommandPlaceholders } from '@shared-test/rallar-bb-test/browser/browser-command-placeholders.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type {
    AlmConformanceTag,
    CreateAlmConformanceRecipesInput
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { formatJsonSchemaValidationErrors, validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';

/**
 * `not-yet-in-sync` (once per variant) is withheld from `ws`: its first hop must be RTC.
 * `cross-carrier-duplicate` needs both transports, once per order.
 * The fallback family (D56) needs the fallback cell.
 * The addressed family runs on two agents: server-command over ws only, unicast-fallback on the fallback cell.
 */
const CARRIER_SCENARIO_IDS = {
    ws: [
        'volatile-default',
        'bounded-rejection',
        'deadline-expiry',
        'delivery-baseline',
        'delivery-lifecycle',
        'durable-opt-in',
        'delivery-reload',
        'ordering-resync',
        'ws-unicast-receipt',
        'server-command',
        'capacity',
        ...Array.from({ length: 3 }, () => 'receipted-audience' as const)
    ],
    rtc: [
        'volatile-default',
        'bounded-rejection',
        'deadline-expiry',
        'delivery-baseline',
        'delivery-lifecycle',
        'durable-opt-in',
        'delivery-reload',
        'ordering-resync',
        'not-yet-in-sync',
        'not-yet-in-sync',
        'ws-unicast-receipt',
        'capacity',
        ...Array.from({ length: 4 }, () => 'receipted-audience' as const)
    ],
    'rtc-with-ws-fallback': [
        'volatile-default',
        'bounded-rejection',
        'deadline-expiry',
        'delivery-baseline',
        'delivery-lifecycle',
        'durable-opt-in',
        'delivery-reload',
        'ordering-resync',
        'cross-carrier-duplicate',
        'cross-carrier-duplicate',
        'not-yet-in-sync',
        'not-yet-in-sync',
        'fallback-within-deadline',
        'receipt-exhausted-fallback',
        'no-fallback-after-deadline',
        'ws-unicast-receipt',
        'unicast-fallback',
        'capacity',
        ...Array.from({ length: 4 }, () => 'receipted-audience' as const)
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

const ALM_CONFORMANCE_SCOPES: readonly AlmConformanceTag[] = ['smoke', 'full'];

/**
 * Recipe ids whose hold stays until the page ends. Recipient-b of the frozen audience withholds its ACK,
 * leaves and rejoins past the expiry; the hold matches only that scenario's type id, so no later block sees it.
 */
const HELD_UNTIL_PAGE_ENDS_RECIPE_SUFFIXES = ['-frozen-audience-membership-recipient-b'];

/**
 * A counted fault runs out after a number of frames, not after a time: a quick retry loop spends it before
 * the window the scenario means it to cover. So every fault holds until a later command of its own recipe
 * releases it with `0` or reloads the page, which replaces the page's fault port.
 */
function toUnreleasedFaults(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return recipe.commands.flatMap((command, index) => {
        if (command.kind !== 'fault.inject' || command.remaining === 0) {
            return [];
        }
        if (command.remaining !== 'until-cleared') {
            return [`${recipe.recipeId} ${command.faultId} counts ${command.remaining} frames`];
        }
        const released = recipe.commands.slice(index + 1).some((later) =>
            later.kind === 'agent.reload' ||
            (later.kind === 'fault.inject' && later.faultId === command.faultId && later.remaining === 0)
        );
        const heldUntilPageEnds = HELD_UNTIL_PAGE_ENDS_RECIPE_SUFFIXES.some((suffix) => recipe.recipeId.endsWith(suffix));
        return released || heldUntilPageEnds ? [] : [`${recipe.recipeId} ${command.faultId} is never released`];
    });
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

    it('holds every fault until a later command of its own recipe releases it, on every carrier and scope', () => {
        const unreleased = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
            ALM_CONFORMANCE_SCOPES.flatMap((scope) =>
                createAlmConformanceRecipes(toConformanceInput(carrier))
                    .filter((scenario) => scenario.tags.includes(scope))
                    .flatMap((scenario) => [scenario.sender, scenario.receiver, scenario.recipientB])
                    .flatMap((recipe) => recipe === undefined ? [] : toUnreleasedFaults(recipe))
                    .map((finding) => `${scope}: ${finding}`)
            )
        );

        expect(unreleased).toEqual([]);
    });
});
