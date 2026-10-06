import { describe, expect, it } from 'vitest';

import {
    ALM_CONFORMANCE_CARRIERS,
    ALM_CONFORMANCE_SINGLE_HOP_CARRIERS
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { CreateAlmConformanceRecipesInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const OUTBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.outbound_diagnostics';
const INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';
const STORAGE_TOPIC = 'rallar.browser.alm.storage';
const REPAIR_SCENARIO_IDS = ['ordering-gap-repair', 'repair-exhausted'] as const;

type Carrier = (typeof ALM_CONFORMANCE_CARRIERS)[number];
type RepairScenarioId = (typeof REPAIR_SCENARIO_IDS)[number] | 'ordering-resync';

function findScenario(
    input: CreateAlmConformanceRecipesInput,
    scenarioId: RepairScenarioId
): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(input).find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${input.carrier}.`);
    }
    return scenario;
}

function toRecipes(scenario: AlmConformanceScenario): readonly RallarBlackBoxTestRecipe[] {
    return [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor]
        .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined);
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

/** Every identity a scenario mints that a run shares with the other scenarios of its `{runId}`. */
function toMintedIdentities(scenario: AlmConformanceScenario): readonly string[] {
    return toRecipes(scenario).flatMap((recipe) =>
        recipe.commands.flatMap((command) => [
            `command:${command.commandId}`,
            ...(command.kind === 'fault.inject' ? [`fault:${command.faultId}`] : []),
            ...(command.kind === 'messages.send' && !('replayOnCarrier' in command) ? [`handle:${command.handleId}`] : []),
            ...(command.kind === 'http.request' ? [`request:${command.request.path}`] : [])
        ])
    );
}

/** The fault carriers a cell holds, in the order the hold commands name them. */
function toHoldCarriers(carrier: Carrier): readonly string[] {
    return carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [carrier];
}

function toHoldNames(carrier: Carrier, name: string): readonly string[] {
    return toHoldCarriers(carrier).map((faultCarrier) => `${name}-${faultCarrier}`);
}

/** The sender's steps both repair cells share: three ordered sends, the second held by its own message id. */
function toHeldSecondSendNames(carrier: Carrier): readonly string[] {
    return [
        'send-1',
        'observe-admitted-1',
        'assert-admitted-1',
        'observe-transport-accepted-1',
        'assert-sent-1',
        ...toHoldNames(carrier, 'hold'),
        'send-2',
        'observe-admitted-2',
        'assert-admitted-2',
        ...toHoldNames(carrier, 'hold-message-2'),
        ...toHoldNames(carrier, 'release'),
        'send-3',
        'observe-admitted-3',
        'assert-admitted-3',
        'gap-nack'
    ];
}

describe('ordering repair conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'catalogs the exhausted repair over %s, and the gap repair where one hop carries the track, in the full tag only',
        (carrier) => {
            const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier))
                .filter((scenario) => (REPAIR_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId));
            const gapRepair = { scenarioId: 'ordering-gap-repair', laneFamily: 'two-agent', roles: ['sender', 'receiver'], tags: ['full'] };

            expect(scenarios.map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags })))
                .toEqual([
                    ...(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS.includes(carrier) ? [gapRepair] : []),
                    { scenarioId: 'repair-exhausted', laneFamily: 'two-agent', roles: ['sender', 'receiver'], tags: ['full'] }
                ]);
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s repair scenario identities no other scenario of the run shares', (carrier) => {
        const scenarios = createAlmConformanceRecipes({ ...toConformanceInput(carrier), recoveryOwner: 'record' });
        const isRepair = (scenario: AlmConformanceScenario) => (REPAIR_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId);
        const others = new Set(scenarios.filter((scenario) => !isRepair(scenario)).flatMap(toMintedIdentities));
        const own = scenarios.filter(isRepair).flatMap(toMintedIdentities);

        expect(own.filter((identity) => others.has(identity))).toEqual([]);
        for (const command of scenarios.flatMap(toRecipes).flatMap((recipe) => recipe.commands)) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('ordering-gap-repair', () => {
    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)(
        'holds the %s sender\'s second frame, reads the range NACK and the repair dispatch, releases it and delivers all three in order',
        (carrier) => {
            const { sender, receiver } = findScenario(toConformanceInput(carrier), 'ordering-gap-repair');

            expect(toCommandNames(sender)).toEqual([
                'ensure-group',
                'ensure-member',
                'connect',
                'storage-counters-connected',
                ...toHeldSecondSendNames(carrier),
                'repair-dispatch-2',
                ...toHoldNames(carrier, 'release-message-2'),
                'stats'
            ]);
            expect(toCommandNames(receiver)).toEqual([
                'ensure-group',
                'ensure-member',
                'connect',
                'received-1',
                'received-3',
                ...(carrier === 'rtc' ? ['release-buffered-track', 'release-buffered-3'] : []),
                'received-4',
                'stats'
            ]);
        }
    );

    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)('sends three %s at-least-once messages on one ordering key, in sequence', (carrier) => {
        const { sender } = findScenario(toConformanceInput(carrier), 'ordering-gap-repair');
        const orderingKey = `alm-${carrier}-ordering-gap-repair`;

        expect([1, 2, 3].map((seq) => findCommand(sender, `send-${seq}`))).toMatchObject([1, 2, 3].map((seq) => ({
            kind: 'messages.send',
            carrier,
            reliability: 'at-least-once',
            orderingKey,
            seq,
            payload: { marker: 'ordering-gap-repair', seq }
        })));
        expect(findCommand(sender, 'assert-sent-1')).toMatchObject({
            kind: 'assert',
            source: `resultCache.alm-${carrier}-ordering-gap-repair-sender-observe-transport-accepted-1.value.state`,
            operator: 'matches',
            expected: '^(transport-accepted|acknowledged)$'
        });
    });

    it('releases the held second send by the same message id once the range NACK is admitted and the repair dispatched', () => {
        const { sender } = findScenario(toConformanceInput('ws'), 'ordering-gap-repair');

        expect(findCommand(sender, 'release-message-2-ws')).toMatchObject({
            kind: 'fault.inject',
            faultId: 'hold-message-2-ws-alm.conformance.ws.ordering-gap-repair',
            match: { msgId: '{resultCache.alm-ws-ordering-gap-repair-sender-send-2.value.msgId}' },
            action: 'not-ready',
            remaining: 0
        });
    });

    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)('reads the %s range NACK the third send reveals, committed at the sender, before the release', (carrier) => {
        const { sender } = findScenario(toConformanceInput(carrier), 'ordering-gap-repair');

        expect(findCommand(sender, 'gap-nack')).toEqual({
            kind: 'wait',
            commandId: `alm-${carrier}-ordering-gap-repair-sender-gap-nack`,
            match: {
                kind: 'diagnostic',
                topic: OUTBOUND_DIAGNOSTICS_TOPIC,
                payloadPath: 'data',
                contains: '"typeId":"al.control.nack.v2",' +
                    `"targetMsgId":"{resultCache.alm-${carrier}-ordering-gap-repair-sender-send-3.value.msgId}","outcome":"committed"`
            },
            timeoutMs: 27_000
        });
    });

    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)(
        'reads the %s repair dispatch of the held second send, committed at the sender, before the release',
        (carrier) => {
            const { sender } = findScenario(toConformanceInput(carrier), 'ordering-gap-repair');

            expect(findCommand(sender, 'repair-dispatch-2')).toEqual({
                kind: 'wait',
                commandId: `alm-${carrier}-ordering-gap-repair-sender-repair-dispatch-2`,
                match: {
                    kind: 'diagnostic',
                    topic: OUTBOUND_DIAGNOSTICS_TOPIC,
                    payloadPath: 'data',
                    contains: `"msgId":"{resultCache.alm-${carrier}-ordering-gap-repair-sender-send-2.value.msgId}",` +
                        `"typeId":"alm.conformance.${carrier}.ordering-gap-repair","origin":"repair"`
                },
                timeoutMs: 27_000
            });
        }
    );

    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)('proves the %s receiver delivered three and never a fourth', (carrier) => {
        const { receiver } = findScenario(toConformanceInput(carrier), 'ordering-gap-repair');

        expect(findCommand(receiver, 'received-1')).toMatchObject({ kind: 'messages.received', count: 1, absent: false });
        expect(findCommand(receiver, 'received-3')).toMatchObject({ kind: 'messages.received', count: 3, absent: false });
        expect(findCommand(receiver, 'received-4')).toMatchObject({ kind: 'messages.received', count: 4, absent: true });
    });

    it('proves the rtc receiver buffered the third send and released it behind the second; over ws the relay is that hop', () => {
        const { receiver } = findScenario(toConformanceInput('rtc'), 'ordering-gap-repair');

        // The sender's peer id sits inside the URI-encoded track key of the effect id, so the track and the sequence are two waits.
        expect(findCommand(receiver, 'release-buffered-track')).toEqual({
            kind: 'wait',
            commandId: 'alm-rtc-ordering-gap-repair-receiver-release-buffered-track',
            match: {
                kind: 'diagnostic',
                topic: INBOUND_DIAGNOSTICS_TOPIC,
                payloadPath: 'data',
                contains: '"effectId":"release:alm-rtc-ordering-gap-repair%3A'
            },
            timeoutMs: 27_000
        });
        expect(findCommand(receiver, 'release-buffered-3')).toEqual({
            kind: 'wait',
            commandId: 'alm-rtc-ordering-gap-repair-receiver-release-buffered-3',
            match: {
                kind: 'diagnostic',
                topic: INBOUND_DIAGNOSTICS_TOPIC,
                payloadPath: 'data',
                contains: '%3A0:3","msgId":null,"typeId":null,"subjectMsgId":null,"payloadKind":"release-buffered"'
            },
            timeoutMs: 27_000
        });
        expect(toCommandNames(findScenario(toConformanceInput('ws'), 'ordering-gap-repair').receiver))
            .not.toContain('release-buffered-track');
    });
});

describe('repair-exhausted', () => {
    it('holds the second send by the message id its send returned, on each carrier the cell can hold', () => {
        const { sender } = findScenario(toConformanceInput('rtc-with-ws-fallback'), 'repair-exhausted');
        const msgId = '{resultCache.alm-rtc-with-ws-fallback-repair-exhausted-sender-send-2.value.msgId}';
        const typeId = 'alm.conformance.rtc-with-ws-fallback.repair-exhausted';

        expect(findCommand(sender, 'hold-message-2-rtc')).toMatchObject({
            kind: 'fault.inject',
            faultId: `hold-message-2-rtc-${typeId}`,
            carrier: 'rtc',
            match: { msgId },
            action: 'drop',
            remaining: 'until-cleared'
        });
        expect(findCommand(sender, 'hold-message-2-ws')).toMatchObject({
            kind: 'fault.inject',
            faultId: `hold-message-2-ws-${typeId}`,
            carrier: 'ws',
            match: { msgId },
            action: 'not-ready',
            remaining: 'until-cleared'
        });
        expect(findCommand(sender, 'release-rtc')).toMatchObject({
            kind: 'fault.inject',
            faultId: `hold-rtc-${typeId}`,
            match: { typeId },
            remaining: 0
        });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('keeps the %s hold through a second gap report and reads the exhausted handle', (carrier) => {
        const { sender, receiver } = findScenario(toConformanceInput(carrier), 'repair-exhausted');

        expect(toCommandNames(sender)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'storage-counters-connected',
            ...toHeldSecondSendNames(carrier),
            'send-4',
            'observe-admitted-4',
            'assert-admitted-4',
            'observe-failed-2',
            'assert-skipped-2',
            'assert-repair-exhausted-2',
            'stats'
        ]);
        expect(toCommandNames(receiver)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'received-1',
            'received-2',
            'stats'
        ]);
        expect(sender.commands.filter((command) => command.kind === 'fault.inject' && command.remaining === 0).map((command) => command.commandId))
            .toEqual(toHoldNames(carrier, 'release').map((name) => `alm-${carrier}-repair-exhausted-sender-${name}`));
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('reads the %s second send skipped as repair-exhausted on its handle', (carrier) => {
        const { sender } = findScenario(toConformanceInput(carrier), 'repair-exhausted');
        const observation = `resultCache.alm-${carrier}-repair-exhausted-sender-observe-failed-2.value`;

        expect(findCommand(sender, 'send-4')).toMatchObject({
            kind: 'messages.send',
            reliability: 'at-least-once',
            orderingKey: `alm-${carrier}-repair-exhausted`,
            seq: 4
        });
        expect(findCommand(sender, 'observe-failed-2')).toMatchObject({
            kind: 'messages.observe',
            handleId: `alm-${carrier}-repair-exhausted-send-2`,
            state: ['failed'],
            timeoutMs: 10_000
        });
        expect(findCommand(sender, 'assert-skipped-2')).toMatchObject({
            kind: 'assert',
            source: `${observation}.failure.kind`,
            operator: 'equals',
            expected: 'skipped'
        });
        expect(findCommand(sender, 'assert-repair-exhausted-2')).toMatchObject({
            kind: 'assert',
            source: `${observation}.failure.reason`,
            operator: 'equals',
            expected: 'repair-exhausted'
        });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('proves the %s receiver delivered the first send only', (carrier) => {
        const { receiver } = findScenario(toConformanceInput(carrier), 'repair-exhausted');

        expect(findCommand(receiver, 'received-1')).toMatchObject({ kind: 'messages.received', count: 1, absent: false });
        expect(findCommand(receiver, 'received-2')).toMatchObject({ kind: 'messages.received', count: 2, absent: true });
    });
});

describe('ordering-resync observes the recovery owner', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('installs the recording owner on the %s receiver\'s connect when the lane records', (carrier) => {
        const { sender, receiver } = findScenario({ ...toConformanceInput(carrier), recoveryOwner: 'record' }, 'ordering-resync');

        expect(findCommand(receiver, 'connect')).toMatchObject({ kind: 'rtc.connect', rallar: { recoveryOwner: 'record' } });
        expect(findCommand(sender, 'connect')).not.toMatchObject({ rallar: { recoveryOwner: 'record' } });
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)('waits for the %s receiver\'s owner invocation and its cursor, before the absence proof', (carrier) => {
        const { receiver } = findScenario({ ...toConformanceInput(carrier), recoveryOwner: 'record' }, 'ordering-resync');

        expect(toCommandNames(receiver)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'received-1',
            'resync-outcome',
            'recovery-owner-invoked',
            'recovery-owner-cursor',
            'received-2',
            'stats'
        ]);
        expect(findCommand(receiver, 'recovery-owner-invoked')).toEqual({
            kind: 'wait',
            commandId: `alm-${carrier}-ordering-resync-receiver-recovery-owner-invoked`,
            match: {
                kind: 'diagnostic',
                topic: STORAGE_TOPIC,
                payloadPath: 'data',
                contains: `"kind":"recovery-owner-invoked","orderingKey":"alm-${carrier}-ordering-resync",`
            },
            timeoutMs: 27_000
        });
        // The sender's peer id sits between the key and the cursor in the emitted order, so the cursor is its own wait.
        expect(findCommand(receiver, 'recovery-owner-cursor')).toEqual({
            kind: 'wait',
            commandId: `alm-${carrier}-ordering-resync-receiver-recovery-owner-cursor`,
            match: {
                kind: 'diagnostic',
                topic: STORAGE_TOPIC,
                payloadPath: 'data',
                contains: '"lastContiguousSeq":1,"expectedSeq":2,"observedSeq":300,"carrier":"rtc"}'
            },
            timeoutMs: 27_000
        });
    });

    it('leaves the ws receiver without an owner wait: the relay refuses the gapped send before the receiver sees it', () => {
        const { receiver } = findScenario({ ...toConformanceInput('ws'), recoveryOwner: 'record' }, 'ordering-resync');

        expect(toCommandNames(receiver)).toEqual(['ensure-group', 'ensure-member', 'connect', 'received-1', 'received-2', 'stats']);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('leaves the %s catalog as recorded when the lane names no owner', (carrier) => {
        const { receiver } = findScenario(toConformanceInput(carrier), 'ordering-resync');

        expect(findCommand(receiver, 'connect')).not.toMatchObject({ rallar: { recoveryOwner: 'record' } });
        expect(toCommandNames(receiver)).not.toContain('recovery-owner-invoked');
    });
});
