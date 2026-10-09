import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestAlmUsage,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    AL_VOLATILE_SESSION_MAX_BYTES
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const FAIRNESS_SCENARIO_IDS = ['own-share-under-inbound', 'buffered-track-drains', 'churn-bounded-tracks'] as const;
const SENDER_PROLOGUE = ['ensure-group', 'ensure-member', 'connect', 'storage-counters-connected'] as const;
const RECEIVER_PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;

type FairnessScenarioId = (typeof FAIRNESS_SCENARIO_IDS)[number];

const FAIRNESS_CARRIERS: Readonly<Record<FairnessScenarioId, readonly AlmConformanceCarrier[]>> = {
    'own-share-under-inbound': ['ws', 'rtc'],
    'buffered-track-drains': ['ws', 'rtc'],
    'churn-bounded-tracks': ['rtc']
};

function findScenario(carrier: AlmConformanceCarrier, scenarioId: FairnessScenarioId): AlmConformanceScenario {
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

function isFairnessScenario(scenario: AlmConformanceScenario): boolean {
    return (FAIRNESS_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId);
}

function toRoleRecipes(scenario: AlmConformanceScenario): readonly RallarBlackBoxTestRecipe[] {
    return [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor, scenario.sibling]
        .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined);
}

/** Runs the named `stats` read and the assertions that follow it, the page answering with `ledger`. */
async function readLedgerTail(recipe: RallarBlackBoxTestRecipe, from: string, ledger: RallarBlackBoxTestAlmUsage): Promise<boolean> {
    const start = recipe.commands.findIndex((command) => command.commandId === `${recipe.recipeId}-${from}`);
    const following = recipe.commands.slice(start + 1);
    const end = following.findIndex((command) => command.kind !== 'assert');
    const runtime = createRallarBlackBoxTestRuntime({ readAlmUsage: async () => ledger });
    const commands = [recipe.commands[start], ...following.slice(0, end === -1 ? following.length : end)];
    return (await runtime.execute({ kind: 'recipe.run', recipe: { ...recipe, commands } })).ok;
}

/**
 * Runs the promotion loop on a runtime whose log already holds the inbound `effect-drain` events given. Each digit's
 * wait gets 1 ms instead of its budget: the log is complete before the loop starts.
 */
async function runAfterDrains(command: RallarBlackBoxTestCommand, promotedCounts: readonly number[]): Promise<boolean> {
    if (command.kind !== 'loop') {
        throw new Error(`${command.commandId} is not a loop.`);
    }
    const runtime = createRallarBlackBoxTestRuntime();
    for (const promoted of promotedCounts) {
        runtime.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: { data: { kind: 'effect-drain', lane: 'volatile', claimedCount: 1, deferred: [], promoted } }
        });
    }
    return (await runtime.execute({ ...command, commands: command.commands.map((child) => ({ ...child, timeoutMs: 1 })) })).ok;
}

describe('fairness conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the %s fairness cells on the two agents, in the full tag only, last in their family', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const cells = scenarios.filter(isFairnessScenario)
            .map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags }));

        expect(cells).toEqual(
            FAIRNESS_SCENARIO_IDS.filter((scenarioId) => FAIRNESS_CARRIERS[scenarioId].includes(carrier)).map((scenarioId) => ({
                scenarioId,
                laneFamily: 'two-agent',
                roles: ['sender', 'receiver'],
                tags: ['full']
            }))
        );
        // A cell that reconnects or leaves runs after every cell that keeps its page as the prologue left it.
        const twoAgent = scenarios.filter((scenario) => scenario.laneFamily === 'two-agent').map(({ scenarioId }) => scenarioId);
        expect(twoAgent.slice(twoAgent.length - cells.length)).toEqual(cells.map(({ scenarioId }) => scenarioId));
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s fairness cell identities no other scenario of the run shares, each a valid command', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const others = new Set(
            scenarios.filter((scenario) => !isFairnessScenario(scenario)).flatMap(toRoleRecipes)
                .flatMap((recipe) => recipe.commands.map((command) => command.commandId))
        );
        const own = scenarios.filter(isFairnessScenario).flatMap(toRoleRecipes).flatMap((recipe) => recipe.commands);

        expect(own.map((command) => command.commandId).filter((commandId) => others.has(commandId))).toEqual([]);
        expect(new Set(own.map((command) => command.commandId)).size).toBe(own.length);
        for (const command of own) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('own-share-under-inbound', () => {
    const atTheShare: RallarBlackBoxTestAlmUsage = {
        usage: { admissions: 28, bytes: 30_000, oldestAgeMs: 2_000, tracks: 0 },
        own: { admissions: 2, bytes: 1_200 },
        inbound: { admissions: 26, bytes: 28_800 },
        limits: { ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 20 },
        overloaded: false,
        orderingTracks: 0
    };

    it.each(FAIRNESS_CARRIERS['own-share-under-inbound'])(
        'fills the %s receiver\'s lowered total with arrivals, and its own send is still acknowledged under its share',
        async (carrier) => {
            const scenario = findScenario(carrier, 'own-share-under-inbound');

            expect(toCommandNames(scenario.receiver)).toEqual([
                ...RECEIVER_PROLOGUE,
                'close-before-lowered',
                'connect-lowered',
                'ready',
                'received-1',
                'send-2',
                'observe-acknowledged-2',
                'assert-acknowledged-2',
                'stats-own-share',
                'assert-inbound-at-the-bound',
                'assert-own-under-the-share',
                'assert-not-overloaded',
                'close-before-restored',
                'connect-restored',
                'stats'
            ]);
            // The count bound is lowered to 20, so its own share is 10; the byte bound keeps its constant.
            expect(findCommand(scenario.receiver, 'connect-lowered')).toMatchObject({
                kind: 'rtc.connect',
                rallar: { almVolatileLimits: { maxAdmissions: 20, maxBytes: AL_VOLATILE_SESSION_MAX_BYTES } }
            });
            const restored = findCommand(scenario.receiver, 'connect-restored');
            expect(restored.kind === 'rtc.connect' ? restored.rallar : undefined).not.toHaveProperty('almVolatileLimits');
            expect(findCommand(scenario.receiver, 'received-1')).toMatchObject({ count: 20, absent: false });
            const ownSend = {
                kind: 'messages.send',
                carrier,
                ack: 'receiver',
                reliability: 'at-least-once',
                ttlMs: 30_000
            };
            expect(findCommand(scenario.receiver, 'send-2')).toMatchObject({
                ...ownSend,
                handleId: `alm-${carrier}-own-share-under-inbound-receiver-send-2`
            });
            // A ready message the sender's connect has not yet subscribed for goes unseen, so the receiver repeats it
            // until the flood's first arrival; five repeats and the own send stay under the own share of 10.
            expect(findCommand(scenario.receiver, 'ready')).toEqual({
                kind: 'loop',
                commandId: `${scenario.receiver.recipeId}-ready`,
                count: 5,
                until: 'first-success',
                commands: [
                    expect.objectContaining({
                        ...ownSend,
                        commandId: `${scenario.receiver.recipeId}-ready-send`,
                        handleId: `alm-${carrier}-own-share-under-inbound-receiver-send-1-{loop.index}`
                    }),
                    expect.objectContaining({
                        kind: 'messages.received',
                        commandId: `${scenario.receiver.recipeId}-ready-heard`,
                        count: 1,
                        absent: false,
                        windowMs: 8_000,
                        timeoutMs: 9_000
                    })
                ]
            });
            expect(await readLedgerTail(scenario.receiver, 'stats-own-share', atTheShare)).toBe(true);
            const changes = [
                { inbound: { admissions: 19, bytes: 28_800 } },
                { own: { admissions: 10, bytes: 1_200 } },
                { overloaded: true }
            ];
            const results: boolean[] = [];
            for (const change of changes) {
                results.push(await readLedgerTail(scenario.receiver, 'stats-own-share', { ...atTheShare, ...change }));
            }
            expect(results).toEqual([false, false, false]);

            expect(toCommandNames(scenario.sender)).toEqual([...SENDER_PROLOGUE, 'received-1', 'flood', 'stats']);
            // The ready send arrives only after the receiver's reconnect, so the wait owns one readiness budget.
            expect(findCommand(scenario.sender, 'received-1')).toMatchObject({ count: 1, absent: false, windowMs: 57_000, timeoutMs: 58_000 });
            // The flood asks for no receipt, so the sender's 20 sends are on the wire within seconds, not one ACK apart.
            expect(findCommand(scenario.sender, 'flood')).toEqual({
                kind: 'loop',
                commandId: `${scenario.sender.recipeId}-flood`,
                count: 20,
                intervalMs: 75,
                commands: [expect.objectContaining({
                    kind: 'messages.send',
                    commandId: `${scenario.sender.recipeId}-flood-send`,
                    carrier,
                    ack: 'none',
                    reliability: 'at-least-once',
                    ttlMs: 30_000,
                    handleId: `alm-${carrier}-own-share-under-inbound-send-0-{loop.index}`
                })]
            });
        }
    );
});

describe('buffered-track-drains', () => {
    it.each(FAIRNESS_CARRIERS['buffered-track-drains'])(
        'sends seq 2 to 65 bare and paced on one %s track before seq 1, and the receiver delivers all 65',
        (carrier) => {
            const scenario = findScenario(carrier, 'buffered-track-drains');
            const bufferedSeqs = Array.from({ length: 64 }, (_, offset) => offset + 2);

            // Seq 2 to 65 are bare sends with a 75 ms quiet wait after each; only seq 1 is observed admitted.
            expect(toCommandNames(scenario.sender)).toEqual([
                ...SENDER_PROLOGUE,
                ...bufferedSeqs.flatMap((seq) => [`send-${seq}`, `pause-${seq}`]),
                'send-1',
                'observe-admitted-1',
                'assert-admitted-1',
                'stats'
            ]);
            // No receipt is asked for (the receiver cannot acknowledge seq 2 to 65 before seq 1 arrives), and the
            // sends outlive the cell's own 90 s window; the 30 s lifetime is proven on the real runtime.
            for (const seq of [...bufferedSeqs, 1]) {
                expect(findCommand(scenario.sender, `send-${seq}`)).toMatchObject({
                    reliability: 'at-least-once',
                    ack: 'none',
                    ttlMs: 90_000,
                    orderingKey: `alm-${carrier}-buffered-track-drains`,
                    seq
                });
            }
            for (const seq of bufferedSeqs) {
                expect(findCommand(scenario.sender, `pause-${seq}`)).toMatchObject({ kind: 'wait', absent: true, timeoutMs: 75 });
            }
            expect(findCommand(scenario.receiver, 'received-1')).toMatchObject({ count: 65, absent: false, windowMs: 89_000, timeoutMs: 90_000 });
        }
    );

    it('reads a promoted release on rtc, where the receiver is the hop that buffered the track', async () => {
        const scenario = findScenario('rtc', 'buffered-track-drains');

        expect(toCommandNames(scenario.receiver)).toEqual([...RECEIVER_PROLOGUE, 'received-1', 'promoted-release', 'stats']);
        const promotion = findCommand(scenario.receiver, 'promoted-release');
        expect(promotion).toMatchObject({ kind: 'loop', count: 9, until: 'first-success' });
        expect(await runAfterDrains(promotion, [0, 0, 12, 0])).toBe(true);
        expect(await runAfterDrains(promotion, [0, 9])).toBe(true);
        expect(await runAfterDrains(promotion, [0, 0])).toBe(false);
        expect(toCommandNames(findScenario('ws', 'buffered-track-drains').receiver)).toEqual([...RECEIVER_PROLOGUE, 'received-1', 'stats']);
    });
});

describe('churn-bounded-tracks', () => {
    const atTheCap: RallarBlackBoxTestAlmUsage = {
        usage: { admissions: 300, bytes: 180_000, oldestAgeMs: 9_000, tracks: 0 },
        own: { admissions: 0, bytes: 0 },
        inbound: { admissions: 300, bytes: 180_000 },
        limits: AL_VOLATILE_SESSION_LIMITS,
        overloaded: false,
        orderingTracks: 256
    };

    it('opens 280 tracks with one send each, paced, and leaves; the receiver then holds exactly the cap of ordering snapshots', async () => {
        const scenario = findScenario('rtc', 'churn-bounded-tracks');

        expect(toCommandNames(scenario.sender)).toEqual([
            ...SENDER_PROLOGUE,
            'close-before-raised',
            'connect-raised',
            'open-tracks',
            'observe-last-track',
            'assert-last-track-sent',
            'close-departs',
            'stats'
        ]);
        // The sender's own ledger holds every one of its live tracks; 64 by default. 280 is the cap and a margin.
        expect(findCommand(scenario.sender, 'connect-raised')).toMatchObject({
            rallar: {
                almVolatileLimits: {
                    maxAdmissions: AL_VOLATILE_SESSION_LIMITS.maxAdmissions,
                    maxBytes: AL_VOLATILE_SESSION_LIMITS.maxBytes,
                    maxTracks: 560
                }
            }
        });
        expect(findCommand(scenario.sender, 'open-tracks')).toMatchObject({
            kind: 'loop',
            count: 280,
            intervalMs: 75,
            commands: [{
                kind: 'messages.send',
                reliability: 'at-least-once',
                orderingKey: 'alm-rtc-churn-bounded-tracks-{loop.index}',
                seq: 1,
                handleId: 'alm-rtc-churn-bounded-tracks-send-0-{loop.index}'
            }]
        });
        // The loop names each handle by its index, so the last track's handle ends in 279.
        expect(findCommand(scenario.sender, 'observe-last-track')).toMatchObject({
            kind: 'messages.observe',
            handleId: 'alm-rtc-churn-bounded-tracks-send-0-279',
            state: ['transport-accepted']
        });
        expect(findCommand(scenario.sender, 'close-departs')).toEqual({ kind: 'close', commandId: `${scenario.sender.recipeId}-close-departs` });

        expect(toCommandNames(scenario.receiver)).toEqual([
            ...RECEIVER_PROLOGUE,
            'received-1',
            'snapshots-settle',
            'stats-ordering-tracks',
            'assert-ordering-tracks-within-the-cap',
            'assert-ordering-tracks-at-the-cap',
            'stats'
        ]);
        expect(findCommand(scenario.receiver, 'received-1')).toMatchObject({ count: 280, absent: false, windowMs: 57_000 });
        expect(findCommand(scenario.receiver, 'snapshots-settle')).toMatchObject({ kind: 'wait', absent: true, timeoutMs: 1_000 });
        expect(await readLedgerTail(scenario.receiver, 'stats-ordering-tracks', atTheCap)).toBe(true);
        const results: boolean[] = [];
        for (const orderingTracks of [257, 255, 0]) {
            results.push(await readLedgerTail(scenario.receiver, 'stats-ordering-tracks', { ...atTheCap, orderingTracks }));
        }
        expect(results).toEqual([false, false, false]);
    });
});
