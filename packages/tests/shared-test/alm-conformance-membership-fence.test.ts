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
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const OUTBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.outbound_diagnostics';
const INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';
const FENCE_SCENARIO_IDS = ['fenced-delivery', 'fenced-catch-up', 'fenced-rejection'] as const;
const PROLOGUE = ['ensure-group', 'ensure-member', 'connect'] as const;
const GROUP_PATH = '/api/state/apps/app/workspaces/ws/groups/room-alm';

type FenceScenarioId = (typeof FENCE_SCENARIO_IDS)[number];

function findScenario(input: CreateAlmConformanceRecipesInput, scenarioId: FenceScenarioId): AlmConformanceScenario {
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

function requireRecipientB(scenario: AlmConformanceScenario): RallarBlackBoxTestRecipe {
    if (scenario.recipientB === undefined) {
        throw new Error(`${scenario.scenarioKey} declares no recipient-b.`);
    }
    return scenario.recipientB;
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
    return toRecipes(scenario).flatMap((recipe) =>
        recipe.commands.flatMap((command) => [
            `command:${command.commandId}`,
            ...(command.kind === 'fault.inject' ? [`fault:${command.faultId}`] : []),
            ...(command.kind === 'messages.send' && !('replayOnCarrier' in command) ? [`handle:${command.handleId}`] : []),
            ...(command.kind === 'http.request' && command.request.method !== 'GET' ? [`request:${command.request.path}`] : [])
        ])
    );
}

function toSelfMembershipPath(carrier: string, scenarioKey: string, role: string, request: string): string {
    return `${GROUP_PATH}/members/{auth.clientId}/requests/alm-conformance-{runtimeIdentity}-${carrier}-${scenarioKey}-${role}-${request}`;
}

describe('membership fence conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the %s fence cells on three agents in the full tag only', (carrier) => {
        const cells = createAlmConformanceRecipes(toConformanceInput(carrier))
            .filter((scenario) => (FENCE_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId))
            .map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags }));
        const cell = (scenarioId: FenceScenarioId) => ({
            scenarioId,
            laneFamily: 'three-agent',
            roles: ['sender', 'receiver', 'recipient-b'],
            tags: ['full']
        });

        expect(cells).toEqual(
            carrier === 'ws'
                ? [cell('fenced-delivery'), cell('fenced-catch-up'), cell('fenced-rejection')]
                : carrier === 'rtc'
                ? [cell('fenced-delivery'), cell('fenced-catch-up')]
                : []
        );
    });

    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)('gives every %s fence cell identities no other scenario of the run shares', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const isFence = (scenario: AlmConformanceScenario) => (FENCE_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId);
        const others = new Set(scenarios.filter((scenario) => !isFence(scenario)).flatMap(toMintedIdentities));
        const own = scenarios.filter(isFence).flatMap(toMintedIdentities);

        expect(own.filter((identity) => others.has(identity))).toEqual([]);
        expect(new Set(own).size).toBe(own.length);
        for (const command of scenarios.filter(isFence).flatMap(toRecipes).flatMap((recipe) => recipe.commands)) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('fenced-delivery', () => {
    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)('sends one %s room send and reads its roster stamp at both recipients', (carrier) => {
        const scenario = findScenario(toConformanceInput(carrier), 'fenced-delivery');
        const recipientNames = [...PROLOGUE, 'received-1', 'read-roster', 'roster-stamp', 'received-2', 'stats'];

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'stats'
        ]);
        expect(toCommandNames(scenario.receiver)).toEqual(recipientNames);
        expect(toCommandNames(requireRecipientB(scenario))).toEqual(recipientNames);
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            carrier,
            ack: 'all-logical-recipients',
            reliability: 'at-least-once',
            ttlMs: 30_000,
            payload: { marker: 'fenced-delivery', carrier }
        });
        expect(findCommand(scenario.sender, 'send-1')).not.toHaveProperty('minSnapshotVersion');
    });

    it('reads the group roster the server holds after the arrival', () => {
        const { receiver } = findScenario(toConformanceInput('ws'), 'fenced-delivery');

        expect(findCommand(receiver, 'read-roster')).toMatchObject({
            kind: 'http.request',
            request: { method: 'GET', path: GROUP_PATH },
            response: { body: 'json', acceptedStatusCodes: [200] }
        });
        expect(findCommand(receiver, 'read-roster')).not.toHaveProperty('request.body');
    });

    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)('matches the %s arrival of the cell\'s type that carried the roster read', (carrier) => {
        const recipientB = requireRecipientB(findScenario(toConformanceInput(carrier), 'fenced-delivery'));

        expect(findCommand(recipientB, 'roster-stamp')).toEqual({
            kind: 'wait',
            commandId: `alm-${carrier}-fenced-delivery-recipient-b-roster-stamp`,
            match: {
                kind: 'message',
                connection: 'receiver',
                payloadPath: 'data',
                contains: `"typeId":"alm.conformance.${carrier}.fenced-delivery","rosterVersion":` +
                    `{resultCache.alm-${carrier}-fenced-delivery-recipient-b-read-roster.value.body.group.rosterVersion},`
            },
            timeoutMs: 5_000
        });
    });

    it('resolves the stamp wait against an arrival of the read roster and not of another', async () => {
        const recipientB = requireRecipientB(findScenario(toConformanceInput('rtc'), 'fenced-delivery'));
        const run = async (rosterVersion: number) => {
            const runtime = createRallarBlackBoxTestRuntime({
                commandExecutor: (command) =>
                    command.kind === 'http.request'
                        ? { status: 'ok', value: { status: 200, body: { group: { rosterVersion: 4 } } } }
                        : undefined
            });
            runtime.recordEvent({
                kind: 'message',
                connection: 'receiver',
                topic: 'rallar.browser.messages.rtc.message',
                payload: {
                    data: {
                        msgId: 'fenced-1',
                        typeId: 'alm.conformance.rtc.fenced-delivery',
                        rosterVersion,
                        topicId: 'room.alm-conformance',
                        transport: 'rtc',
                        payload: { marker: 'fenced-delivery', carrier: 'rtc' }
                    }
                }
            });
            // A shortened wait: the arrival is already on the log, so only a mismatch spends the budget.
            const tail = [findCommand(recipientB, 'read-roster'), { ...findCommand(recipientB, 'roster-stamp'), timeoutMs: 50 }];
            return (await runtime.execute({ kind: 'recipe.run', recipe: { ...recipientB, commands: tail } })).ok;
        };

        expect(await run(4)).toBe(true);
        expect(await run(44)).toBe(false);
    });
});

describe('fenced-catch-up', () => {
    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)(
        'sends a floored %s send, reads its NACK, then the cue; recipient-b leaves on the cue; the receiver gets the floored send once',
        (carrier) => {
            const scenario = findScenario(toConformanceInput(carrier), 'fenced-catch-up');

            expect(toCommandNames(scenario.sender)).toEqual([
                ...PROLOGUE,
                'storage-counters-connected',
                'send-1',
                'observe-admitted-1',
                'assert-admitted-1',
                'catch-up-nack',
                'send-2',
                'observe-admitted-2',
                'assert-admitted-2',
                'stats'
            ]);
            expect(toCommandNames(requireRecipientB(scenario))).toEqual([...PROLOGUE, 'received-roster-move', 'leave-roster', 'stats']);
            expect(toCommandNames(scenario.receiver)).toEqual([
                ...PROLOGUE,
                ...(carrier === 'rtc' ? ['not-yet-in-sync-outcome'] : []),
                'received-floored',
                'received-3',
                'stats'
            ]);
        }
    );

    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)('floors the first %s send one snapshot past the sender\'s and leaves the cue unfloored', (carrier) => {
        const { sender } = findScenario(toConformanceInput(carrier), 'fenced-catch-up');

        expect(findCommand(sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            carrier,
            ack: 'receiver',
            reliability: 'at-least-once',
            ttlMs: 30_000,
            timeoutMs: 10_000,
            minSnapshotVersion: { aboveCurrentBy: 1 },
            payload: { marker: 'fenced-catch-up', carrier, send: 'floored' }
        });
        expect(findCommand(sender, 'send-2')).toMatchObject({
            kind: 'messages.send',
            reliability: 'at-least-once',
            ttlMs: 30_000,
            payload: { marker: 'fenced-catch-up', carrier, send: 'roster-move' }
        });
        expect(findCommand(sender, 'send-2')).not.toHaveProperty('minSnapshotVersion');
    });

    it.each(
        [
            ['rtc', ',"outcome":"committed"'],
            ['ws', '']
        ] as const
    )('waits for the %s refusal\'s NACK at the sender before the cue: committed over rtc, its arrival over ws', (carrier, outcome) => {
        const { sender } = findScenario(toConformanceInput(carrier), 'fenced-catch-up');

        expect(findCommand(sender, 'catch-up-nack')).toEqual({
            kind: 'wait',
            commandId: `alm-${carrier}-fenced-catch-up-sender-catch-up-nack`,
            match: {
                kind: 'diagnostic',
                topic: OUTBOUND_DIAGNOSTICS_TOPIC,
                payloadPath: 'data',
                contains: '"typeId":"al.control.nack.v2",' +
                    `"targetMsgId":"{resultCache.alm-${carrier}-fenced-catch-up-sender-send-1.value.msgId}"${outcome}`
            },
            timeoutMs: 27_000
        });
    });

    it.each(ALM_CONFORMANCE_SINGLE_HOP_CARRIERS)('lets %s recipient-b leave the group only once the cue reached it', (carrier) => {
        const recipientB = requireRecipientB(findScenario(toConformanceInput(carrier), 'fenced-catch-up'));

        expect(findCommand(recipientB, 'received-roster-move')).toMatchObject({
            kind: 'wait',
            match: {
                kind: 'message',
                connection: 'receiver',
                payloadPath: 'data.payload',
                equals: { marker: 'fenced-catch-up', carrier, send: 'roster-move' }
            },
            timeoutMs: 27_000
        });
        expect(findCommand(recipientB, 'leave-roster')).toMatchObject({
            kind: 'http.request',
            request: {
                method: 'PUT',
                path: toSelfMembershipPath(carrier, 'fenced-catch-up', 'recipient-b', 'leave-roster'),
                body: { status: 'left' }
            },
            response: { body: 'json', acceptedStatusCodes: [200, 201] }
        });
    });

    it('waits for the rtc receiver\'s own not-yet-in-sync refusal before the delivery; over ws the server refuses', () => {
        const { receiver } = findScenario(toConformanceInput('rtc'), 'fenced-catch-up');

        expect(findCommand(receiver, 'not-yet-in-sync-outcome')).toEqual({
            kind: 'wait',
            commandId: 'alm-rtc-fenced-catch-up-receiver-not-yet-in-sync-outcome',
            match: {
                kind: 'diagnostic',
                topic: INBOUND_DIAGNOSTICS_TOPIC,
                payloadPath: 'data',
                contains: '"typeId":"alm.conformance.rtc.fenced-catch-up","carrier":"rtc","outcome":"rejected","reason":"not-yet-in-sync'
            },
            timeoutMs: 27_000
        });
        expect(findCommand(receiver, 'received-floored')).toMatchObject({
            kind: 'wait',
            match: { payloadPath: 'data.payload', equals: { marker: 'fenced-catch-up', carrier: 'rtc', send: 'floored' } }
        });
        expect(findCommand(receiver, 'received-3')).toMatchObject({ kind: 'messages.received', count: 3, absent: true, windowMs: 17_000 });
    });
});

describe('fenced-rejection', () => {
    it('runs over ws only: an rtc sender refuses its own send once its room authority sees it gone', () => {
        expect(
            ALM_CONFORMANCE_CARRIERS.filter((carrier) =>
                createAlmConformanceRecipes(toConformanceInput(carrier)).some((scenario) => scenario.scenarioId === 'fenced-rejection')
            )
        ).toEqual(['ws']);
    });

    it('leaves the group before the send, reads the committed NACK, then the rejected handle and its fenced reason', () => {
        const scenario = findScenario(toConformanceInput('ws'), 'fenced-rejection');
        const recipientNames = [...PROLOGUE, 'received-1', 'stats'];

        expect(toCommandNames(scenario.sender)).toEqual([
            ...PROLOGUE,
            'storage-counters-connected',
            'leave-roster',
            'send-1',
            'fenced-nack',
            'observe-rejected-1',
            'assert-relay-rejected-1',
            'assert-trusted-server-1',
            'assert-membership-fenced-1',
            'stats'
        ]);
        expect(toCommandNames(scenario.receiver)).toEqual(recipientNames);
        expect(toCommandNames(requireRecipientB(scenario))).toEqual(recipientNames);
        expect(findCommand(scenario.sender, 'leave-roster')).toMatchObject({
            kind: 'http.request',
            request: {
                method: 'PUT',
                path: toSelfMembershipPath('ws', 'fenced-rejection', 'sender', 'leave-roster'),
                body: { status: 'left' }
            }
        });
        expect(findCommand(scenario.sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            carrier: 'ws',
            ack: 'receiver',
            reliability: 'at-least-once',
            payload: { marker: 'fenced-rejection', carrier: 'ws' }
        });
    });

    it('reads the trusted server\'s membership-fenced rejection on the handle', () => {
        const { sender } = findScenario(toConformanceInput('ws'), 'fenced-rejection');
        const observation = 'resultCache.alm-ws-fenced-rejection-sender-observe-rejected-1.value';

        expect(findCommand(sender, 'fenced-nack')).toMatchObject({
            kind: 'wait',
            match: {
                topic: OUTBOUND_DIAGNOSTICS_TOPIC,
                contains: '"typeId":"al.control.nack.v2",' +
                    '"targetMsgId":"{resultCache.alm-ws-fenced-rejection-sender-send-1.value.msgId}","outcome":"committed"'
            }
        });
        expect(findCommand(sender, 'observe-rejected-1')).toMatchObject({
            kind: 'messages.observe',
            handleId: 'alm-ws-fenced-rejection-send-1',
            state: ['rejected']
        });
        expect(['assert-relay-rejected-1', 'assert-trusted-server-1', 'assert-membership-fenced-1'].map((name) => findCommand(sender, name)))
            .toMatchObject([
                { kind: 'assert', source: `${observation}.failure.kind`, operator: 'equals', expected: 'relay-rejected' },
                { kind: 'assert', source: `${observation}.relayRejection.relay`, operator: 'equals', expected: 'trusted-server' },
                { kind: 'assert', source: `${observation}.relayRejection.reason`, operator: 'equals', expected: 'membership-fenced' }
            ]);
    });

    it('passes on the fenced reason and fails on a trusted-server rejection for any other', async () => {
        const { sender } = findScenario(toConformanceInput('ws'), 'fenced-rejection');
        const from = sender.commands.findIndex((command) => command.commandId === `${sender.recipeId}-observe-rejected-1`);
        const readTail = async (reason: string) => {
            const runtime = createRallarBlackBoxTestRuntime({
                commandExecutor: (command) =>
                    command.kind === 'messages.observe'
                        ? {
                            status: 'ok',
                            value: {
                                state: 'rejected',
                                failure: { kind: 'relay-rejected', rejection: { relay: 'trusted-server', reason } },
                                relayRejection: { relay: 'trusted-server', reason }
                            }
                        }
                        : undefined
            });
            const tail = { ...sender, commands: sender.commands.slice(from, -1) };
            return (await runtime.execute({ kind: 'recipe.run', recipe: tail })).ok;
        };

        expect(await readTail('membership-fenced')).toBe(true);
        expect(await readTail('unauthorized')).toBe(false);
    });

    it('proves at both recipients that the refused send never arrives', () => {
        const scenario = findScenario(toConformanceInput('ws'), 'fenced-rejection');

        for (const recipient of [scenario.receiver, requireRecipientB(scenario)]) {
            expect(findCommand(recipient, 'received-1')).toMatchObject({
                kind: 'messages.received',
                typeId: 'alm.conformance.ws.fenced-rejection',
                count: 1,
                absent: true,
                windowMs: 17_000
            });
        }
    });
});
