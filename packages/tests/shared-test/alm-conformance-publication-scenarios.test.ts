import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const PACED_SCENARIO_IDS = ['paced-latest', 'paced-newest-n', 'paced-expiry'] as const;
const SENDER_PROLOGUE = ['ensure-group', 'ensure-member', 'connect', 'storage-counters-connected'] as const;
const RECEIVER_PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;

type PacedScenarioId = (typeof PACED_SCENARIO_IDS)[number];

function findScenario(carrier: AlmConformanceCarrier, scenarioId: PacedScenarioId): AlmConformanceScenario {
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

/** The one send the cell's loop repeats. */
function findLoopSend(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestCommand {
    const loop = findCommand(recipe, 'paced-sends');
    const [send] = loop.kind === 'loop' ? loop.commands : [];
    if (send === undefined) {
        throw new Error(`${recipe.recipeId} has no paced send loop.`);
    }
    return send;
}

function toObserveNames(index: number, state: string, facts: readonly string[]): readonly string[] {
    return [`observe-${state}-${index}`, `assert-${state}-${index}`, ...facts.map((fact) => `assert-${fact}-${index}`)];
}

/**
 * A cell's sends: the lead send 0, observed admitted before any other send stages, then one loop template of `burst`
 * iterations, 10 ms apart, naming sends 1 to `burst`.
 */
function expectSends(scenario: AlmConformanceScenario, carrier: AlmConformanceCarrier, sends: {
    readonly burst: number;
    /** Half the cadence: a stage that held send 0 until its lane's first boundary fails the lead observation. */
    readonly leadBudgetMs: number;
    readonly publication: ALPublicationPolicy;
    readonly ttlMs?: number;
}): void {
    const sender = scenario.sender;
    const live = {
        kind: 'messages.send',
        carrier,
        typeId: `alm.conformance.${carrier}.${scenario.scenarioKey}`,
        purpose: 'live',
        publication: sends.publication,
        resourceId: `alm-${scenario.scenarioKey}`,
        ...(sends.ttlMs === undefined ? {} : { ttlMs: sends.ttlMs })
    };
    expect(findCommand(sender, 'send-0')).toMatchObject({
        ...live,
        payload: { specimen: 'paced', seq: 0 },
        handleId: `alm-${carrier}-${scenario.scenarioKey}-send-0`
    });
    expect(findCommand(sender, 'observe-transport-accepted-0')).toMatchObject({
        state: ['transport-accepted'],
        timeoutMs: sends.leadBudgetMs
    });
    expect(findCommand(sender, 'paced-sends')).toEqual({
        kind: 'loop',
        commandId: `${sender.recipeId}-paced-sends`,
        count: sends.burst,
        intervalMs: 10,
        commands: [
            expect.objectContaining({
                ...live,
                commandId: `${sender.recipeId}-paced-send`,
                payload: { specimen: 'paced', seq: '{loop.iteration}' },
                handleId: `alm-${carrier}-${scenario.scenarioKey}-send-{loop.iteration}`
            })
        ]
    });
    const send = findLoopSend(sender);
    expect(send).not.toHaveProperty('ack');
    expect(send).not.toHaveProperty('reliability');
    if (sends.ttlMs === undefined) {
        expect(send).not.toHaveProperty('ttlMs');
    }
}

const SENDS_PROLOGUE = ['send-0', 'observe-transport-accepted-0', 'assert-transport-accepted-0', 'paced-sends'] as const;

describe('publication pacing conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the %s paced cells on the two agents, in the smoke tag', (carrier) => {
        const cells = createAlmConformanceRecipes(toConformanceInput(carrier))
            .filter((scenario) => (PACED_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId))
            .map(({ scenarioId, scenarioKey, laneFamily, roles, tags }) => ({ scenarioId, scenarioKey, laneFamily, roles, tags }));

        expect(cells).toEqual(PACED_SCENARIO_IDS.map((scenarioId) => ({
            scenarioId,
            scenarioKey: scenarioId,
            laneFamily: 'two-agent',
            roles: ['sender', 'receiver'],
            tags: ['smoke', 'full']
        })));
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s paced command a valid control shape', (carrier) => {
        for (const scenarioId of PACED_SCENARIO_IDS) {
            const scenario = findScenario(carrier, scenarioId);
            for (const command of [...scenario.sender.commands, ...scenario.receiver.commands]) {
                expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
            }
        }
    });
});

describe('paced-latest', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'admits the lead %s value at once, supersedes the four sent within the cadence but the last, and admits the last',
        (carrier) => {
            const scenario = findScenario(carrier, 'paced-latest');

            expectSends(scenario, carrier, {
                burst: 5,
                leadBudgetMs: 250,
                publication: { cadenceMs: 500, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } }
            });
            expect(toCommandNames(scenario.sender)).toEqual([
                ...SENDER_PROLOGUE,
                ...SENDS_PROLOGUE,
                ...[1, 2, 3, 4].flatMap((index) => toObserveNames(index, 'superseded', ['attempts', 'reason'])),
                ...toObserveNames(5, 'transport-accepted', []),
                'stats'
            ]);
            expect(findCommand(scenario.sender, 'assert-attempts-3')).toMatchObject({
                source: `resultCache.${scenario.sender.recipeId}-observe-superseded-3.value.attempts`,
                operator: 'equals',
                expected: 0
            });
            // The stage's own displacement, not the dispatch path's latest-wins supersedence at admission.
            expect(findCommand(scenario.sender, 'assert-reason-3')).toMatchObject({
                source: `resultCache.${scenario.sender.recipeId}-observe-superseded-3.value.reason`,
                operator: 'contains',
                expected: 'displaced it before its opportunity'
            });
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('receives seq 0, then seq 5, and no third arrival within 3 s over %s', (carrier) => {
        const receiver = findScenario(carrier, 'paced-latest').receiver;

        expect(toCommandNames(receiver)).toEqual([
            ...RECEIVER_PROLOGUE,
            'received-1',
            'arrived-seq-0',
            'not-yet-seq-5',
            'received-2',
            'arrived-seq-5',
            'received-3',
            'stats'
        ]);
        expect(findCommand(receiver, 'received-2')).toMatchObject({ count: 2, absent: false });
        expect(findCommand(receiver, 'received-3')).toMatchObject({ count: 3, absent: true, windowMs: 3_000 });
        // A loop writes a string that is only `{loop.iteration}` as the iteration's number, so seq arrives numeric.
        expect(findCommand(receiver, 'arrived-seq-5')).toMatchObject({
            match: {
                kind: 'message',
                payloadPath: 'data.payload',
                equals: { specimen: 'paced', seq: 5 },
                payloadFields: { 'data.typeId': `alm.conformance.${carrier}.paced-latest` }
            }
        });
        expect(findCommand(receiver, 'not-yet-seq-5')).toMatchObject({
            absent: true,
            timeoutMs: 0,
            match: { equals: { specimen: 'paced', seq: 5 } }
        });
    });
});

describe('paced-newest-n', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'retains three %s values, displaces the oldest staged, observes the last staged before its opportunity, and all others admitted',
        (carrier) => {
            const scenario = findScenario(carrier, 'paced-newest-n');

            expectSends(scenario, carrier, {
                burst: 4,
                leadBudgetMs: 250,
                publication: { cadenceMs: 500, retainNewest: 3, drain: { messages: 2, bytes: 65_536 } },
                ttlMs: 1_500
            });
            expect(toCommandNames(scenario.sender)).toEqual([
                ...SENDER_PROLOGUE,
                ...SENDS_PROLOGUE,
                ...toObserveNames(4, 'staged', []),
                ...toObserveNames(1, 'superseded', ['attempts', 'reason']),
                ...[2, 3, 4].flatMap((index) => toObserveNames(index, 'transport-accepted', [])),
                'stats'
            ]);
            expect(findCommand(scenario.sender, 'observe-staged-4')).toMatchObject({ state: ['staged'] });
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('receives seq 0, then 2 and 3, then 4, and no fifth arrival over %s', (carrier) => {
        const receiver = findScenario(carrier, 'paced-newest-n').receiver;

        expect(toCommandNames(receiver)).toEqual([
            ...RECEIVER_PROLOGUE,
            'received-1',
            'arrived-seq-0',
            'not-yet-seq-2',
            'received-3',
            'arrived-seq-2',
            'arrived-seq-3',
            'not-yet-seq-4',
            'received-4',
            'arrived-seq-4',
            'received-5',
            'stats'
        ]);
        expect(findCommand(receiver, 'received-3')).toMatchObject({ count: 3, absent: false });
        expect(findCommand(receiver, 'received-5')).toMatchObject({ count: 5, absent: true, windowMs: 3_000 });
    });
});

describe('paced-expiry', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'admits the lead %s value at once and expires the next before its opportunity, never attempted',
        (carrier) => {
            const scenario = findScenario(carrier, 'paced-expiry');

            expectSends(scenario, carrier, {
                burst: 1,
                leadBudgetMs: 500,
                publication: { cadenceMs: 1_000, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
                ttlMs: 100
            });
            expect(toCommandNames(scenario.sender)).toEqual([
                ...SENDER_PROLOGUE,
                ...SENDS_PROLOGUE,
                ...toObserveNames(1, 'expired', ['failure-kind', 'attempts']),
                'stats'
            ]);
            expect(findCommand(scenario.sender, 'assert-failure-kind-1')).toMatchObject({
                source: `resultCache.${scenario.sender.recipeId}-observe-expired-1.value.failure.kind`,
                expected: 'expired'
            });
            // The send's own budget is the command's, not its 100 ms lifetime.
            expect(findLoopSend(scenario.sender)).toMatchObject({ timeoutMs: 10_000 });
            expect(findCommand(scenario.sender, 'send-0')).toMatchObject({ timeoutMs: 10_000 });
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('receives one arrival and none within the next 1.5 s over %s', (carrier) => {
        const receiver = findScenario(carrier, 'paced-expiry').receiver;

        expect(toCommandNames(receiver)).toEqual([
            ...RECEIVER_PROLOGUE,
            'received-1',
            'arrived-seq-0',
            'received-2',
            'stats'
        ]);
        expect(findCommand(receiver, 'received-2')).toMatchObject({ count: 2, absent: true, windowMs: 1_500 });
    });
});
