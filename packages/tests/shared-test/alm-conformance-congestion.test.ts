import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestAssertCommand,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestFaultInjectCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const CONGESTION_SCENARIO_IDS = ['backpressure-hands-over', 'backpressure-refused', 'backpressure-deferred'] as const;
const SENDER_PROLOGUE = ['ensure-group', 'ensure-member', 'connect', 'storage-counters-connected'] as const;
const RECEIVER_PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;

type CongestionScenarioId = (typeof CONGESTION_SCENARIO_IDS)[number];

const CONGESTION_CARRIERS: Readonly<Record<CongestionScenarioId, readonly AlmConformanceCarrier[]>> = {
    'backpressure-hands-over': ['rtc-with-ws-fallback'],
    'backpressure-refused': ['rtc'],
    'backpressure-deferred': ['ws', 'rtc']
};

function findScenario(carrier: AlmConformanceCarrier, scenarioId: CongestionScenarioId): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${carrier}.`);
    }
    return scenario;
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

function isCongestionScenario(scenario: AlmConformanceScenario): boolean {
    return CONGESTION_SCENARIO_IDS.some((scenarioId) => scenarioId === scenario.scenarioId);
}

/** Runs the named handle read or receipts read and the assertions that follow it, answering the read with one observation. */
async function readTail(recipe: RallarBlackBoxTestRecipe, from: string, observation: object): Promise<boolean> {
    const start = recipe.commands.findIndex((command) => command.commandId === `${recipe.recipeId}-${from}`);
    const following = recipe.commands.slice(start + 1);
    const end = following.findIndex((command) => command.kind !== 'assert');
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: (command) =>
            command.kind === 'messages.observe' || command.kind === 'messages.receipts'
                ? { status: 'ok', value: observation }
                : undefined
    });
    const commands = [recipe.commands[start], ...following.slice(0, end === -1 ? following.length : end)];
    return (await runtime.execute({ kind: 'recipe.run', recipe: { ...recipe, commands } })).ok;
}

/** Each change alone, applied to an observation the read accepts, must fail it: no fact assertion goes unproven. */
interface ReadTailChangeInput {
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly from: string;
    readonly observation: object;
    readonly changes: readonly object[];
}

async function readTailForEachChange({ recipe, from, observation, changes }: ReadTailChangeInput): Promise<readonly boolean[]> {
    const results: boolean[] = [];
    for (const change of changes) {
        results.push(await readTail(recipe, from, { ...observation, ...change }));
    }
    return results;
}

interface HoldInput {
    readonly carrier: 'ws' | 'rtc';
    readonly remaining: 'until-cleared' | 0;
    readonly cell: CongestionScenarioId;
    readonly sendCarrier: AlmConformanceCarrier;
}

function toHold({ carrier, remaining, cell, sendCarrier }: HoldInput): RallarBlackBoxTestFaultInjectCommand {
    const typeId = `alm.conformance.${sendCarrier}.${cell}`;
    return {
        kind: 'fault.inject',
        faultId: `backpressure-${carrier}-${typeId}`,
        carrier,
        match: { typeId },
        action: 'backpressure',
        remaining
    };
}

function toCounterRead(recipe: RallarBlackBoxTestRecipe, counter: string): RallarBlackBoxTestAssertCommand {
    return {
        kind: 'assert',
        source: `resultCache.${recipe.recipeId}-stats-congestion.value.rallar.congestion.${counter}`,
        operator: 'gt',
        expected: 0
    };
}

describe('congestion conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the %s congestion cells on the two agents, in the full tag only, after the volatile bound', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const cells = scenarios.filter(isCongestionScenario)
            .map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags }));

        expect(cells).toEqual(
            CONGESTION_SCENARIO_IDS.filter((scenarioId) => CONGESTION_CARRIERS[scenarioId].includes(carrier)).map((scenarioId) => ({
                scenarioId,
                laneFamily: 'two-agent',
                roles: ['sender', 'receiver'],
                tags: ['full']
            }))
        );
        // The two-agent family runs them after every other cell but the fairness cells, which follow them, so the
        // counter each one reads is its own.
        const twoAgent = scenarios.filter((scenario) => scenario.laneFamily === 'two-agent').map(({ scenarioId }) => scenarioId);
        const fairnessStart = twoAgent.findIndex((scenarioId) =>
            ['own-share-under-inbound', 'buffered-track-drains', 'churn-bounded-tracks'].includes(scenarioId)
        );
        const beforeFairness = fairnessStart === -1 ? twoAgent : twoAgent.slice(0, fairnessStart);
        expect(beforeFairness.slice(beforeFairness.length - cells.length)).toEqual(cells.map(({ scenarioId }) => scenarioId));
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s congestion cell identities no other scenario of the run shares, each a valid command', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const toRecipes = (scenario: AlmConformanceScenario) =>
            [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor, scenario.sibling]
                .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined);
        const others = new Set(
            scenarios.filter((scenario) => !isCongestionScenario(scenario)).flatMap(toRecipes)
                .flatMap((recipe) => recipe.commands.map((command) => command.commandId))
        );
        const own = scenarios.filter(isCongestionScenario).flatMap(toRecipes).flatMap((recipe) => recipe.commands);

        expect(own.map((command) => command.commandId).filter((commandId) => others.has(commandId))).toEqual([]);
        expect(new Set(own.map((command) => command.commandId)).size).toBe(own.length);
        for (const command of own) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('backpressure-hands-over', () => {
    const handedOver = {
        state: 'acknowledged',
        attempts: 2,
        attemptOutcomes: ['refused', 'sent'],
        attemptCarriers: ['rtc', 'ws'],
        attemptRefusalReasons: ['congested']
    };

    it('holds the RTC leg at its watermark, so the best-effort send is refused congested there and handed to WS at admission', async () => {
        const scenario = findScenario('rtc-with-ws-fallback', 'backpressure-hands-over');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...SENDER_PROLOGUE,
            'hold-backpressure',
            'send-1',
            'observe-acknowledged-1',
            'assert-acknowledged-1',
            'assert-rtc-refused-1',
            'assert-ws-sent-1',
            'assert-rtc-leg-1',
            'assert-ws-leg-1',
            'assert-congested-1',
            'stats-congestion',
            'assert-congestion-handed-over',
            'release-backpressure',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'hold-backpressure'))
            .toMatchObject(toHold({ carrier: 'rtc', remaining: 'until-cleared', cell: 'backpressure-hands-over', sendCarrier: 'rtc-with-ws-fallback' }));
        expect(findCommand(scenario.sender, 'release-backpressure'))
            .toMatchObject(toHold({ carrier: 'rtc', remaining: 0, cell: 'backpressure-hands-over', sendCarrier: 'rtc-with-ws-fallback' }));
        // Best effort, priority 0: the default drop-low policy drops it under backpressure.
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            carrier: 'rtc-with-ws-fallback',
            ack: 'receiver',
            reliability: 'best-effort',
            ttlMs: 30_000,
            handleId: 'alm-rtc-with-ws-fallback-backpressure-hands-over-send-1'
        });
        expect(await readTail(scenario.sender, 'observe-acknowledged-1', handedOver)).toBe(true);
        expect(
            await readTailForEachChange({
                recipe: scenario.sender,
                from: 'observe-acknowledged-1',
                observation: handedOver,
                changes: [
                    { state: 'expired' },
                    { attemptOutcomes: ['not-ready', 'sent'] },
                    { attemptOutcomes: ['refused', 'not-ready'] },
                    { attemptCarriers: ['ws', 'ws'] },
                    { attemptCarriers: ['rtc', 'rtc'] },
                    { attemptRefusalReasons: ['unsupported'] }
                ]
            })
        ).toEqual([false, false, false, false, false, false]);
        expect(findCommand(scenario.sender, 'assert-congestion-handed-over')).toMatchObject(toCounterRead(scenario.sender, 'handedOver'));
        expect(toCommandNames(scenario.receiver)).toEqual([...RECEIVER_PROLOGUE, 'received-1', 'received-2', 'ws-arrival', 'stats']);
        expect(findCommand(scenario.receiver, 'received-2')).toMatchObject({ count: 2, absent: true });
        const arrival = findCommand(scenario.receiver, 'ws-arrival');
        expect(arrival.kind === 'wait' ? arrival.match.contains : undefined)
            .toContain('"carrier":"ws","outcome":"committed","reason":"admitted"');
    });
});

describe('backpressure-refused', () => {
    const refused = {
        state: 'rejected',
        failure: { kind: 'refused', reason: 'congested' },
        attempts: 0
    };

    it('holds RTC at its watermark with no fallback, so the best-effort send ends rejected congested with no attempt', async () => {
        const scenario = findScenario('rtc', 'backpressure-refused');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...SENDER_PROLOGUE,
            'hold-backpressure',
            'send-1',
            'observe-rejected-1',
            'assert-refused-1',
            'assert-congested-1',
            'assert-no-attempt-1',
            'stats-congestion',
            'assert-congestion-dropped',
            'release-backpressure',
            'stats'
        ]);
        expect(findCommand(scenario.sender, 'hold-backpressure'))
            .toMatchObject(toHold({ carrier: 'rtc', remaining: 'until-cleared', cell: 'backpressure-refused', sendCarrier: 'rtc' }));
        expect(findCommand(scenario.sender, 'release-backpressure'))
            .toMatchObject(toHold({ carrier: 'rtc', remaining: 0, cell: 'backpressure-refused', sendCarrier: 'rtc' }));
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            carrier: 'rtc',
            ack: 'receiver',
            reliability: 'best-effort',
            ttlMs: 30_000
        });
        expect(await readTail(scenario.sender, 'observe-rejected-1', refused)).toBe(true);
        expect(
            await readTailForEachChange({
                recipe: scenario.sender,
                from: 'observe-rejected-1',
                observation: refused,
                changes: [
                    { failure: { kind: 'refused', reason: 'capacity' } },
                    { failure: { kind: 'unroutable', reason: 'congested' } },
                    { attempts: 1 }
                ]
            })
        ).toEqual([false, false, false]);
        expect(findCommand(scenario.sender, 'assert-congestion-dropped')).toMatchObject(toCounterRead(scenario.sender, 'dropped'));
        expect(toCommandNames(scenario.receiver)).toEqual([...RECEIVER_PROLOGUE, 'received-1', 'stats']);
        expect(findCommand(scenario.receiver, 'received-1')).toMatchObject({ count: 1, absent: true, windowMs: 17_000 });
    });
});

describe('backpressure-deferred', () => {
    it.each(CONGESTION_CARRIERS['backpressure-deferred'])(
        'holds %s at its watermark until the page defers the at-least-once send, which then sends on every row and is acknowledged',
        async (carrier) => {
            const scenario = findScenario(carrier, 'backpressure-deferred');
            const held = carrier === 'ws' ? 'ws' : 'rtc';

            expect(toCommandNames(scenario.sender)).toEqual([
                ...SENDER_PROLOGUE,
                'hold-backpressure',
                'send-1',
                'deferral-1',
                'receipts-1',
                'assert-unsubmitted-held',
                'release-backpressure',
                'observe-acknowledged-1',
                'assert-acknowledged-1',
                'assert-sent-only-1',
                'assert-every-row-sent-1',
                'stats-congestion',
                'assert-congestion-deferred',
                'stats'
            ]);
            expect(findCommand(scenario.sender, 'hold-backpressure')).toMatchObject(
                toHold({ carrier: held, remaining: 'until-cleared', cell: 'backpressure-deferred', sendCarrier: carrier })
            );
            // A positive wait on the page's own deferral of this send, so the release follows a written `defer`.
            expect(findCommand(scenario.sender, 'deferral-1')).toEqual({
                kind: 'wait',
                commandId: `${scenario.sender.recipeId}-deferral-1`,
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.outbound_diagnostics',
                    payloadPath: 'data',
                    contains: `"cause":"backpressured","action":"defer","priority":5,"msgId":"{resultCache.${scenario.sender.recipeId}-send-1.value.msgId}"`
                },
                timeoutMs: 10_000
            });
            expect(findCommand(scenario.sender, 'release-backpressure')).toMatchObject(
                toHold({ carrier: held, remaining: 0, cell: 'backpressure-deferred', sendCarrier: carrier })
            );
            expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
                kind: 'messages.send',
                carrier,
                ack: 'receiver',
                reliability: 'at-least-once',
                ttlMs: 30_000
            });
            // One attempt row per next hop of the carrier, each overwritten on its retry: the deferral is the counter's to show.
            const settled = { state: 'acknowledged', attemptOutcomes: ['sent', 'sent', 'sent'] };
            expect(await readTail(scenario.sender, 'observe-acknowledged-1', settled)).toBe(true);
            expect(
                await readTailForEachChange({
                    recipe: scenario.sender,
                    from: 'observe-acknowledged-1',
                    observation: settled,
                    changes: [
                        { state: 'rejected' },
                        { attemptOutcomes: ['refused', 'sent'] },
                        { attemptOutcomes: ['not-ready'] },
                        { attemptOutcomes: ['sent', 'not-ready'] },
                        { attemptOutcomes: [] }
                    ]
                })
            ).toEqual([false, false, false, false, false]);
            expect(findCommand(scenario.sender, 'assert-unsubmitted-held')).toMatchObject({
                kind: 'assert',
                source: `resultCache.${scenario.sender.recipeId}-receipts-1.value.submitted`,
                operator: 'equals',
                expected: false
            });
            expect(await readTail(scenario.sender, 'receipts-1', { state: 'queued', submitted: false })).toBe(true);
            expect(await readTail(scenario.sender, 'receipts-1', { state: 'acknowledged', submitted: true })).toBe(false);
            expect(await readTail(scenario.sender, 'receipts-1', { state: 'queued' })).toBe(false);
            expect(findCommand(scenario.sender, 'assert-congestion-deferred')).toMatchObject(toCounterRead(scenario.sender, 'deferred'));
            expect(toCommandNames(scenario.receiver)).toEqual([...RECEIVER_PROLOGUE, 'received-1', 'stats']);
            expect(findCommand(scenario.receiver, 'received-1')).toMatchObject({ count: 1, absent: false, windowMs: 27_000 });
        }
    );
});
