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

function conformanceInput(
    carrier: CreateAlmConformanceRecipesInput['carrier']
): CreateAlmConformanceRecipesInput {
    return {
        group,
        carrier,
        typeId: 'alm.conformance',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 15_000
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

    it('adds the send budget only to positive receive windows', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const received = receivedCommandsOf(
                createAlmConformanceRecipes({ ...conformanceInput(carrier), deadlineMs: 15_000 })
            );

            expect(received.length).toBeGreaterThan(0);
            for (const command of received) {
                expect({ windowMs: command.windowMs, timeoutMs: command.timeoutMs })
                    .toEqual(command.absent
                        ? { windowMs: 14_000, timeoutMs: 15_000 }
                        : { windowMs: 24_000, timeoutMs: 25_000 });
            }
        }
    });

    it('tags every ws scenario as smoke and keeps ordering-resync full-only', () => {
        expect(
            createAlmConformanceRecipes(conformanceInput('ws'))
                .filter((scenario) => scenario.tags.includes('smoke'))
                .map((scenario) => scenario.scenarioId)
        ).toEqual(['bounded-rejection', 'deadline-expiry', 'delivery-baseline']);
        expect(
            createAlmConformanceRecipes(conformanceInput('rtc')).map((scenario) => scenario.tags)
        ).toEqual([
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['full']
        ]);
    });

    it('gives every ALM command kind a live cell in the family', () => {
        const kinds = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
            recipesOf(createAlmConformanceRecipes(conformanceInput(carrier)))
                .flatMap((recipe) => recipe.commands.map((command) => command.kind))
        );

        expect(new Set(kinds)).toEqual(
            new Set([
                'http.request',
                'rtc.connect',
                'messages.send',
                'messages.observe',
                'messages.cancel',
                'messages.receipts',
                'messages.received',
                'fault.inject',
                'storage.counters',
                'assert',
                'stats'
            ])
        );
    });

    it('asserts the storage counters the delivery-baseline sender reads', () => {
        const baseline = createAlmConformanceRecipes(conformanceInput('ws'))
            .find((scenario) => scenario.scenarioId === 'delivery-baseline');
        const commands = baseline?.sender.commands ?? [];

        expect(commands.map((command) => command.commandId)).toEqual([
            'alm-ws-delivery-baseline-sender-ensure-group',
            'alm-ws-delivery-baseline-sender-ensure-member',
            'alm-ws-delivery-baseline-sender-connect',
            'alm-ws-delivery-baseline-sender-send-1',
            'alm-ws-delivery-baseline-sender-observe-accepted-1',
            'alm-ws-delivery-baseline-sender-receipts-1',
            'alm-ws-delivery-baseline-sender-storage-counters',
            'alm-ws-delivery-baseline-sender-assert-storage-counters-total',
            'alm-ws-delivery-baseline-sender-stats'
        ]);
        expect(commands.at(-2)).toMatchObject({
            kind: 'assert',
            source: 'resultCache.alm-ws-delivery-baseline-sender-storage-counters.value.total',
            operator: 'gt',
            expected: 0
        });
    });

    it('cancels the rejected bounded-rejection handle and observes the cancelled state', () => {
        const rejection = createAlmConformanceRecipes(conformanceInput('ws'))
            .find((scenario) => scenario.scenarioId === 'bounded-rejection');

        expect((rejection?.sender.commands ?? []).slice(-4).map((command) => command.commandId)).toEqual([
            'alm-ws-bounded-rejection-sender-observe-rejected-1',
            'alm-ws-bounded-rejection-sender-cancel-1',
            'alm-ws-bounded-rejection-sender-observe-cancelled-1',
            'alm-ws-bounded-rejection-sender-stats'
        ]);
    });
});
