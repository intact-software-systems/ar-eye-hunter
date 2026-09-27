import {
    describe,
    expect,
    it
} from 'vitest';

import {
    EXPIRY_TTL_MS,
    MESSAGE_CONTROL_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { toRtcAckTrackingPlan } from '@shared/multicast/to-rtc-ack-tracking-plan.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const FALLBACK_SCENARIO_KEYS = [
    'fallback-within-deadline',
    'receipt-exhausted-fallback',
    'no-fallback-after-deadline'
];

function scenarioOf(key: string): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput('rtc-with-ws-fallback'))
        .find((candidate) => candidate.scenarioKey === key);
    if (scenario === undefined) {
        throw new Error(`rtc-with-ws-fallback must run ${key}.`);
    }
    return scenario;
}

/** The scenario's own commands: after the connect, without the storage reading and the closing stats. */
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

describe('the fallback-within-the-deadline family (D56)', () => {
    it('runs on the fallback cell only, two agents each', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const keys = createAlmConformanceRecipes(toConformanceInput(carrier))
                .map((scenario) => scenario.scenarioKey)
                .filter((key) => FALLBACK_SCENARIO_KEYS.includes(key));
            expect(keys, carrier).toEqual(
                carrier === 'rtc-with-ws-fallback' ? FALLBACK_SCENARIO_KEYS : []
            );
        }
        for (const key of FALLBACK_SCENARIO_KEYS) {
            expect(scenarioOf(key).roles, key).toEqual(['sender', 'receiver']);
        }
        expect(scenarioOf('fallback-within-deadline').tags).toEqual(['smoke', 'full']);
        expect(scenarioOf('receipt-exhausted-fallback').tags).toEqual(['full']);
        expect(scenarioOf('no-fallback-after-deadline').tags).toEqual(['full']);
    });

    it('drops the sender RTC leg until WS delivers it, and proves both carriers on the handle', () => {
        const scenario = scenarioOf('fallback-within-deadline');

        expect(bodyOf(scenario.sender).map(shapeOf)).toEqual([
            'fault.inject:rtc:until-cleared',
            'messages.send',
            'messages.observe',
            'assert',
            'messages.observe',
            'assert',
            'assert',
            'assert',
            'fault.inject:rtc:0'
        ]);
        expect(assertionsOf(scenario.sender)).toEqual([
            'state matches ^(accepted|queued|transport-accepted|acknowledged)$',
            'state equals acknowledged',
            'attemptCarriers contains rtc',
            'attemptCarriers contains ws'
        ]);
        expect(bodyOf(scenario.receiver).map(shapeOf)).toEqual([
            'received:1',
            'received:2:absent',
            'wait:diagnostic'
        ]);
        const arrival = bodyOf(scenario.receiver).at(-1);
        expect(arrival?.kind === 'wait' ? arrival.match.contains : undefined)
            .toContain('"carrier":"ws","outcome":"committed","reason":"admitted"');
    });

    it('holds the receiver RTC ACK until the receipt runs out and WS acknowledges the duplicate', () => {
        const scenario = scenarioOf('receipt-exhausted-fallback');

        expect(bodyOf(scenario.sender).map(shapeOf)).toEqual([
            'messages.send',
            'messages.observe',
            'assert',
            'messages.observe',
            'assert',
            'assert',
            'assert'
        ]);
        const observe = bodyOf(scenario.sender)[3];
        expect(observe?.kind === 'messages.observe' ? observe.timeoutMs : undefined)
            .toBe(NON_EXPIRING_SEND_TIMEOUT_MS + MESSAGE_CONTROL_TIMEOUT_MS);
        expect(bodyOf(scenario.receiver).map(shapeOf)).toEqual([
            'fault.inject:rtc:until-cleared',
            'received:1',
            'received:2:absent',
            'wait:diagnostic',
            'fault.inject:rtc:0'
        ]);
    });

    it('lets an expiring send end before the RTC receipt budget, with no WS copy (C7)', () => {
        const scenario = scenarioOf('no-fallback-after-deadline');

        expect(bodyOf(scenario.sender).map(shapeOf))
            .toEqual(['messages.send', 'messages.observe', 'assert', 'messages.observe', 'assert']);
        expect(assertionsOf(scenario.sender).at(-1)).toBe('state equals expired');
        expect(bodyOf(scenario.receiver).map(shapeOf))
            .toEqual([
                'fault.inject:rtc:until-cleared',
                'received:1',
                'wait:diagnostic:absent',
                'fault.inject:rtc:0'
            ]);
    });

    it('keeps the expiring lifetime under the default RTC receipt budget, so no receipt end precedes the deadline', () => {
        const message = newALMulticastMessage(
            'sender',
            {
                topicId: 'room.alm-conformance',
                resourceId: 'receipt-budget',
                contextId: 'room-alm'
            },
            { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            'alm.conformance',
            {},
            { reliability: 'at-least-once', ack: 'receiver', ttlMs: EXPIRY_TTL_MS }
        );

        const tracking = toRtcAckTrackingPlan(normalizeALQosPolicy(message).effective, [
            'receiver'
        ]);
        if (tracking === undefined) {
            throw new Error('A receiver-acknowledged send must track an RTC receipt.');
        }

        // The last window the RTC owner writes closes after the first timeout and every retry.
        expect(EXPIRY_TTL_MS).toBeLessThan(tracking.timeoutMs * (tracking.maxAttempts + 1));
        // The receipt-exhaustion observe outlasts that window, so the hand-over it waits for can happen inside it.
        expect(tracking.timeoutMs * (tracking.maxAttempts + 1))
            .toBeLessThan(NON_EXPIRING_SEND_TIMEOUT_MS + MESSAGE_CONTROL_TIMEOUT_MS);
    });
});
