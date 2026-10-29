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

const PACED_SCENARIO_IDS = [
    'paced-latest',
    'paced-newest-n',
    'paced-expiry',
    'paced-capacity',
    'paced-fairness',
    'paced-cancel',
    'paced-isolation-resources'
] as const;
const SENDER_PROLOGUE = ['ensure-group', 'ensure-member', 'connect', 'storage-counters-connected'] as const;
const RECEIVER_PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;
/** Every paced cell's cadence: above CI's lead admission (244 ms) plus a five-send loop's spread (305 ms) with margin. */
const CADENCE_MS = 2_000;
/** The receiver's positive window outside the cell: the 18 s deadline plus the 10 s send budget. */
const SEND_WINDOW_MS = 28_000;
/** Two cadences past the last expected arrival, so a value a later opportunity carried would arrive inside it. */
const NO_FURTHER_ARRIVAL_WINDOW_MS = 4_000;

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

function toPolicy(retainNewest: number, messages: number): ALPublicationPolicy {
    return { cadenceMs: CADENCE_MS, retainNewest, drain: { messages, bytes: 65_536 } };
}

/** The live send every paced cell makes, on `resourceId`. */
function toLiveSend(scenario: AlmConformanceScenario, carrier: AlmConformanceCarrier, publication: ALPublicationPolicy) {
    return {
        kind: 'messages.send',
        carrier,
        typeId: `alm.conformance.${carrier}.${scenario.scenarioKey}`,
        purpose: 'live',
        publication
    };
}

/** Send 0 on the lead's stream, observed admitted within half the cadence, before any other send stages. */
function expectLead(scenario: AlmConformanceScenario, carrier: AlmConformanceCarrier, publication: ALPublicationPolicy): void {
    const lead = findCommand(scenario.sender, 'send-0');
    expect(lead).toMatchObject({
        ...toLiveSend(scenario, carrier, publication),
        resourceId: `alm-${scenario.scenarioKey}`,
        payload: { specimen: 'paced', seq: 0 },
        handleId: `alm-${carrier}-${scenario.scenarioKey}-send-0`
    });
    // The lead's lifetime must outlast its own admission and arrival, which a cell's short lifetime would race.
    expect(lead).not.toHaveProperty('ttlMs');
    // A stage that held send 0 until its lane's first boundary fails the lead observation.
    expect(findCommand(scenario.sender, 'observe-transport-accepted-0')).toMatchObject({
        state: ['transport-accepted'],
        timeoutMs: CADENCE_MS / 2
    });
}

/**
 * A cell's lead and its loop: one template of `burst` iterations, 10 ms apart, naming sends 1 to `burst`, each on the
 * lead's stream or on a resource of its own.
 */
function expectLoopSends(scenario: AlmConformanceScenario, carrier: AlmConformanceCarrier, sends: {
    readonly burst: number;
    readonly publication: ALPublicationPolicy;
    readonly ttlMs: number;
    readonly resourceId: string;
}): void {
    const sender = scenario.sender;
    expectLead(scenario, carrier, sends.publication);
    expect(findCommand(sender, 'paced-sends')).toEqual({
        kind: 'loop',
        commandId: `${sender.recipeId}-paced-sends`,
        count: sends.burst,
        intervalMs: 10,
        commands: [
            expect.objectContaining({
                ...toLiveSend(scenario, carrier, sends.publication),
                resourceId: sends.resourceId,
                ttlMs: sends.ttlMs,
                commandId: `${sender.recipeId}-paced-send`,
                payload: { specimen: 'paced', seq: '{loop.iteration}' },
                handleId: `alm-${carrier}-${scenario.scenarioKey}-send-{loop.iteration}`
            })
        ]
    });
    const send = findLoopSend(sender);
    expect(send).not.toHaveProperty('ack');
    expect(send).not.toHaveProperty('reliability');
}

/** The receiver's count of `count` arrivals spans the boundary that carries the last of them plus one cadence. */
function expectArrivalCount(receiver: RallarBlackBoxTestRecipe, count: number, opportunity: number): void {
    const timeoutMs = SEND_WINDOW_MS + (opportunity + 1) * CADENCE_MS;
    expect(findCommand(receiver, `received-${count}`)).toMatchObject({
        count,
        absent: false,
        windowMs: timeoutMs - 1_000,
        timeoutMs
    });
}

/**
 * The later specimen is absent for half a cadence counted from the arrival the receiver awaited right before (D481): a
 * window opened at the read's start would span the next opportunity's arrival.
 */
function expectNotYet(receiver: RallarBlackBoxTestRecipe, seq: number, afterSeq: number): void {
    expect(findCommand(receiver, `not-yet-seq-${seq}`)).toMatchObject({
        absent: true,
        timeoutFrom: `{resultCache.${receiver.recipeId}-arrived-seq-${afterSeq}.value.event.atEpochMs}`,
        timeoutMs: CADENCE_MS / 2,
        match: { equals: { specimen: 'paced', seq } }
    });
}

const SENDS_PROLOGUE = ['send-0', 'observe-transport-accepted-0', 'assert-transport-accepted-0', 'paced-sends'] as const;
const LEAD_PROLOGUE = ['send-0', 'observe-transport-accepted-0', 'assert-transport-accepted-0'] as const;

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

            expectLoopSends(scenario, carrier, {
                burst: 5,
                publication: toPolicy(1, 8),
                ttlMs: 4_000,
                resourceId: 'alm-paced-latest'
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

    it.each(ALM_CONFORMANCE_CARRIERS)('receives seq 0, then seq 5, and no third arrival within 4 s over %s', (carrier) => {
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
        expectArrivalCount(receiver, 1, 0);
        expectNotYet(receiver, 5, 0);
        expectArrivalCount(receiver, 2, 1);
        expect(findCommand(receiver, 'received-3')).toMatchObject({
            count: 3,
            absent: true,
            windowMs: NO_FURTHER_ARRIVAL_WINDOW_MS
        });
        // A loop writes a string that is only `{loop.iteration}` as the iteration's number, so seq arrives numeric.
        expect(findCommand(receiver, 'arrived-seq-5')).toMatchObject({
            match: {
                kind: 'message',
                payloadPath: 'data.payload',
                equals: { specimen: 'paced', seq: 5 },
                payloadFields: { 'data.typeId': `alm.conformance.${carrier}.paced-latest` }
            }
        });
    });
});

describe('paced-newest-n', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'retains three %s values, displaces the oldest staged, observes the last staged before its opportunity, and all others admitted',
        (carrier) => {
            const scenario = findScenario(carrier, 'paced-newest-n');

            expectLoopSends(scenario, carrier, {
                burst: 4,
                publication: toPolicy(3, 2),
                ttlMs: 6_000,
                resourceId: 'alm-paced-newest-n'
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
        expectArrivalCount(receiver, 1, 0);
        expectNotYet(receiver, 2, 0);
        expectArrivalCount(receiver, 3, 1);
        expectNotYet(receiver, 4, 3);
        expectArrivalCount(receiver, 4, 2);
        expect(findCommand(receiver, 'received-5')).toMatchObject({
            count: 5,
            absent: true,
            windowMs: NO_FURTHER_ARRIVAL_WINDOW_MS
        });
    });
});

describe('paced-expiry', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'admits the lead %s value at once and expires the next before its opportunity, never attempted',
        (carrier) => {
            const scenario = findScenario(carrier, 'paced-expiry');

            expectLoopSends(scenario, carrier, {
                burst: 1,
                publication: toPolicy(1, 8),
                ttlMs: 100,
                resourceId: 'alm-paced-expiry'
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

    it.each(ALM_CONFORMANCE_CARRIERS)('receives one arrival and none within the next 4 s over %s', (carrier) => {
        const receiver = findScenario(carrier, 'paced-expiry').receiver;

        expect(toCommandNames(receiver)).toEqual([
            ...RECEIVER_PROLOGUE,
            'received-1',
            'arrived-seq-0',
            'received-2',
            'stats'
        ]);
        expectArrivalCount(receiver, 1, 0);
        expect(findCommand(receiver, 'received-2')).toMatchObject({
            count: 2,
            absent: true,
            windowMs: NO_FURTHER_ARRIVAL_WINDOW_MS
        });
    });
});

describe('paced-capacity', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'reconnects with two staged values allowed, refuses the %s third on a stream of its own capacity/staged-values with no attempt, admits the two, and restores the limits',
        (carrier) => {
            const scenario = findScenario(carrier, 'paced-capacity');
            const sender = scenario.sender;

            expect(toCommandNames(sender)).toEqual([
                ...SENDER_PROLOGUE,
                'close-before-lowered',
                'connect-lowered',
                ...SENDS_PROLOGUE,
                ...toObserveNames(3, 'rejected', ['failure-kind', 'failure-reason', 'failure-limit', 'attempts']),
                ...[1, 2].flatMap((index) => toObserveNames(index, 'transport-accepted', [])),
                'delivery-settles',
                'close-before-restored',
                'connect-restored',
                'stats'
            ]);
            expect(findCommand(sender, 'connect-lowered')).toMatchObject({
                kind: 'rtc.connect',
                rallar: { almPublicationLimits: { maxStreams: 64, maxStagedValues: 2, maxStagedBytes: 4_194_304 } }
            });
            expect(findCommand(sender, 'connect-restored')).not.toHaveProperty('rallar.almPublicationLimits');
            // A WS send is `transport-accepted` once its socket takes it; a close right after can drop the frame.
            expect(findCommand(sender, 'delivery-settles')).toMatchObject({
                kind: 'wait',
                absent: true,
                timeoutMs: CADENCE_MS
            });
            expectLoopSends(scenario, carrier, {
                burst: 3,
                publication: toPolicy(1, 8),
                ttlMs: 4_000,
                resourceId: 'alm-paced-capacity-{loop.iteration}'
            });
            expect(
                ['kind', 'reason', 'limit'].map((field) => findCommand(sender, `assert-failure-${field}-3`))
            ).toEqual([
                expect.objectContaining({ operator: 'equals', expected: 'refused' }),
                expect.objectContaining({ operator: 'equals', expected: 'capacity' }),
                expect.objectContaining({
                    source: `resultCache.${sender.recipeId}-observe-rejected-3.value.failure.limit`,
                    operator: 'equals',
                    expected: 'staged-values'
                })
            ]);
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'receives seq 0 within the reconnect budget, then seq 1 and 2, and no fourth arrival over %s',
        (carrier) => {
            const receiver = findScenario(carrier, 'paced-capacity').receiver;

            expect(toCommandNames(receiver)).toEqual([
                ...RECEIVER_PROLOGUE,
                'received-1',
                'arrived-seq-0',
                'not-yet-seq-1',
                'received-3',
                'arrived-seq-1',
                'arrived-seq-2',
                'received-4',
                'stats'
            ]);
            // The sender closes and reconnects before its lead, inside one RTC readiness budget.
            expect(findCommand(receiver, 'received-1')).toMatchObject({
                count: 1,
                absent: false,
                windowMs: SEND_WINDOW_MS + CADENCE_MS + 30_000 - 1_000,
                timeoutMs: SEND_WINDOW_MS + CADENCE_MS + 30_000
            });
            expectNotYet(receiver, 1, 0);
            expectArrivalCount(receiver, 3, 1);
            expect(findCommand(receiver, 'received-4')).toMatchObject({
                count: 4,
                absent: true,
                windowMs: NO_FURTHER_ARRIVAL_WINDOW_MS
            });
        }
    );
});

describe('paced-fairness', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'stages two %s values on the lead\'s stream and one on another, one drained per opportunity, all admitted',
        (carrier) => {
            const scenario = findScenario(carrier, 'paced-fairness');
            const publication = toPolicy(2, 1);

            expectLead(scenario, carrier, publication);
            expect(toCommandNames(scenario.sender)).toEqual([
                ...SENDER_PROLOGUE,
                ...LEAD_PROLOGUE,
                'send-1',
                'send-2',
                'send-3',
                ...[1, 3, 2].flatMap((index) => toObserveNames(index, 'transport-accepted', [])),
                'stats'
            ]);
            expect([1, 2, 3].map((index) => findCommand(scenario.sender, `send-${index}`))).toEqual([
                ['alm-paced-fairness', 1],
                ['alm-paced-fairness', 2],
                ['alm-paced-fairness-b', 3]
            ].map(([resourceId, seq]) =>
                expect.objectContaining({
                    ...toLiveSend(scenario, carrier, publication),
                    resourceId,
                    payload: { specimen: 'paced', seq },
                    ttlMs: 8_000
                })
            ));
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'receives seq 0, then 1, then the other stream\'s 3 before 2, and no fifth arrival over %s',
        (carrier) => {
            const receiver = findScenario(carrier, 'paced-fairness').receiver;

            expect(toCommandNames(receiver)).toEqual([
                ...RECEIVER_PROLOGUE,
                'received-1',
                'arrived-seq-0',
                'not-yet-seq-1',
                'received-2',
                'arrived-seq-1',
                'not-yet-seq-3',
                'received-3',
                'arrived-seq-3',
                'not-yet-seq-2',
                'received-4',
                'arrived-seq-2',
                'received-5',
                'stats'
            ]);
            expectArrivalCount(receiver, 1, 0);
            expectArrivalCount(receiver, 2, 1);
            expectArrivalCount(receiver, 3, 2);
            expectArrivalCount(receiver, 4, 3);
            expectNotYet(receiver, 1, 0);
            expectNotYet(receiver, 3, 1);
            expectNotYet(receiver, 2, 3);
            expect(findCommand(receiver, 'received-5')).toMatchObject({
                count: 5,
                absent: true,
                windowMs: NO_FURTHER_ARRIVAL_WINDOW_MS
            });
        }
    );
});

describe('paced-cancel', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'stages two %s values on one stream, cancels the first before its opportunity, never attempted, and admits the second',
        (carrier) => {
            const scenario = findScenario(carrier, 'paced-cancel');
            const sender = scenario.sender;

            expectLoopSends(scenario, carrier, {
                burst: 2,
                publication: toPolicy(2, 8),
                ttlMs: 4_000,
                resourceId: 'alm-paced-cancel'
            });
            expect(toCommandNames(sender)).toEqual([
                ...SENDER_PROLOGUE,
                ...SENDS_PROLOGUE,
                'cancel-1',
                ...toObserveNames(1, 'cancelled', ['attempts']),
                ...toObserveNames(2, 'transport-accepted', []),
                'stats'
            ]);
            expect(findCommand(sender, 'cancel-1')).toMatchObject({
                kind: 'messages.cancel',
                handleId: `alm-${carrier}-paced-cancel-send-1`
            });
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('receives seq 0, then seq 2 alone, and no third arrival over %s', (carrier) => {
        const receiver = findScenario(carrier, 'paced-cancel').receiver;

        expect(toCommandNames(receiver)).toEqual([
            ...RECEIVER_PROLOGUE,
            'received-1',
            'arrived-seq-0',
            'not-yet-seq-2',
            'received-2',
            'arrived-seq-2',
            'received-3',
            'stats'
        ]);
        expectNotYet(receiver, 2, 0);
        expectArrivalCount(receiver, 2, 1);
        expect(findCommand(receiver, 'received-3')).toMatchObject({
            count: 3,
            absent: true,
            windowMs: NO_FURTHER_ARRIVAL_WINDOW_MS
        });
    });
});

describe('paced-isolation-resources', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'stages one %s value on each of two resources of one channel, one retained per stream, and admits both',
        (carrier) => {
            const scenario = findScenario(carrier, 'paced-isolation-resources');

            expectLoopSends(scenario, carrier, {
                burst: 2,
                publication: toPolicy(1, 8),
                ttlMs: 4_000,
                resourceId: 'alm-paced-isolation-resources-{loop.iteration}'
            });
            expect(toCommandNames(scenario.sender)).toEqual([
                ...SENDER_PROLOGUE,
                ...SENDS_PROLOGUE,
                ...[1, 2].flatMap((index) => toObserveNames(index, 'transport-accepted', [])),
                'stats'
            ]);
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('receives seq 0, then 1 and 2, and no fourth arrival over %s', (carrier) => {
        const receiver = findScenario(carrier, 'paced-isolation-resources').receiver;

        expect(toCommandNames(receiver)).toEqual([
            ...RECEIVER_PROLOGUE,
            'received-1',
            'arrived-seq-0',
            'not-yet-seq-1',
            'received-3',
            'arrived-seq-1',
            'arrived-seq-2',
            'received-4',
            'stats'
        ]);
        expectNotYet(receiver, 1, 0);
        expectArrivalCount(receiver, 3, 1);
        expect(findCommand(receiver, 'received-4')).toMatchObject({
            count: 4,
            absent: true,
            windowMs: NO_FURTHER_ARRIVAL_WINDOW_MS
        });
    });
});

describe('paced-isolation-lists', () => {
    function findListsScenario(carrier: AlmConformanceCarrier): AlmConformanceScenario {
        const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
            .find((candidate) => candidate.scenarioId === 'paced-isolation-lists');
        if (scenario === undefined) {
            throw new Error(`Missing paced-isolation-lists over ${carrier}.`);
        }
        return scenario;
    }

    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the %s cell on the three agents, in the smoke tag, with valid commands', (carrier) => {
        const scenario = findListsScenario(carrier);

        expect(scenario).toMatchObject({
            scenarioKey: 'paced-isolation-lists',
            laneFamily: 'three-agent',
            roles: ['sender', 'receiver', 'recipient-b'],
            tags: ['smoke', 'full']
        });
        for (const command of [...scenario.sender.commands, ...scenario.receiver.commands, ...scenario.recipientB!.commands]) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'awaits the receiver\'s leadership, leads to it, then stages a newer value for it and one for recipient-b on the same %s resource, and admits both',
        (carrier) => {
            const scenario = findListsScenario(carrier);
            const sender = scenario.sender;
            const publication = toPolicy(1, 8);

            expect(toCommandNames(sender)).toEqual([
                ...SENDER_PROLOGUE,
                'await-leader',
                ...LEAD_PROLOGUE,
                'send-1',
                'send-2',
                ...[1, 2].flatMap((index) => toObserveNames(index, 'transport-accepted', [])),
                'stats'
            ]);
            expectLead(scenario, carrier, publication);
            expect(findCommand(sender, 'send-0')).toMatchObject({ recipientPeer: 'receiver' });
            expect([1, 2].map((index) => findCommand(sender, `send-${index}`))).toEqual([
                ['receiver', 1],
                ['recipient-b', 2]
            ].map(([recipientPeer, seq]) =>
                expect.objectContaining({
                    ...toLiveSend(scenario, carrier, publication),
                    resourceId: 'alm-paced-isolation-lists',
                    recipientPeer,
                    payload: { specimen: 'paced', seq },
                    ttlMs: 4_000
                })
            ));
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'leads the room as the receiver, which receives seq 0 then 1 and nothing more, and resigns over %s',
        (carrier) => {
            const receiver = findListsScenario(carrier).receiver;

            expect(toCommandNames(receiver)).toEqual([
                ...RECEIVER_PROLOGUE,
                'director-appoint',
                'received-1',
                'arrived-seq-0',
                'not-yet-seq-1',
                'received-2',
                'arrived-seq-1',
                'received-3',
                'director-resign',
                'stats'
            ]);
            expectArrivalCount(receiver, 1, 0);
            expectNotYet(receiver, 1, 0);
            expectArrivalCount(receiver, 2, 1);
            expect(findCommand(receiver, 'received-3')).toMatchObject({
                count: 3,
                absent: true,
                windowMs: NO_FURTHER_ARRIVAL_WINDOW_MS
            });
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('gives recipient-b its own value alone over %s', (carrier) => {
        const recipientB = findListsScenario(carrier).recipientB!;

        expect(toCommandNames(recipientB)).toEqual([
            ...RECEIVER_PROLOGUE,
            'received-1',
            'arrived-seq-2',
            'received-2',
            'stats'
        ]);
        expectArrivalCount(recipientB, 1, 1);
        expect(findCommand(recipientB, 'received-2')).toMatchObject({
            count: 2,
            absent: true,
            windowMs: NO_FURTHER_ARRIVAL_WINDOW_MS
        });
    });
});
