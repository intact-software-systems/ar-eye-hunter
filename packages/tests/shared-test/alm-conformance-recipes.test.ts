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
    RallarBlackBoxTestMessagesReceivedCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRtcConnectCommand,
    RallarBlackBoxTestStorageCountersResultValue
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { validateRallarWsUserTopicId } from '@shared/api/rallar-validation.ts';

const CONFORMANCE_TOPIC_ID = 'room.alm-conformance';

const group = { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' };

const CARRIER_CONNECT_TRANSPORTS = {
    ws: 'messages.ws',
    rtc: 'messages.rtc',
    'rtc-with-ws-fallback': 'messages.rtc'
} as const;

function toConformanceInput(
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

function toConnectCommands(scenarios: readonly AlmConformanceScenario[]): readonly RallarBlackBoxTestRtcConnectCommand[] {
    return toRecipes(scenarios).flatMap((recipe) =>
        recipe.commands.filter((command): command is RallarBlackBoxTestRtcConnectCommand => command.kind === 'rtc.connect')
    );
}

/** Every field a scenario's commands match on, so one assertion can prove they share one typeId. */
function toRoutedTypeIds(command: RallarBlackBoxTestCommand): readonly string[] {
    switch (command.kind) {
        case 'rtc.connect':
            return [String(command.rallar?.typeId)];
        case 'messages.send':
            return 'replayOnCarrier' in command ? [] : [command.typeId];
        case 'messages.received':
            return [command.typeId];
        case 'wait':
            return toAdmissionOutcomeTypeIds(command.match.contains);
        case 'fault.inject':
            return command.match.typeId === undefined ? [] : [command.match.typeId];
        default:
            return [];
    }
}

/** An admission-outcome wait routes on the typeId its `contains` names. */
function toAdmissionOutcomeTypeIds(contains: string | undefined): readonly string[] {
    const typeId = contains?.match(/^"typeId":"([^"]+)"/)?.[1];
    return typeId === undefined ? [] : [typeId];
}

/** The WS topic every command routes over, which the product admits only under `app.` or `room.`. */
function toRoutedTopicIds(command: RallarBlackBoxTestCommand): readonly string[] {
    switch (command.kind) {
        case 'rtc.connect':
            return command.rallar?.topicId === undefined ? [] : [String(command.rallar.topicId)];
        case 'messages.send':
            return 'replayOnCarrier' in command || command.topicId === undefined ? [] : [command.topicId];
        default:
            return [];
    }
}

interface SendShape {
    readonly carrier: string | undefined;
    readonly replayOnCarrier: Readonly<{ handleId: string; carrier: string; }> | undefined;
    readonly handleId: string | undefined;
}

function toSendShapes(commands: readonly RallarBlackBoxTestCommand[]): readonly SendShape[] {
    return commands.flatMap((command): readonly SendShape[] => {
        if (command.kind !== 'messages.send') {
            return [];
        }
        return 'replayOnCarrier' in command
            ? [{ carrier: undefined, replayOnCarrier: command.replayOnCarrier, handleId: undefined }]
            : [{ carrier: command.carrier, replayOnCarrier: undefined, handleId: command.handleId }];
    });
}

function toReceivedCommands(scenarios: readonly AlmConformanceScenario[]): readonly RallarBlackBoxTestMessagesReceivedCommand[] {
    return toRecipes(scenarios).flatMap((recipe) =>
        recipe.commands.filter((command): command is RallarBlackBoxTestMessagesReceivedCommand => command.kind === 'messages.received')
    );
}

describe('alm-conformance recipe family', () => {
    it('connects both roles on the carrier transport that subscribes the typed inbound channel', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
            const connects = toConnectCommands(scenarios);

            for (const recipe of toRecipes(scenarios)) {
                expect(recipe.commands.some((command) => command.kind === 'rtc.connect'), recipe.recipeId).toBe(true);
            }
            for (const connect of connects) {
                expect(connect.transport).toBe(CARRIER_CONNECT_TRANSPORTS[carrier]);
                expect(connect.rallar?.typeId).toMatch(/^alm\.conformance\./);
            }
        }
    });

    it('scopes every matched field of a recipe pair to that pair\'s typeId', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                const routed = toRecipes([scenario])
                    .flatMap((recipe) => recipe.commands.flatMap(toRoutedTypeIds));

                expect(routed.length).toBeGreaterThan(0);
                expect(new Set(routed)).toEqual(new Set([`alm.conformance.${carrier}.${scenario.scenarioKey}`]));
            }
        }
    });

    it('routes every carrier over one WS topic the product admits', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const topicIds = toRecipes(createAlmConformanceRecipes(toConformanceInput(carrier)))
                .flatMap((recipe) => recipe.commands.flatMap(toRoutedTopicIds));

            expect(topicIds.length).toBeGreaterThan(0);
            expect(new Set(topicIds)).toEqual(new Set([CONFORMANCE_TOPIC_ID]));
            expect(validateRallarWsUserTopicId(CONFORMANCE_TOPIC_ID).errors).toEqual([]);
        }
    });

    it('adds the send budget only to positive receive windows; a not-yet-in-sync expiry absence starts at the refusal', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const received = toReceivedCommands(
                createAlmConformanceRecipes({ ...toConformanceInput(carrier), deadlineMs: 18_000 })
            );

            expect(received.length).toBeGreaterThan(0);
            for (const command of received) {
                const afterRefusal = command.commandId?.includes('not-yet-in-sync-expires') === true;
                expect({ windowMs: command.windowMs, timeoutMs: command.timeoutMs })
                    .toEqual(
                        afterRefusal
                            ? { windowMs: 10_000, timeoutMs: 11_000 }
                            : command.absent
                            ? { windowMs: 17_000, timeoutMs: 18_000 }
                            : { windowMs: 27_000, timeoutMs: 28_000 }
                    );
            }
        }
    });

    it('gives carrier acceptance the non-expiring send budget', () => {
        const lifecycle = createAlmConformanceRecipes(toConformanceInput('ws'))
            .find((scenario) => scenario.scenarioId === 'delivery-lifecycle');
        const commands = lifecycle?.sender.commands ?? [];
        const submitted = commands.find((command) =>
            command.kind === 'messages.observe' &&
            command.commandId?.endsWith('observe-transport-accepted-4') === true
        );
        const admitted = commands.find((command) =>
            command.kind === 'messages.observe' &&
            command.commandId?.endsWith('observe-admitted-2') === true
        );

        expect(submitted).toMatchObject({ timeoutMs: 10_000 });
        expect(admitted).toMatchObject({ timeoutMs: 3_000 });
    });

    it('keeps reload and ordering-resync full-only while preserving the smoke scenarios', () => {
        expect(
            createAlmConformanceRecipes(toConformanceInput('ws'))
                .filter((scenario) => scenario.tags.includes('smoke'))
                .map((scenario) => scenario.scenarioId)
        ).toEqual(['bounded-rejection', 'deadline-expiry', 'delivery-baseline', 'delivery-lifecycle']);
        expect(
            createAlmConformanceRecipes(toConformanceInput('rtc-with-ws-fallback'))
                .filter((scenario) => !scenario.tags.includes('smoke'))
                .map((scenario) => scenario.scenarioId)
        ).toEqual([
            'delivery-reload',
            'ordering-resync',
            'cross-carrier-duplicate',
            'cross-carrier-duplicate',
            'not-yet-in-sync',
            'not-yet-in-sync'
        ]);
        expect(
            createAlmConformanceRecipes(toConformanceInput('rtc')).map((scenario) => scenario.tags)
        ).toEqual([
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['full'],
            ['full'],
            ['full'],
            ['full']
        ]);
    });

    it('runs the cross-carrier duplicate in both orders over the fallback carrier only, in the full scope', () => {
        const recipeIds = (carrier: CreateAlmConformanceRecipesInput['carrier']) =>
            toRecipes(
                createAlmConformanceRecipes(toConformanceInput(carrier))
                    .filter((scenario) => scenario.scenarioId === 'cross-carrier-duplicate')
                    .filter((scenario) => !scenario.tags.includes('smoke'))
            ).map((recipe) => recipe.recipeId);

        expect(recipeIds('rtc-with-ws-fallback')).toEqual([
            'alm-rtc-with-ws-fallback-cross-carrier-duplicate-rtc-then-ws-sender',
            'alm-rtc-with-ws-fallback-cross-carrier-duplicate-rtc-then-ws-receiver',
            'alm-rtc-with-ws-fallback-cross-carrier-duplicate-ws-then-rtc-sender',
            'alm-rtc-with-ws-fallback-cross-carrier-duplicate-ws-then-rtc-receiver'
        ]);
        expect(recipeIds('rtc')).toEqual([]);
        expect(recipeIds('ws')).toEqual([]);
    });

    it('replays each order\'s first send on the other carrier and never polls the replayed handle', () => {
        const [rtcThenWs, wsThenRtc] = createAlmConformanceRecipes(toConformanceInput('rtc-with-ws-fallback'))
            .filter((scenario) => scenario.scenarioId === 'cross-carrier-duplicate');
        const sendsOf = (scenario: AlmConformanceScenario | undefined) => toSendShapes(scenario?.sender.commands ?? []);

        expect(sendsOf(rtcThenWs)).toEqual([
            { carrier: 'rtc', replayOnCarrier: undefined, handleId: 'alm-rtc-with-ws-fallback-cross-carrier-duplicate-rtc-then-ws-send-1' },
            {
                carrier: undefined,
                replayOnCarrier: { handleId: 'alm-rtc-with-ws-fallback-cross-carrier-duplicate-rtc-then-ws-send-1', carrier: 'ws' },
                handleId: undefined
            }
        ]);
        expect(sendsOf(wsThenRtc).map((send) => [send.carrier, send.replayOnCarrier?.carrier])).toEqual([
            ['ws', undefined],
            [undefined, 'rtc']
        ]);
        for (const scenario of [rtcThenWs, wsThenRtc]) {
            const observed = (scenario?.sender.commands ?? []).flatMap((command) => command.kind === 'messages.observe' ? command.state : []);
            expect(observed).not.toContain('acknowledged');
            expect(scenario?.receiver.commands.filter((command) => command.kind === 'messages.received'))
                .toMatchObject([{ count: 1, absent: false }, { count: 2, absent: true }]);
        }
    });

    it('requires the receiver to refuse the second copy: over WS in rtc-then-ws, over either carrier in ws-then-rtc', () => {
        const [rtcThenWs, wsThenRtc] = createAlmConformanceRecipes(toConformanceInput('rtc-with-ws-fallback'))
            .filter((scenario) => scenario.scenarioId === 'cross-carrier-duplicate');
        const outcomeWait = (order: string, contains: string) => ({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                payloadPath: 'data',
                contains: `"typeId":"alm.conformance.rtc-with-ws-fallback.cross-carrier-duplicate-${order}",${contains}`
            }
        });
        const tailOf = (scenario: AlmConformanceScenario | undefined, count: number) => (scenario?.receiver.commands ?? []).slice(-count - 1, -1);

        expect(tailOf(rtcThenWs, 1)).toMatchObject([
            outcomeWait('rtc-then-ws', '"carrier":"ws","outcome":"not-handled","reason":"duplicate"')
        ]);
        const latestId = 'alm-rtc-with-ws-fallback-cross-carrier-duplicate-ws-then-rtc-receiver-duplicate-outcome-latest';
        expect(tailOf(wsThenRtc, 3)).toMatchObject([
            { ...outcomeWait('ws-then-rtc', '"carrier":"'), commandId: latestId },
            { kind: 'assert', source: `resultCache.${latestId}.value.event.payload.data.outcome`, operator: 'equals', expected: 'not-handled' },
            { kind: 'assert', source: `resultCache.${latestId}.value.event.payload.data.reason`, operator: 'equals', expected: 'duplicate' }
        ]);
        for (const scenario of [rtcThenWs, wsThenRtc]) {
            expect(scenario?.receiver.commands.some((command) => ['parallel', 'loop'].includes(command.kind))).toBe(false);
        }
    });

    it('runs both not-yet-in-sync variants over the RTC carriers only, in the full scope', () => {
        const recipeIds = (carrier: CreateAlmConformanceRecipesInput['carrier']) =>
            toRecipes(
                createAlmConformanceRecipes(toConformanceInput(carrier))
                    .filter((scenario) => scenario.scenarioId === 'not-yet-in-sync')
                    .filter((scenario) => !scenario.tags.includes('smoke'))
            ).map((recipe) => recipe.recipeId);

        for (const carrier of ['rtc', 'rtc-with-ws-fallback'] as const) {
            expect(recipeIds(carrier)).toEqual([
                `alm-${carrier}-not-yet-in-sync-delivered-after-refresh-sender`,
                `alm-${carrier}-not-yet-in-sync-delivered-after-refresh-receiver`,
                `alm-${carrier}-not-yet-in-sync-expires-sender`,
                `alm-${carrier}-not-yet-in-sync-expires-receiver`
            ]);
        }
        expect(recipeIds('ws')).toEqual([]);
    });

    it('sends above the snapshot, advances the group version, and never polls the handle for acknowledged', () => {
        const [delivered, expires] = createAlmConformanceRecipes(toConformanceInput('rtc'))
            .filter((scenario) => scenario.scenarioId === 'not-yet-in-sync');
        const commandsOf = (scenario: AlmConformanceScenario | undefined) => scenario?.sender.commands ?? [];
        const sendOf = (scenario: AlmConformanceScenario | undefined) => commandsOf(scenario).find((command) => command.kind === 'messages.send');
        const observedOf = (scenario: AlmConformanceScenario | undefined) =>
            commandsOf(scenario).flatMap((command) => command.kind === 'messages.observe' ? [command.state] : []);

        expect(sendOf(delivered)).toMatchObject({
            carrier: 'rtc',
            minSnapshotVersion: { aboveCurrentBy: 1 },
            ack: 'receiver',
            reliability: 'at-least-once',
            ttlMs: 30_000
        });
        const sendIndex = commandsOf(delivered).findIndex((command) => command.kind === 'messages.send');
        const advance = commandsOf(delivered).findIndex((command) =>
            command.commandId === 'alm-rtc-not-yet-in-sync-delivered-after-refresh-sender-advance-group'
        );
        expect(advance).toBeGreaterThan(sendIndex);
        expect(commandsOf(delivered)[advance]).toMatchObject({
            kind: 'http.request',
            request: {
                method: 'PUT',
                path: expect.stringMatching(/\/groups\/room-alm\/members\/\{auth\.clientId\}\/requests\/.+-advance$/),
                body: { status: 'active' }
            }
        });
        expect(observedOf(delivered)).toEqual([AL_DELIVERY_ADMITTED_STATES, ['transport-accepted']]);

        expect(sendOf(expires)).toMatchObject({ carrier: 'rtc', minSnapshotVersion: { absolute: 999_999 }, ack: 'receiver', ttlMs: 7_500 });
        expect(observedOf(expires)).toEqual([AL_DELIVERY_ADMITTED_STATES, ['expired']]);
        expect(commandsOf(expires).some((command) => command.kind === 'http.request' && command.commandId?.endsWith('advance-group'))).toBe(false);
    });

    it('waits for the receiver\'s not-yet-in-sync refusal over RTC, then for one delivery or for absence past expiry', () => {
        const [delivered, expires] = createAlmConformanceRecipes(toConformanceInput('rtc-with-ws-fallback'))
            .filter((scenario) => scenario.scenarioId === 'not-yet-in-sync');
        const refusal = (variant: string) => ({
            kind: 'wait',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                payloadPath: 'data',
                contains: `"typeId":"alm.conformance.rtc-with-ws-fallback.not-yet-in-sync-${variant}",` +
                    '"carrier":"rtc","outcome":"rejected","reason":"not-yet-in-sync'
            },
            timeoutMs: 27_000
        });
        const tailOf = (scenario: AlmConformanceScenario | undefined) => (scenario?.receiver.commands ?? []).slice(-3, -1);

        expect(tailOf(delivered)).toMatchObject([
            refusal('delivered-after-refresh'),
            { kind: 'messages.received', count: 1, absent: false, windowMs: 27_000 }
        ]);
        expect(tailOf(expires)).toMatchObject([
            refusal('expires'),
            { kind: 'messages.received', count: 1, absent: true, windowMs: 10_000 }
        ]);
    });

    it.each([0, 1])('requires positive storage evidence in the delivery baseline when the counter is %i', async (total) => {
        const baseline = createAlmConformanceRecipes(toConformanceInput('ws'))
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
