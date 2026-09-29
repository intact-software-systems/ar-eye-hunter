import {
    describe,
    expect,
    it
} from 'vitest';

import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    computeALMessageEnvelopeBytes
} from '@shared/al-contracts/al-message-resource-limits.ts';
import { AL_VOLATILE_SESSION_MAX_ADMISSIONS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const ADDRESSED_KEYS = ['ws-unicast-receipt', 'unicast-fallback', 'server-command', 'capacity'];
const ADDRESSED_KEYS_BY_CARRIER: Readonly<Record<AlmConformanceCarrier, readonly string[]>> = {
    ws: ['ws-unicast-receipt', 'server-command', 'capacity'],
    rtc: ['ws-unicast-receipt', 'capacity'],
    'rtc-with-ws-fallback': ['ws-unicast-receipt', 'unicast-fallback', 'capacity']
};
const ADMITTED = 'state matches ^(accepted|queued|transport-accepted|acknowledged)$';
const ADDRESSEE_RECEIPT = [
    'state equals acknowledged',
    'receiptMode equals receiver',
    'expectedRecipientPeerIds.length equals 1',
    'confirmedRecipientPeerIds.length equals 1'
];
const CAPACITY_LIMITS = { maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS, maxBytes: 160 * 1024 };
/**
 * The platform's state sync the capacity sender's rejoin admits inbound: 6 entries of 25.8-26.6 KB in total across
 * six local lane samples on every carrier, rounded up.
 */
const PLATFORM_STATE_SYNC_BYTES = 26 * 1024;

function scenarioOf(carrier: AlmConformanceCarrier, key: string): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioKey === key);
    if (scenario === undefined) {
        throw new Error(`${carrier} must run ${key}.`);
    }
    return scenario;
}

/** The scenario's own commands: after the prologue connect, without the storage readings and the closing stats. */
function bodyOf(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestCommand[] {
    return recipe.commands
        .slice(recipe.commands.findIndex((command) => command.kind === 'rtc.connect') + 1, -1)
        .filter((command) => command.kind !== 'storage.counters');
}

function shapeOf(command: RallarBlackBoxTestCommand): string {
    switch (command.kind) {
        case 'fault.inject':
            return `fault.inject:${command.carrier}:${String(command.remaining)}`;
        case 'wait':
            return `wait:${command.match.kind}${command.absent === true ? ':absent' : ''}`;
        case 'messages.received':
            return `received:${command.count}${command.absent === true ? ':absent' : ''}`;
        case 'messages.send':
            return isRallarBlackBoxTestMessagesSendCommand(command) && command.toPeer !== undefined
                ? `messages.send:${command.toPeer}`
                : 'messages.send';
        default:
            return command.kind;
    }
}

function assertionsOf(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return bodyOf(recipe).flatMap((command) =>
        command.kind === 'assert'
            ? [`${command.source.split('.value.')[1]} ${command.operator} ${String(command.expected)}`]
            : []
    );
}

describe('the addressed-send family (C11)', () => {
    it('runs on two agents in the full scope, over the carriers each scenario can address', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier))
                .filter((scenario) => ADDRESSED_KEYS.includes(scenario.scenarioKey));

            expect(scenarios.map((scenario) => scenario.scenarioKey), carrier).toEqual(
                ADDRESSED_KEYS_BY_CARRIER[carrier]
            );
            for (const scenario of scenarios) {
                expect(scenario.roles, scenario.scenarioKey).toEqual(['sender', 'receiver']);
                expect(scenario.tags, scenario.scenarioKey).toEqual(['full']);
            }
        }
    });

    it('sends a command to the receiver by its role on every carrier and pins its receipt to the receiver', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenario = scenarioOf(carrier, 'ws-unicast-receipt');

            expect(bodyOf(scenario.sender).map(shapeOf), carrier).toEqual([
                'messages.send:receiver',
                'messages.observe',
                'assert',
                'messages.observe',
                'assert',
                'assert',
                'assert',
                'assert',
                'messages.receipts'
            ]);
            expect(assertionsOf(scenario.sender), carrier).toEqual([
                ADMITTED,
                ...ADDRESSEE_RECEIPT
            ]);
            expect(scenario.sender.metadata?.almReceiptRoles, carrier).toEqual([
                {
                    handleId: `alm-${carrier}-ws-unicast-receipt-send-1`,
                    confirmed: ['receiver'],
                    unconfirmed: []
                }
            ]);
            expect(bodyOf(scenario.receiver).map(shapeOf), carrier).toEqual(['received:1']);
        }
    });

    it('drops the RTC leg of a unicast until WS delivers it, and reads the hand-over from carrierFallback', () => {
        const scenario = scenarioOf('rtc-with-ws-fallback', 'unicast-fallback');

        expect(bodyOf(scenario.sender).map(shapeOf)).toEqual([
            'fault.inject:rtc:until-cleared',
            'messages.send:receiver',
            'messages.observe',
            'assert',
            'messages.observe',
            'assert',
            'assert',
            'assert',
            'assert',
            'assert',
            'assert',
            'fault.inject:rtc:0'
        ]);
        expect(assertionsOf(scenario.sender)).toEqual([
            ADMITTED,
            'state equals acknowledged',
            'attemptCarriers contains rtc',
            'attemptCarriers contains ws',
            'carrierFallback.from equals rtc',
            'carrierFallback.to equals ws',
            'carrierFallback.reason equals not-ready'
        ]);
        expect(bodyOf(scenario.receiver).map(shapeOf)).toEqual(['received:1', 'wait:diagnostic']);
        const arrival = bodyOf(scenario.receiver).at(-1);
        expect(arrival?.kind === 'wait' ? arrival.match.contains : undefined)
            .toContain('"carrier":"ws","outcome":"committed","reason":"admitted"');
    });

    it('addresses the server over ws, reads its own ACK as the receipt, and proves the member receives nothing', () => {
        const scenario = scenarioOf('ws', 'server-command');

        expect(bodyOf(scenario.sender).map(shapeOf)).toEqual([
            'messages.send:server',
            'messages.observe',
            'assert',
            'messages.observe',
            'assert',
            'assert',
            'assert',
            'assert'
        ]);
        expect(assertionsOf(scenario.sender)).toEqual([ADMITTED, ...ADDRESSEE_RECEIPT]);
        expect(bodyOf(scenario.receiver).map(shapeOf)).toEqual(['received:1:absent']);
    });

    it('reconnects under a lowered byte bound, refuses the third send capacity with no attempt, and restores it', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenario = scenarioOf(carrier, 'capacity');
            const body = bodyOf(scenario.sender);

            expect(body.map(shapeOf), carrier).toEqual([
                'close',
                'rtc.connect',
                ...['messages.send', 'messages.observe', 'assert'],
                ...['messages.send', 'messages.observe', 'assert'],
                ...['messages.send', 'messages.observe', 'assert', 'assert', 'assert', 'assert'],
                ...['messages.observe', 'assert', 'messages.observe', 'assert'],
                'close',
                'rtc.connect'
            ]);
            expect(assertionsOf(scenario.sender), carrier).toEqual([
                ADMITTED,
                ADMITTED,
                'status equals rejected',
                'failure.kind equals refused',
                'failure.reason equals capacity',
                'attempts equals 0',
                'state equals acknowledged',
                'state equals acknowledged'
            ]);
            const connects = body.flatMap((command) => command.kind === 'rtc.connect' ? [command] : []);
            expect(connects.map((command) => command.rallar?.almVolatileLimits), carrier)
                .toEqual([CAPACITY_LIMITS, undefined]);
            const [arrivals, ...rest] = bodyOf(scenario.receiver);
            expect(rest, carrier).toEqual([]);
            // The sender reconnects before it sends, so the receiver's positive wait also owns one RTC readiness.
            expect(arrivals, carrier).toMatchObject({
                kind: 'messages.received',
                count: 2,
                windowMs: 57_000,
                timeoutMs: 58_000
            });
        }
    });

    it('fits two capacity sends beside the platform state sync with room to spare, and never a third', () => {
        const send = scenarioOf('rtc', 'capacity').sender.commands.find(
            isRallarBlackBoxTestMessagesSendCommand
        );
        if (send === undefined) {
            throw new Error('capacity must send.');
        }
        const message = newALMulticastMessage(
            'sender-session',
            { topicId: 'room.alm-conformance', resourceId: 'capacity', contextId: 'room-alm' },
            { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            send.typeId,
            send.payload,
            { reliability: 'at-least-once', ack: 'receiver', ttlMs: 30_000 }
        );
        const bytes = computeALMessageEnvelopeBytes(message, AL_MESSAGE_RESOURCE_LIMITS).right;
        if (bytes === undefined) {
            throw new Error('A capacity send must be measurable.');
        }

        // The two admitted sends stay counted until their deadline, so the third is refused whatever else arrived.
        expect(3 * bytes).toBeGreaterThan(CAPACITY_LIMITS.maxBytes);
        // The second send must fit beside the measured state sync, with room for that background to grow.
        expect(CAPACITY_LIMITS.maxBytes - 2 * bytes - PLATFORM_STATE_SYNC_BYTES).toBeGreaterThan(24 * 1024);
    });
});
