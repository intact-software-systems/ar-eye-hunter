import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { CreateAlmConformanceRecipesInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { readAlmReceiptRolesEntries } from '@shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const AUDIENCE_SCENARIO_IDS = ['principal-delivery', 'fixed-list-delivery', 'world-routing'] as const;
const PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;
const RECEIPT_WINDOW = [
    'received-self-1',
    'receipts-1',
    'assert-receipt-state-1',
    'assert-receipt-receiptMode-1',
    'assert-receipt-expectedRecipientPeerIds-count-1',
    'assert-receipt-confirmedRecipientPeerIds-count-1',
    'assert-receipt-unconfirmedRecipientPeerIds-count-1'
] as const;

type AudienceScenarioId = (typeof AUDIENCE_SCENARIO_IDS)[number];

function findScenario(input: CreateAlmConformanceRecipesInput, scenarioId: AudienceScenarioId): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(input).find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${input.carrier}.`);
    }
    return scenario;
}

function requireSibling(scenario: AlmConformanceScenario): RallarBlackBoxTestRecipe {
    if (scenario.sibling === undefined) {
        throw new Error(`${scenario.scenarioKey} declares no sibling.`);
    }
    return scenario.sibling;
}

function toCommandNames(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const prefix = `${recipe.recipeId}-`;
    return recipe.commands.map((command) => (command.commandId ?? '').replace(prefix, ''));
}

function findCommand(recipe: RallarBlackBoxTestRecipe, name: string): RallarBlackBoxTestCommand {
    const command = recipe.commands.find((candidate) => candidate.commandId === `${recipe.recipeId}-${name}`);
    if (command === undefined) {
        throw new Error(`${recipe.recipeId} has no ${name}.`);
    }
    return command;
}

/** Every identity a scenario mints that a run shares with the other scenarios of its `{runId}`; a read mints none. */
function toMintedIdentities(scenario: AlmConformanceScenario): readonly string[] {
    return [scenario.sender, scenario.receiver, requireSibling(scenario)].flatMap((recipe) =>
        recipe.commands.flatMap((command) => [
            `command:${command.commandId}`,
            ...(command.kind === 'messages.send' && !('replayOnCarrier' in command) ? [`handle:${command.handleId}`] : []),
            ...(command.kind === 'http.request' && command.request.method !== 'GET' ? [`request:${command.request.path}`] : [])
        ])
    );
}

/** Runs the sender's verdict tail against one observation of its handle. */
async function readVerdictTail(sender: RallarBlackBoxTestRecipe, observation: object): Promise<boolean> {
    const from = sender.commands.findIndex((command) => command.kind === 'messages.observe');
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: (command) => command.kind === 'messages.observe' ? { status: 'ok', value: observation } : undefined
    });
    const tail = { ...sender, commands: sender.commands.slice(from, -1) };
    return (await runtime.execute({ kind: 'recipe.run', recipe: tail })).ok;
}

describe('audience conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the %s audience cells on the sender\'s principal twice, in the full tag only', (carrier) => {
        const cells = createAlmConformanceRecipes(toConformanceInput(carrier))
            .filter((scenario) => AUDIENCE_SCENARIO_IDS.some((scenarioId) => scenarioId === scenario.scenarioId))
            .map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags }));

        expect(cells).toEqual(AUDIENCE_SCENARIO_IDS.map((scenarioId) => ({
            scenarioId,
            laneFamily: 'same-principal',
            roles: ['sender', 'receiver', 'sibling'],
            tags: ['full']
        })));
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s audience cell identities no other scenario of the run shares', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const isAudience = (scenario: AlmConformanceScenario) => AUDIENCE_SCENARIO_IDS.some((scenarioId) => scenarioId === scenario.scenarioId);
        const others = new Set(
            scenarios.filter((scenario) => !isAudience(scenario)).flatMap((scenario) =>
                [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor]
                    .flatMap((recipe) => recipe?.commands.map((command) => `command:${command.commandId}`) ?? [])
            )
        );
        const own = scenarios.filter(isAudience).flatMap(toMintedIdentities);

        expect(own.filter((identity) => others.has(identity))).toEqual([]);
        expect(new Set(own).size).toBe(own.length);
        for (const scenario of scenarios.filter(isAudience)) {
            for (const command of [scenario.sender, scenario.receiver, requireSibling(scenario)].flatMap((recipe) => recipe.commands)) {
                expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
            }
        }
    });
});

describe('principal-delivery', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('addresses the sender\'s own principal over %s and pins a receipt that expects the sibling alone', (carrier) => {
        const scenario = findScenario(toConformanceInput(carrier), 'principal-delivery');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            ...(carrier === 'ws' ? ['receipt-admitted-1'] : []),
            ...RECEIPT_WINDOW,
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            carrier,
            scope: 'principal',
            principalId: '{auth.clientId}',
            ack: 'all-logical-recipients',
            reliability: 'at-least-once',
            payload: { marker: 'principal-delivery', carrier }
        });
        expect(findCommand(scenario.sender, 'send-1')).not.toHaveProperty('recipientPeer');
        expect(readAlmReceiptRolesEntries(scenario.sender)).toEqual([
            { handleId: `alm-${carrier}-principal-delivery-send-1`, confirmed: ['sibling'], unconfirmed: [] }
        ]);
        expect(findCommand(scenario.sender, 'assert-receipt-expectedRecipientPeerIds-count-1'))
            .toMatchObject({ kind: 'assert', expected: 1 });
    });

    it('delivers once to the sibling and never to the receiver, another principal\'s session in the room', () => {
        const scenario = findScenario(toConformanceInput('rtc'), 'principal-delivery');

        expect(toCommandNames(requireSibling(scenario))).toEqual([...PROLOGUE, 'received-1', 'received-2', 'stats']);
        expect(findCommand(requireSibling(scenario), 'received-1')).toMatchObject({ kind: 'messages.received', count: 1, absent: false });
        expect(toCommandNames(scenario.receiver)).toEqual([...PROLOGUE, 'received-1', 'stats']);
        expect(findCommand(scenario.receiver, 'received-1')).toMatchObject({
            kind: 'messages.received',
            typeId: 'alm.conformance.rtc.principal-delivery',
            count: 1,
            absent: true,
            windowMs: 17_000
        });
    });

    it('connects the sibling as a recipient that waits for both other peers over rtc', () => {
        const sibling = requireSibling(findScenario(toConformanceInput('rtc'), 'principal-delivery'));

        expect(findCommand(sibling, 'connect')).toMatchObject({
            kind: 'rtc.connect',
            connection: 'receiver',
            actor: '{auth.clientId}',
            readiness: { minReadyPeers: 2 }
        });
    });
});

describe('fixed-list-delivery', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('lists the receiver by its role over %s and pins a receipt that expects it alone', (carrier) => {
        const scenario = findScenario(toConformanceInput(carrier), 'fixed-list-delivery');

        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            carrier,
            recipientPeer: 'receiver',
            ack: 'all-logical-recipients',
            payload: { marker: 'fixed-list-delivery', carrier }
        });
        expect(findCommand(scenario.sender, 'send-1')).not.toHaveProperty('scope');
        expect(readAlmReceiptRolesEntries(scenario.sender)).toEqual([
            { handleId: `alm-${carrier}-fixed-list-delivery-send-1`, confirmed: ['receiver'], unconfirmed: [] }
        ]);
        expect(toCommandNames(scenario.receiver)).toEqual([...PROLOGUE, 'received-1', 'received-2', 'stats']);
        expect(toCommandNames(requireSibling(scenario))).toEqual([...PROLOGUE, 'received-1', 'stats']);
        expect(findCommand(requireSibling(scenario), 'received-1')).toMatchObject({ count: 1, absent: true });
    });
});

describe('world-routing', () => {
    it('admits the world send over ws on its app topic, delivers it once to both other sessions of the scope and never back to the sender', () => {
        const scenario = findScenario(toConformanceInput('ws'), 'world-routing');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'received-self-1',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            carrier: 'ws',
            scope: 'world',
            topicId: 'app.alm-conformance.world',
            payload: { marker: 'world-routing', carrier: 'ws' }
        });
        expect(findCommand(scenario.sender, 'received-self-1')).toMatchObject({
            kind: 'messages.received',
            connection: 'sender',
            typeId: 'alm.conformance.ws.world-routing',
            count: 1,
            absent: true,
            windowMs: 17_000
        });
        for (const recipe of [scenario.sender, scenario.receiver, requireSibling(scenario)]) {
            expect(findCommand(recipe, 'connect')).toMatchObject({ rallar: { topicId: 'app.alm-conformance.world' } });
        }
        expect(findCommand(scenario.sender, 'send-1')).not.toHaveProperty('ack');
        for (const recipient of [scenario.receiver, requireSibling(scenario)]) {
            expect(toCommandNames(recipient)).toEqual([...PROLOGUE, 'received-1', 'received-2', 'stats']);
        }
    });

    it('reads the rtc send rejected, refused unsupported at admission with no carrier attempt, and proves nobody receives it', async () => {
        const scenario = findScenario(toConformanceInput('rtc'), 'world-routing');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'send-1',
            'observe-rejected-1',
            'assert-refused-1',
            'assert-unsupported-1',
            'assert-no-attempt-1',
            'received-self-1',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'observe-rejected-1')).toMatchObject({
            kind: 'messages.observe',
            handleId: 'alm-rtc-world-routing-send-1',
            state: ['rejected']
        });
        for (const recipient of [scenario.receiver, requireSibling(scenario)]) {
            expect(toCommandNames(recipient)).toEqual([...PROLOGUE, 'received-1', 'stats']);
            expect(findCommand(recipient, 'received-1')).toMatchObject({ count: 1, absent: true });
        }
        const refusal = (reason: string) => ({
            state: 'rejected',
            failure: { kind: 'refused', reason },
            attempts: 0,
            attemptCarriers: []
        });
        expect(await readVerdictTail(scenario.sender, refusal('unsupported'))).toBe(true);
        expect(await readVerdictTail(scenario.sender, refusal('unauthorized'))).toBe(false);
        expect(await readVerdictTail(scenario.sender, { ...refusal('unsupported'), attempts: 1, attemptCarriers: ['ws'] }))
            .toBe(false);
    });

    it('reads the fallback carrier\'s world send on one ws attempt with no hand-over, and both sessions receive it', async () => {
        const scenario = findScenario(toConformanceInput('rtc-with-ws-fallback'), 'world-routing');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'send-1',
            'observe-transport-accepted-1',
            'assert-one-attempt-1',
            'assert-ws-attempt-1',
            'assert-no-fallback-1',
            'received-self-1',
            'stats'
        ]);
        for (const recipient of [scenario.receiver, requireSibling(scenario)]) {
            expect(toCommandNames(recipient)).toEqual([...PROLOGUE, 'received-1', 'received-2', 'stats']);
        }
        const direct = { state: 'transport-accepted', attempts: 1, attemptCarriers: ['ws'] };
        const handedOver = {
            state: 'transport-accepted',
            attempts: 2,
            attemptCarriers: ['rtc', 'ws'],
            carrierFallback: { from: 'rtc', to: 'ws', reason: 'not-ready' }
        };
        expect(await readVerdictTail(scenario.sender, direct)).toBe(true);
        expect(await readVerdictTail(scenario.sender, handedOver)).toBe(false);
        expect(await readVerdictTail(scenario.sender, { ...direct, carrierFallback: handedOver.carrierFallback })).toBe(false);
    });
});
