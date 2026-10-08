import {
    describe,
    expect,
    it
} from 'vitest';

import { NON_EXPIRING_SEND_TIMEOUT_MS, RESPONSE_MARGIN_MS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import type { CreateAlmConformanceRecipesInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toConnectCommand } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts';
import {
    createAlmConformanceRecipes,
    toAlmConformanceRoleRecipe,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestAssertCommand,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesReceivedCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { validateRallarWsUserTopicId } from '@shared/api/rallar-validation.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const CONFORMANCE_TOPIC_ID = 'room.alm-conformance';
/** A `room.` topic makes any send room-scoped, so the world cell publishes under `app.`. */
const WORLD_TOPIC_ID = 'app.alm-conformance.world';
const INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';
/** Matches the lane's deadline (`hetzner-alm-manifest-entries.ts`'s `ALM_CONFORMANCE_DEADLINE_MS`). */
const ALM_CONFORMANCE_DEADLINE_MS = 18_000;

/** The three-peer scenarios run on three agents: an origin and two distinguishable recipients (D45). */
const RECEIPTED_AUDIENCE_KEYS_BY_CARRIER = {
    ws: ['aggregated-receipt', 'missing-recipient-retry', 'frozen-audience-membership'],
    rtc: ['aggregated-receipt', 'missing-recipient-retry', 'unknown-ack-version', 'frozen-audience-membership'],
    'rtc-with-ws-fallback': ['aggregated-receipt', 'missing-recipient-retry', 'unknown-ack-version', 'frozen-audience-membership']
} as const;

/** The membership fence runs where one hop judges the roster; its rejection only where the server does. */
const MEMBERSHIP_FENCE_KEYS_BY_CARRIER = {
    ws: ['fenced-delivery', 'fenced-catch-up', 'fenced-rejection'],
    rtc: ['fenced-delivery', 'fenced-catch-up'],
    'rtc-with-ws-fallback': []
} as const;

/** The leader cells run on the three agents, the receiver appointed the room's director; the list refusal only over ws. */
const LEADER_ACK_KEYS_BY_CARRIER = {
    ws: ['leader-confirms', 'no-leader-refused', 'leader-outside-list'],
    rtc: ['leader-confirms', 'no-leader-refused'],
    'rtc-with-ws-fallback': ['leader-confirms']
} as const;

/** The claim cells run on the three agents: the two WS cells where a strategy allows WS, the refusal on rtc alone. */
const CLAIM_KEYS_BY_CARRIER = {
    ws: ['claim-first-wins', 'claim-expires-reclaims'],
    rtc: ['claim-refused-on-rtc'],
    'rtc-with-ws-fallback': ['claim-first-wins']
} as const;

/** The volatile-bound cells run in the addressed family on every carrier, under the full tag only. */
const VOLATILE_BOUND_KEYS = ['capacity', 'capacity-age', 'capacity-tracks'] as const;

/** The audiences run on every carrier, on the sender's principal twice and another principal once. */
const AUDIENCE_KEYS = ['principal-delivery', 'fixed-list-delivery', 'world-routing'] as const;

const CARRIER_CONNECT_TRANSPORTS = {
    ws: 'messages.ws',
    rtc: 'messages.rtc',
    'rtc-with-ws-fallback': 'messages.rtc'
} as const;

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
            return command.match.topic === INBOUND_DIAGNOSTICS_TOPIC ? toAdmissionOutcomeTypeIds(command.match.contains) : [];
        case 'fault.inject':
            return command.carrier === 'storage' || command.match.typeId === undefined ? [] : [command.match.typeId];
        default:
            return [];
    }
}

/** An admission-outcome wait routes on the typeId its `contains` names; a control is scoped by its own protocol id. */
function toAdmissionOutcomeTypeIds(contains: string | undefined): readonly string[] {
    const typeId = contains?.match(/^"typeId":"([^"]+)"/)?.[1];
    return typeId === undefined || typeId.startsWith('al.control.') ? [] : [typeId];
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

const SCENARIO_KEYS_BY_CARRIER = {
    ws: [
        'volatile-default',
        'bounded-rejection',
        'deadline-expiry',
        'delivery-baseline',
        'delivery-lifecycle',
        'durable-opt-in',
        'delivery-reload',
        'storage-unavailable',
        'checkpoint-recovery',
        'checkpoint-lag',
        'ordering-resync',
        'ordering-gap-repair',
        'repair-exhausted',
        'ws-unicast-receipt',
        'server-command',
        'capacity',
        'capacity-age',
        'capacity-tracks',
        'backpressure-deferred',
        'own-share-under-inbound',
        'buffered-track-drains'
    ],
    rtc: [
        'volatile-default',
        'bounded-rejection',
        'deadline-expiry',
        'delivery-baseline',
        'delivery-lifecycle',
        'durable-opt-in',
        'delivery-reload',
        'storage-unavailable',
        'checkpoint-recovery',
        'checkpoint-lag',
        'ordering-resync',
        'ordering-gap-repair',
        'repair-exhausted',
        'not-yet-in-sync-expires',
        'ws-unicast-receipt',
        'capacity',
        'capacity-age',
        'capacity-tracks',
        'backpressure-refused',
        'backpressure-deferred',
        'own-share-under-inbound',
        'buffered-track-drains',
        'churn-bounded-tracks'
    ],
    'rtc-with-ws-fallback': [
        'volatile-default',
        'bounded-rejection',
        'deadline-expiry',
        'delivery-baseline',
        'delivery-lifecycle',
        'durable-opt-in',
        'delivery-reload',
        'storage-unavailable',
        'checkpoint-recovery',
        'checkpoint-lag',
        'ordering-resync',
        'repair-exhausted',
        'cross-carrier-duplicate-rtc-then-ws',
        'cross-carrier-duplicate-ws-then-rtc',
        'not-yet-in-sync-expires',
        'fallback-within-deadline',
        'receipt-exhausted-fallback',
        'no-fallback-after-deadline',
        'ws-unicast-receipt',
        'unicast-fallback',
        'capacity',
        'capacity-age',
        'capacity-tracks',
        'backpressure-hands-over',
        'own-share-under-inbound'
    ]
} as const;

function toAllRoleRecipes(scenarios: readonly AlmConformanceScenario[]): readonly RallarBlackBoxTestRecipe[] {
    return scenarios.flatMap((scenario) => [
        scenario.sender,
        scenario.receiver,
        ...(scenario.recipientB ? [scenario.recipientB] : []),
        ...(scenario.successor ? [scenario.successor] : []),
        ...(scenario.sibling ? [scenario.sibling] : [])
    ]);
}

describe('alm-conformance recipe family', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('names each %s scenario the lane family whose agents it needs', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));

        for (const scenario of scenarios) {
            expect(scenario.laneFamily === 'three-agent', scenario.scenarioKey).toBe(scenario.roles.includes('recipient-b'));
            expect(scenario.laneFamily === 'same-context', scenario.scenarioKey).toBe(scenario.roles.includes('successor'));
            expect(scenario.laneFamily === 'same-principal', scenario.scenarioKey).toBe(scenario.roles.includes('sibling'));
        }
        expect(scenarios.filter((scenario) => scenario.laneFamily === 'addressed').map(({ scenarioId }) => scenarioId))
            .toEqual(
                carrier === 'ws'
                    ? ['ws-unicast-receipt', 'server-command', ...VOLATILE_BOUND_KEYS]
                    : carrier === 'rtc'
                    ? ['ws-unicast-receipt', ...VOLATILE_BOUND_KEYS]
                    : ['ws-unicast-receipt', 'unicast-fallback', ...VOLATILE_BOUND_KEYS]
            );
    });

    it('generates the pinned recipe list for every carrier, in scenario order', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            expect(toAllRoleRecipes(createAlmConformanceRecipes(toConformanceInput(carrier))).map((recipe) => recipe.recipeId), carrier)
                .toEqual([
                    ...SCENARIO_KEYS_BY_CARRIER[carrier].flatMap((key) => [`alm-${carrier}-${key}-sender`, `alm-${carrier}-${key}-receiver`]),
                    ...[...RECEIPTED_AUDIENCE_KEYS_BY_CARRIER[carrier], ...MEMBERSHIP_FENCE_KEYS_BY_CARRIER[carrier]].flatMap((key) =>
                        ['sender', 'receiver', 'recipient-b'].map((role) => `alm-${carrier}-${key}-${role}`)
                    ),
                    ...AUDIENCE_KEYS.flatMap((key) => ['sender', 'receiver', 'sibling'].map((role) => `alm-${carrier}-${key}-${role}`)),
                    ...[...LEADER_ACK_KEYS_BY_CARRIER[carrier], ...CLAIM_KEYS_BY_CARRIER[carrier]].flatMap((key) =>
                        ['sender', 'receiver', 'recipient-b'].map((role) => `alm-${carrier}-${key}-${role}`)
                    ),
                    ...['sender', 'receiver', 'successor'].map((role) => `alm-${carrier}-durable-takeover-${role}`),
                    ...(carrier === 'rtc-with-ws-fallback'
                        ? []
                        : ['sender', 'receiver', 'successor'].map((role) => `alm-${carrier}-flush-on-hide-${role}`))
                ]);
        }
    });

    it('declares recipient-b on the receipted-audience, membership fence, leader and claim scenarios, successor on durable-takeover and flush-on-hide and sibling on the audiences only; every other scenario keeps one sender and one receiver', () => {
        const threeAgentIds = [
            'receipted-audience',
            'fenced-delivery',
            'fenced-catch-up',
            'fenced-rejection',
            'leader-confirms',
            'no-leader-refused',
            'leader-outside-list',
            'claim-first-wins',
            'claim-expires-reclaims',
            'claim-refused-on-rtc'
        ];
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                const threeRoles = threeAgentIds.includes(scenario.scenarioId);
                const twoPages = scenario.scenarioId === 'durable-takeover' || scenario.scenarioId === 'flush-on-hide';
                const twoSessions = (AUDIENCE_KEYS as readonly string[]).includes(scenario.scenarioId);
                expect(scenario.roles, scenario.scenarioKey).toEqual(
                    threeRoles
                        ? ['sender', 'receiver', 'recipient-b']
                        : twoPages
                        ? ['sender', 'receiver', 'successor']
                        : twoSessions
                        ? ['sender', 'receiver', 'sibling']
                        : ['sender', 'receiver']
                );
                expect(scenario.laneFamily === 'three-agent', scenario.scenarioKey).toBe(threeRoles);
                expect(toAlmConformanceRoleRecipe(scenario, 'sender')).toBe(scenario.sender);
                expect(toAlmConformanceRoleRecipe(scenario, 'receiver')).toBe(scenario.receiver);
                expect(toAlmConformanceRoleRecipe(scenario, 'recipient-b')).toBe(scenario.recipientB);
                expect(toAlmConformanceRoleRecipe(scenario, 'successor')).toBe(scenario.successor);
                expect(scenario.recipientB?.recipeId).toBe(threeRoles ? `alm-${carrier}-${scenario.scenarioKey}-recipient-b` : undefined);
                expect(scenario.successor?.recipeId).toBe(twoPages ? `alm-${carrier}-${scenario.scenarioKey}-successor` : undefined);
                expect(toAlmConformanceRoleRecipe(scenario, 'sibling')).toBe(scenario.sibling);
                expect(scenario.sibling?.recipeId).toBe(twoSessions ? `alm-${carrier}-${scenario.scenarioKey}-sibling` : undefined);
            }
        }
    });

    it('lets the sender connect only once every declared recipient is ready, so its audience never freezes short', () => {
        const readinessOf = (roles: readonly AlmConformanceRole[], role: AlmConformanceRole) =>
            toConnectCommand({ input: toConformanceInput('rtc'), scenarioId: 'delivery-baseline', scenarioKey: 'probe', role, roles })
                .readiness?.minReadyPeers;
        const threeRoles = ['sender', 'receiver', 'recipient-b'] as const;

        expect(readinessOf(['sender', 'receiver'], 'sender')).toBe(1);
        expect(readinessOf(['sender', 'receiver'], 'receiver')).toBe(1);
        expect(readinessOf(threeRoles, 'sender')).toBe(2);
        // A recipient of three arms its faults right after it connects; the sender starts only after that connect.
        expect(readinessOf(threeRoles, 'receiver')).toBeUndefined();
        expect(readinessOf(threeRoles, 'recipient-b')).toBeUndefined();
        expect(
            toConnectCommand({ input: toConformanceInput('ws'), scenarioId: 'delivery-baseline', scenarioKey: 'probe', role: 'sender', roles: threeRoles })
                .readiness
        ).toBeUndefined();
    });

    // The successor is the sender's own session on a second page, so it is never a peer to wait for.
    it('counts one ready peer for every page of a same-context scenario', () => {
        const sameContext = ['sender', 'receiver', 'successor'] as const;

        for (const role of sameContext) {
            expect(
                toConnectCommand({ input: toConformanceInput('rtc'), scenarioId: 'delivery-baseline', scenarioKey: 'probe', role, roles: sameContext })
                    .readiness?.minReadyPeers,
                role
            ).toBe(1);
        }
    });

    it('connects the successor on the sender\'s connection and restores the session the shared context holds', () => {
        const connect = toConnectCommand({
            input: toConformanceInput('ws'),
            scenarioId: 'delivery-baseline',
            scenarioKey: 'probe',
            role: 'successor',
            roles: ['sender', 'receiver', 'successor']
        });

        expect(connect.commandId).toBe('alm-ws-probe-successor-connect');
        expect(connect.connection).toBe('sender');
        expect(connect.rallar).toEqual({
            typeId: 'alm.conformance.ws.probe',
            topicId: CONFORMANCE_TOPIC_ID,
            username: '',
            password: '',
            restoreSession: true
        });
    });

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

    it('routes every carrier over one room WS topic the product admits, and the world cell over its own app topic', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
            const topicIdsOf = (world: boolean) =>
                toAllRoleRecipes(scenarios.filter((scenario) => (scenario.scenarioId === 'world-routing') === world))
                    .flatMap((recipe) => recipe.commands.flatMap(toRoutedTopicIds));

            expect(topicIdsOf(false).length).toBeGreaterThan(0);
            expect(new Set(topicIdsOf(false))).toEqual(new Set([CONFORMANCE_TOPIC_ID]));
            expect(new Set(topicIdsOf(true))).toEqual(new Set([WORLD_TOPIC_ID]));
        }
        for (const topicId of [CONFORMANCE_TOPIC_ID, WORLD_TOPIC_ID]) {
            expect(validateRallarWsUserTopicId(topicId).errors).toEqual([]);
        }
    });

    it('adds the send budget only to positive receive windows; a not-yet-in-sync expiry absence starts at the refusal', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const received = toReceivedCommands(
                createAlmConformanceRecipes({ ...toConformanceInput(carrier), deadlineMs: 18_000 })
            );

            expect(received.length).toBeGreaterThan(0);
            for (const command of received) {
                const pastExpiry = command.commandId?.includes('not-yet-in-sync-expires') === true ||
                    command.commandId?.includes('frozen-audience-membership-recipient-b') === true;
                // R-S3b-20: durable-opt-in's received-1 carries the durable path's own budget; pinned separately below.
                const durableOptInReceived1 = command.commandId?.endsWith('durable-opt-in-receiver-received-1') === true;
                // The capacity and capacity-tracks senders reconnect before they send; those waits are pinned in
                // alm-conformance-addressed-scenarios.
                const capacityReceived1 = /-capacity(-tracks)?-receiver-received-1$/.test(command.commandId ?? '');
                // The fairness cells' reconnect and lifetime windows are pinned in alm-conformance-fairness.
                const fairnessWindow =
                    /-(own-share-under-inbound-sender-received-1|buffered-track-drains-receiver-received-1|churn-bounded-tracks-receiver-received-1)$/
                        .test(command.commandId ?? '');
                if (durableOptInReceived1 || capacityReceived1 || fairnessWindow) {
                    continue;
                }
                expect({ windowMs: command.windowMs, timeoutMs: command.timeoutMs })
                    .toEqual(
                        pastExpiry
                            ? { windowMs: 10_000, timeoutMs: 11_000 }
                            : command.absent
                            ? { windowMs: 17_000, timeoutMs: 18_000 }
                            : { windowMs: 27_000, timeoutMs: 28_000 }
                    );
            }
        }
    });

    it('gives durable-opt-in\'s positive wait one more non-expiring send budget for the durable path (R-S3b-20)', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const received = toReceivedCommands(
                createAlmConformanceRecipes({ ...toConformanceInput(carrier), deadlineMs: ALM_CONFORMANCE_DEADLINE_MS })
            );
            const durableReceived1 = received.find((command) => command.commandId?.endsWith('durable-opt-in-receiver-received-1') === true);
            const baselineReceived1 = received.find((command) => command.commandId?.endsWith('delivery-baseline-receiver-received-1') === true);

            expect({ windowMs: durableReceived1?.windowMs, timeoutMs: durableReceived1?.timeoutMs }, carrier).toEqual({
                windowMs: ALM_CONFORMANCE_DEADLINE_MS + 2 * NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS,
                timeoutMs: ALM_CONFORMANCE_DEADLINE_MS + 2 * NON_EXPIRING_SEND_TIMEOUT_MS
            });
            expect({ windowMs: baselineReceived1?.windowMs, timeoutMs: baselineReceived1?.timeoutMs }, carrier).toEqual({
                windowMs: ALM_CONFORMANCE_DEADLINE_MS + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS,
                timeoutMs: ALM_CONFORMANCE_DEADLINE_MS + NON_EXPIRING_SEND_TIMEOUT_MS
            });
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

    it('asks for the logical receiver by its own name on every carrier, now that the RTC overlay tracks it', () => {
        const sendsOf = (carrier: CreateAlmConformanceRecipesInput['carrier']) =>
            toRecipes(createAlmConformanceRecipes(toConformanceInput(carrier))).flatMap((recipe) =>
                recipe.commands.flatMap((command) => command.kind === 'messages.send' && !('replayOnCarrier' in command) ? [command] : [])
            );
        const submission = sendsOf('rtc').find((command) => command.commandId === 'alm-rtc-delivery-lifecycle-sender-send-1');

        expect(submission).toMatchObject({ ack: 'receiver' });
        expect(submission?.qos).toBeUndefined();
        for (const carrier of ['ws', 'rtc', 'rtc-with-ws-fallback'] as const) {
            const sends = sendsOf(carrier);
            expect(sends.some((command) => command.ack === 'receiver'), carrier).toBe(true);
            expect(sends.every((command) => command.qos === undefined), carrier).toBe(true);
        }
    });

    it('keeps reload, storage-unavailable, the checkpoint scenarios, the ordering scenarios and the takeover full-only while preserving the smoke scenarios', () => {
        expect(
            createAlmConformanceRecipes(toConformanceInput('ws'))
                .filter((scenario) => scenario.tags.includes('smoke'))
                .map((scenario) => scenario.scenarioId)
        ).toEqual([
            'volatile-default',
            'bounded-rejection',
            'deadline-expiry',
            'delivery-baseline',
            'delivery-lifecycle',
            'durable-opt-in'
        ]);
        expect(
            createAlmConformanceRecipes(toConformanceInput('rtc-with-ws-fallback'))
                .filter((scenario) => !scenario.tags.includes('smoke'))
                .map((scenario) => scenario.scenarioId)
        ).toEqual([
            'delivery-reload',
            'storage-unavailable',
            'checkpoint-recovery',
            'checkpoint-lag',
            'ordering-resync',
            'repair-exhausted',
            'cross-carrier-duplicate',
            'cross-carrier-duplicate',
            'not-yet-in-sync',
            'receipt-exhausted-fallback',
            'no-fallback-after-deadline',
            'ws-unicast-receipt',
            'unicast-fallback',
            ...VOLATILE_BOUND_KEYS,
            'backpressure-hands-over',
            'own-share-under-inbound',
            'receipted-audience',
            'receipted-audience',
            'receipted-audience',
            'receipted-audience',
            ...AUDIENCE_KEYS,
            ...LEADER_ACK_KEYS_BY_CARRIER['rtc-with-ws-fallback'],
            ...CLAIM_KEYS_BY_CARRIER['rtc-with-ws-fallback'],
            'durable-takeover'
        ]);
        expect(
            createAlmConformanceRecipes(toConformanceInput('rtc')).map((scenario) => scenario.tags)
        ).toEqual([
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['smoke', 'full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
            ['full'],
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

    it('runs ordering-resync over every carrier in the full scope, with its identities distinct per carrier', () => {
        const orderingOf = (carrier: CreateAlmConformanceRecipesInput['carrier']) =>
            createAlmConformanceRecipes(toConformanceInput(carrier)).filter((scenario) => scenario.scenarioId === 'ordering-resync');
        const idsOf = (scenario: AlmConformanceScenario) =>
            toRecipes([scenario]).flatMap((recipe) => [recipe.recipeId, ...recipe.commands.flatMap((command) => command.commandId ?? [])]);

        const scenarios = ALM_CONFORMANCE_CARRIERS.flatMap(orderingOf);
        expect(scenarios.map((scenario) => scenario.tags)).toEqual(ALM_CONFORMANCE_CARRIERS.map(() => ['full']));
        const ids = scenarios.flatMap(idsOf);
        expect(new Set(ids).size).toBe(ids.length);
        expect(orderingOf('ws')[0]?.sender.commands.filter((command) => command.kind === 'messages.send')).toMatchObject([
            { carrier: 'ws', reliability: 'at-least-once', orderingKey: 'alm-ws-ordering-resync', seq: 1 },
            { carrier: 'ws', reliability: 'at-least-once', orderingKey: 'alm-ws-ordering-resync', seq: 300 }
        ]);
    });

    it('waits for the resync verdict where it is made: the relay\'s NACK at the ws sender, the receiver\'s own over RTC', () => {
        const orderingOf = (carrier: CreateAlmConformanceRecipesInput['carrier']) =>
            createAlmConformanceRecipes(toConformanceInput(carrier)).find((scenario) => scenario.scenarioId === 'ordering-resync');
        const receiverTail = (carrier: CreateAlmConformanceRecipesInput['carrier']) =>
            (orderingOf(carrier)?.receiver.commands ?? []).slice(0, -1).filter((command) => ['messages.received', 'wait'].includes(command.kind));

        expect((orderingOf('ws')?.sender.commands ?? []).slice(-2, -1)).toEqual([{
            kind: 'wait',
            commandId: 'alm-ws-ordering-resync-sender-relay-resync-nack',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                payloadPath: 'data',
                contains: '"typeId":"al.control.nack.v2","targetMsgId":"{resultCache.alm-ws-ordering-resync-sender-send-2.value.msgId}",' +
                    '"outcome":"committed"'
            },
            timeoutMs: 27_000
        }]);
        expect(receiverTail('ws')).toMatchObject([
            { kind: 'messages.received', count: 1, absent: false },
            { kind: 'messages.received', count: 2, absent: true }
        ]);
        for (const carrier of ['rtc', 'rtc-with-ws-fallback'] as const) {
            expect(orderingOf(carrier)?.sender.commands.some((command) => command.kind === 'wait'), carrier).toBe(false);
            expect(receiverTail(carrier), carrier).toMatchObject([
                { kind: 'messages.received', count: 1, absent: false },
                {
                    kind: 'wait',
                    commandId: `alm-${carrier}-ordering-resync-receiver-resync-outcome`,
                    match: {
                        kind: 'diagnostic',
                        topic: INBOUND_DIAGNOSTICS_TOPIC,
                        payloadPath: 'data',
                        contains: `"typeId":"alm.conformance.${carrier}.ordering-resync","carrier":"rtc","outcome":"not-handled",` +
                            '"reason":"resync-required"'
                    },
                    timeoutMs: 27_000
                },
                { kind: 'messages.received', count: 2, absent: true }
            ]);
        }
    });

    it('runs the not-yet-in-sync expiry over the RTC carriers only, in the full scope', () => {
        const recipeIds = (carrier: CreateAlmConformanceRecipesInput['carrier']) =>
            toRecipes(
                createAlmConformanceRecipes(toConformanceInput(carrier))
                    .filter((scenario) => scenario.scenarioId === 'not-yet-in-sync')
                    .filter((scenario) => !scenario.tags.includes('smoke'))
            ).map((recipe) => recipe.recipeId);

        for (const carrier of ['rtc', 'rtc-with-ws-fallback'] as const) {
            expect(recipeIds(carrier)).toEqual([
                `alm-${carrier}-not-yet-in-sync-expires-sender`,
                `alm-${carrier}-not-yet-in-sync-expires-receiver`
            ]);
        }
        expect(recipeIds('ws')).toEqual([]);
    });

    it('sends above every snapshot the group reaches with no in-scenario request, and observes the expiry', () => {
        const expires = createAlmConformanceRecipes(toConformanceInput('rtc'))
            .find((scenario) => scenario.scenarioId === 'not-yet-in-sync');
        const commands = expires?.sender.commands ?? [];

        expect(commands.find((command) => command.kind === 'messages.send'))
            .toMatchObject({ carrier: 'rtc', minSnapshotVersion: { absolute: 999_999 }, ack: 'receiver', ttlMs: 7_500 });
        expect(commands.filter((command) => command.kind === 'http.request').map((command) => command.commandId)).toEqual([
            'alm-rtc-not-yet-in-sync-expires-sender-ensure-group',
            'alm-rtc-not-yet-in-sync-expires-sender-ensure-member'
        ]);
        expect(commands.flatMap((command) => command.kind === 'messages.observe' ? [command.state] : []))
            .toEqual([AL_DELIVERY_ADMITTED_STATES, ['expired']]);
    });

    it('waits for the receiver\'s not-yet-in-sync refusal over RTC, then for absence past expiry', () => {
        const expires = createAlmConformanceRecipes(toConformanceInput('rtc-with-ws-fallback'))
            .find((scenario) => scenario.scenarioId === 'not-yet-in-sync');

        expect((expires?.receiver.commands ?? []).slice(-3, -1)).toMatchObject([
            {
                kind: 'wait',
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.inbound_diagnostics',
                    payloadPath: 'data',
                    contains: '"typeId":"alm.conformance.rtc-with-ws-fallback.not-yet-in-sync-expires",' +
                        '"carrier":"rtc","outcome":"rejected","reason":"not-yet-in-sync'
                },
                timeoutMs: 27_000
            },
            { kind: 'messages.received', count: 1, absent: true, windowMs: 10_000 }
        ]);
    });

    it('keeps the delivery baseline\'s storage reading as evidence without asserting a total (the default is volatile)', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const baseline = createAlmConformanceRecipes(toConformanceInput(carrier))
                .find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
            expect(baseline.sender.commands.some((command) => command.kind === 'storage.counters'), carrier).toBe(true);
            expect(
                baseline.sender.commands.some((command) => command.kind === 'assert' && command.source.endsWith('.value.total')),
                carrier
            ).toBe(false);
        }
    });

    // Review m3: a window that opens after the send, or reads before the arrival, would pass its zero vacuously.
    it.each(ALM_CONFORMANCE_CARRIERS)('opens each storage window before the send and reads it after the outcome over %s', (carrier) => {
        const indexOf = (recipe: RallarBlackBoxTestRecipe, suffix: string) =>
            recipe.commands.findIndex((command) => command.commandId?.endsWith(suffix) === true);
        for (const scenarioId of ['volatile-default', 'durable-opt-in']) {
            const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
                .find((candidate) => candidate.scenarioId === scenarioId)!;
            const outcome = scenarioId === 'volatile-default' ? '-observe-acknowledged-1' : '-receipts-1';
            const sender = ['-storage-window-open', '-send-1', outcome, '-storage-window']
                .map((suffix) => indexOf(scenario.sender, suffix));
            const receiver = ['-storage-window-open', '-received-1', '-storage-window']
                .map((suffix) => indexOf(scenario.receiver, suffix));
            for (const indices of [sender, receiver]) {
                expect(indices.every((index) => index >= 0), `${scenarioId} ${indices.join(',')}`).toBe(true);
                expect(indices, scenarioId).toEqual([...indices].sort((left, right) => left - right));
            }
        }
    });

    describe('receipted-audience scenarios (three agents)', () => {
        const receiptedOf = (carrier: CreateAlmConformanceRecipesInput['carrier'], key: string) => {
            const scenario = createAlmConformanceRecipes(toConformanceInput(carrier)).find((candidate) => candidate.scenarioKey === key);
            if (scenario?.recipientB === undefined) {
                throw new Error(`${carrier} ${key} must declare recipient-b.`);
            }
            return { ...scenario, recipientB: scenario.recipientB };
        };
        const bodyOf = (recipe: RallarBlackBoxTestRecipe) =>
            recipe.commands.slice(recipe.commands.findIndex((command) => command.kind === 'rtc.connect') + 1, -1);
        const shapeOf = (command: RallarBlackBoxTestCommand) =>
            command.kind === 'fault.inject'
                ? `fault.inject:${command.carrier}:${String(command.remaining)}`
                : command.kind === 'wait'
                ? `wait:${command.match.kind}${command.absent === true ? ':absent' : ''}`
                : command.kind === 'messages.received'
                ? `received:${command.count}${command.absent === true ? ':absent' : ''}`
                : command.kind;

        it('reads every receipt only after the scenario window, pinning its mode and the length of each recipient list', () => {
            const tails = {
                'aggregated-receipt': ['acknowledged', 2, 2, 0],
                'unknown-ack-version': ['acknowledged', 2, 2, 0],
                'frozen-audience-membership': ['expired', 2, 1, 1]
            } as const;
            for (const [key, [ending, expected, confirmed, unconfirmed]] of Object.entries(tails)) {
                const tail = receiptedOf('rtc', key).sender.commands.slice(-8, -1);
                expect(tail.map(shapeOf), key)
                    .toEqual(['received:1:absent', 'messages.receipts', 'assert', 'assert', 'assert', 'assert', 'assert']);
                expect(tail.flatMap((command) => command.kind === 'assert' ? [command.expected] : []), key)
                    .toEqual([ending, 'receiver', expected, confirmed, unconfirmed]);
            }
            const retryCounts = (carrier: CreateAlmConformanceRecipesInput['carrier']) =>
                receiptedOf(carrier, 'missing-recipient-retry').sender.commands.flatMap((command) =>
                    command.kind === 'assert' && command.source.includes('RecipientPeerIds') ? [command.expected] : []
                );
            expect(retryCounts('ws')).toEqual([2, 1, 1]);
            expect(retryCounts('rtc')).toEqual([2, 2, 0]);
            expect(retryCounts('rtc-with-ws-fallback')).toEqual([2, 2, 0]);
        });

        it.each(
            [
                ['ws', 'expired', 'acknowledged'],
                ['rtc', 'acknowledged', 'expired'],
                ['rtc-with-ws-fallback', 'acknowledged', 'expired']
            ] as const
        )('ends the %s retry receipt %s and fails it when the handle reads %s', async (carrier, ending, other) => {
            const sender = receiptedOf(carrier, 'missing-recipient-retry').sender;
            const receiptsAt = sender.commands.findIndex((command) => command.kind === 'messages.receipts');
            const lists = carrier === 'ws'
                ? { expected: ['r', 'b'], confirmed: ['r'], unconfirmed: ['b'] }
                : { expected: ['r', 'b'], confirmed: ['r', 'b'], unconfirmed: [] };
            const readTail = async (state: string) => {
                const runtime = createRallarBlackBoxTestRuntime({
                    commandExecutor: (command) =>
                        command.kind === 'messages.receipts'
                            ? {
                                status: 'ok',
                                value: {
                                    state,
                                    receiptMode: 'receiver',
                                    expectedRecipientPeerIds: lists.expected,
                                    confirmedRecipientPeerIds: lists.confirmed,
                                    unconfirmedRecipientPeerIds: lists.unconfirmed
                                }
                            }
                            : undefined
                });
                const tail = { ...sender, commands: sender.commands.slice(receiptsAt, -1) };
                return (await runtime.execute({ kind: 'recipe.run', recipe: tail })).ok;
            };

            expect(await readTail(ending)).toBe(true);
            expect(await readTail(other)).toBe(false);
        });

        it('ends the frozen-audience receipt expired and every completing receipt acknowledged, on every carrier', () => {
            const endingOf = (carrier: CreateAlmConformanceRecipesInput['carrier'], key: string) =>
                receiptedOf(carrier, key).sender.commands.flatMap((command) =>
                    command.kind === 'assert' && command.source.endsWith('receipts-1.value.state') ? [command.expected] : []
                );
            for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                expect(endingOf(carrier, 'frozen-audience-membership'), carrier).toEqual(['expired']);
                expect(endingOf(carrier, 'aggregated-receipt'), carrier).toEqual(['acknowledged']);
            }
            expect(endingOf('rtc', 'unknown-ack-version')).toEqual(['acknowledged']);
        });

        it('scopes each unknown-ack-version wait to its own carrier, so a combined recipe cannot match an earlier carrier', () => {
            const waitsOf = (carrier: CreateAlmConformanceRecipesInput['carrier']) => {
                const scenario = receiptedOf(carrier, 'unknown-ack-version');
                const arrival = bodyOf(scenario.recipientB).find((command) => command.kind === 'wait');
                const control = bodyOf(scenario.recipientB).find((command) => command.kind === 'messages.control');
                const refusal = scenario.sender.commands.find((command) =>
                    command.kind === 'wait' && command.match.contains?.includes('al.control.ack.v1') === true
                );
                return {
                    arrival: arrival?.kind === 'wait' ? JSON.stringify(arrival.match.equals) : undefined,
                    controlMsgId: control?.kind === 'messages.control' ? control.msgId : undefined,
                    refusal: refusal?.kind === 'wait' ? refusal.match.contains : undefined
                };
            };
            const rtc = waitsOf('rtc');
            const fallback = waitsOf('rtc-with-ws-fallback');

            expect(rtc.arrival).not.toBe(fallback.arrival);
            expect(rtc.controlMsgId).not.toBe(fallback.controlMsgId);
            expect(rtc.refusal).toContain('"msgId":"alm-rtc-unknown-ack-version-retired-ack-');
            expect(fallback.refusal).toContain('"msgId":"alm-rtc-with-ws-fallback-unknown-ack-version-retired-ack-');
        });

        it('holds the ACK of recipient-b until the retried copy arrives over RTC, and proves over ws that no copy is retried', () => {
            expect(bodyOf(receiptedOf('rtc', 'missing-recipient-retry').recipientB).map(shapeOf))
                .toEqual(['fault.inject:rtc:until-cleared', 'received:1', 'wait:diagnostic', 'fault.inject:rtc:0']);
            expect(bodyOf(receiptedOf('ws', 'missing-recipient-retry').recipientB).map(shapeOf))
                .toEqual(['fault.inject:ws:until-cleared', 'received:1', 'wait:diagnostic:absent', 'fault.inject:ws:0']);
            for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                expect(bodyOf(receiptedOf(carrier, 'missing-recipient-retry').receiver).map(shapeOf), carrier)
                    .toEqual(['received:1', 'wait:diagnostic:absent']);
            }
        });

        it('answers the send with a raw retired ACK over the rtc leg, admitted, and waits for the origin to refuse it unsupported', () => {
            const scenario = receiptedOf('rtc-with-ws-fallback', 'unknown-ack-version');
            const arrival = '{resultCache.alm-rtc-with-ws-fallback-unknown-ack-version-recipient-b-received-send-1.value.event.payload';
            expect(bodyOf(scenario.recipientB)).toMatchObject([
                { kind: 'wait', commandId: 'alm-rtc-with-ws-fallback-unknown-ack-version-recipient-b-received-send-1' },
                {
                    kind: 'messages.control',
                    commandId: 'alm-rtc-with-ws-fallback-unknown-ack-version-recipient-b-unknown-ack-version-1',
                    carrier: 'rtc',
                    typeId: 'al.control.ack.v1',
                    msgId: `alm-rtc-with-ws-fallback-unknown-ack-version-retired-ack-${arrival}.data.msgId}`,
                    ackedMsgId: `${arrival}.data.msgId}`,
                    toPeerId: `${arrival}.senderId}`
                },
                {
                    kind: 'assert',
                    source: 'resultCache.alm-rtc-with-ws-fallback-unknown-ack-version-recipient-b-unknown-ack-version-1.value.verdict',
                    operator: 'equals',
                    expected: 'admitted'
                },
                { kind: 'messages.received', count: 2, absent: true }
            ]);
            expect(scenario.sender.commands).toContainEqual(expect.objectContaining({
                kind: 'wait',
                match: expect.objectContaining({
                    topic: INBOUND_DIAGNOSTICS_TOPIC,
                    contains: '"msgId":"alm-rtc-with-ws-fallback-unknown-ack-version-retired-ack-' +
                        '{resultCache.alm-rtc-with-ws-fallback-unknown-ack-version-sender-send-1.value.msgId}",' +
                        '"typeId":"al.control.ack.v1","carrier":"rtc","outcome":"rejected","reason":"unsupported"'
                })
            }));
        });

        it(
            'keeps a recipient-b block whose sender reads acknowledged inside its scenario until its own ACK has ' +
                'left, unless the block clears its hold explicitly',
            () => {
                let sawAcknowledged = false;
                for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                    for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                        if (scenario.laneFamily !== 'three-agent') {
                            continue;
                        }
                        const endingAssert = scenario.sender.commands.find((command) =>
                            command.kind === 'assert' && command.source.endsWith('receipts-1.value.state')
                        );
                        if (endingAssert?.kind !== 'assert' || endingAssert.expected !== 'acknowledged') {
                            continue;
                        }
                        sawAcknowledged = true;
                        const senderWindow = scenario.sender.commands.find((command) =>
                            command.kind === 'messages.received' && command.commandId?.endsWith('received-self-1') === true
                        );
                        if (senderWindow?.kind !== 'messages.received') {
                            throw new Error(`${carrier} ${scenario.scenarioKey} sender is missing its receipt window.`);
                        }
                        const label = `${carrier} ${scenario.scenarioKey}`;
                        const last = bodyOf(scenario.recipientB!).at(-1);
                        const clearsHoldExplicitly = last?.kind === 'close' ||
                            (last?.kind === 'fault.inject' && last.remaining === 0);
                        const endsWithLongEnoughAbsence = last?.kind === 'messages.received' &&
                            last.absent === true && (last.timeoutMs ?? 0) >= (senderWindow.timeoutMs ?? 0);

                        expect(clearsHoldExplicitly || endsWithLongEnoughAbsence, label).toBe(true);
                    }
                }
                expect(sawAcknowledged).toBe(true);
            }
        );

        it('lets recipient-b leave once the send reached it and reconnect only past the expiry of the send', () => {
            expect(bodyOf(receiptedOf('ws', 'frozen-audience-membership').recipientB).map(shapeOf))
                .toEqual(['fault.inject:ws:until-cleared', 'received:1', 'close', 'received:2:absent', 'rtc.connect']);
            expect(receiptedOf('rtc', 'frozen-audience-membership').sender.commands).toContainEqual(
                expect.objectContaining({ kind: 'messages.send', ack: 'all-logical-recipients', ttlMs: 7_500 })
            );
        });
    });

    it('opts the reload original into local-outbox and reads the lifecycle specimens as volatile', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
            const reload = scenarios.find((scenario) => scenario.scenarioId === 'delivery-reload')!;
            const lifecycle = scenarios.find((scenario) => scenario.scenarioId === 'delivery-lifecycle')!;
            const reloadSend = reload.sender.commands.find((command) => command.kind === 'messages.send');
            const enqueuedAsserts = (recipe: RallarBlackBoxTestRecipe) =>
                recipe.commands.filter((command): command is RallarBlackBoxTestAssertCommand =>
                    command.kind === 'assert' && command.source.endsWith('.value.enqueued')
                );

            expect(reloadSend, carrier).toMatchObject({ durability: 'local-outbox' });
            expect(enqueuedAsserts(reload.sender).map((command) => command.expected), carrier).toEqual([
                true
            ]);
            expect(enqueuedAsserts(lifecycle.sender).map((command) => command.expected), carrier)
                .toEqual([false, false]);
        }
    });

    // S3a (D54): the replay reads the first send's envelope back from IndexedDB, which a volatile send
    // never reaches -- its admission lands in the carrier's memory pair.
    it('opts the first send of each cross-carrier duplicate into local-outbox, so its replay finds the envelope', () => {
        const duplicates = createAlmConformanceRecipes(toConformanceInput('rtc-with-ws-fallback'))
            .filter((scenario) => scenario.scenarioId === 'cross-carrier-duplicate');

        expect(duplicates).toHaveLength(2);
        for (const scenario of duplicates) {
            const [first] = scenario.sender.commands.filter((command) => command.kind === 'messages.send');
            expect(first, scenario.scenarioKey).toMatchObject({ durability: 'local-outbox' });
        }
    });
});
