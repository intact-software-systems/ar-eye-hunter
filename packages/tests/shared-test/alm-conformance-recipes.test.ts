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
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestStorageCountersResultValue
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
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

function createConformanceInput(
    carrier: CreateAlmConformanceRecipesInput['carrier']
): CreateAlmConformanceRecipesInput {
    return {
        group,
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

function toConnectCommands(scenarios: readonly AlmConformanceScenario[]): readonly ConnectCommand[] {
    return toRecipes(scenarios).flatMap((recipe) => recipe.commands.filter((command): command is ConnectCommand => command.kind === 'rtc.connect'));
}

/** Every field a scenario's commands match on, so one assertion can prove they share one typeId. */
function toRoutedTypeIds(command: RallarBlackBoxTestCommand): readonly string[] {
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
function toRoutedTopicIds(command: RallarBlackBoxTestCommand): readonly string[] {
    switch (command.kind) {
        case 'rtc.connect':
            return command.rallar?.topicId === undefined ? [] : [String(command.rallar.topicId)];
        case 'messages.send':
            return command.topicId === undefined ? [] : [command.topicId];
        default:
            return [];
    }
}

function toReceivedCommands(scenarios: readonly AlmConformanceScenario[]): readonly ReceivedCommand[] {
    return toRecipes(scenarios).flatMap((recipe) => recipe.commands.filter((command): command is ReceivedCommand => command.kind === 'messages.received'));
}

describe('alm-conformance recipe family', () => {
    it('connects both roles on the carrier transport that subscribes the typed inbound channel', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(createConformanceInput(carrier));
            const connects = toConnectCommands(scenarios);

            expect(connects).toHaveLength(scenarios.length * 2);
            for (const connect of connects) {
                expect(connect.transport).toBe(CARRIER_CONNECT_TRANSPORTS[carrier]);
                expect(connect.rallar?.typeId).toMatch(/^alm\.conformance\./);
            }
        }
    });

    it('scopes every matched field of a scenario to that scenario typeId', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(createConformanceInput(carrier))) {
                const routed = toRecipes([scenario])
                    .flatMap((recipe) => recipe.commands.flatMap(toRoutedTypeIds));

                expect(routed.length).toBeGreaterThan(0);
                expect(new Set(routed)).toEqual(new Set([`alm.conformance.${scenario.scenarioId}`]));
            }
        }
    });

    it('routes every carrier over one WS topic the product admits', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const topicIds = toRecipes(createAlmConformanceRecipes(createConformanceInput(carrier)))
                .flatMap((recipe) => recipe.commands.flatMap(toRoutedTopicIds));

            expect(topicIds.length).toBeGreaterThan(0);
            expect(new Set(topicIds)).toEqual(new Set([CONFORMANCE_TOPIC_ID]));
            expect(validateRallarWsUserTopicId(CONFORMANCE_TOPIC_ID).errors).toEqual([]);
        }
    });

    it('adds the send budget only to positive receive windows', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const received = toReceivedCommands(
                createAlmConformanceRecipes({ ...createConformanceInput(carrier), deadlineMs: 18_000 })
            );

            expect(received.length).toBeGreaterThan(0);
            for (const command of received) {
                expect({ windowMs: command.windowMs, timeoutMs: command.timeoutMs })
                    .toEqual(
                        command.absent
                            ? { windowMs: 17_000, timeoutMs: 18_000 }
                            : { windowMs: 27_000, timeoutMs: 28_000 }
                    );
            }
        }
    });

    it('tags every ws scenario as smoke and keeps ordering-resync full-only', () => {
        expect(
            createAlmConformanceRecipes(createConformanceInput('ws'))
                .filter((scenario) => scenario.tags.includes('smoke'))
                .map((scenario) => scenario.scenarioId)
        ).toEqual(['bounded-rejection', 'deadline-expiry', 'delivery-baseline']);
        expect(
            createAlmConformanceRecipes(createConformanceInput('rtc')).map((scenario) => scenario.tags)
        ).toEqual([
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['full']
        ]);
    });

    it.each([0, 1])('requires positive storage evidence in the delivery baseline when the counter is %i', async (total) => {
        const baseline = createAlmConformanceRecipes(createConformanceInput('ws'))
            .find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const commands = baseline.sender.commands.filter((command) =>
            command.kind === 'storage.counters' ||
            (command.kind === 'assert' && command.source.endsWith('.value.total'))
        );
        const counters: RallarBlackBoxTestStorageCountersResultValue = {
            total,
            byOwner: { 'al-admission': total, 'al-work': 0 },
            byKind: { read: total }
        };
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command) =>
                command.kind === 'storage.counters'
                    ? { status: 'ok', value: counters }
                    : undefined
        });
        const result = await runtime.execute({ kind: 'recipe.run', recipe: { ...baseline.sender, commands } });
        expect(result.ok).toBe(total > 0);
        if (total === 0) {
            expect(runtime.state().failures).toContainEqual(expect.objectContaining({
                error: expect.objectContaining({ code: 'RALLAR_BLACK_BOX_ASSERT_FAILED' })
            }));
        }
    });
});
