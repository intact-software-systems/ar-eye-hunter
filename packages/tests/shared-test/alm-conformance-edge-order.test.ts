import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

type Carrier = (typeof ALM_CONFORMANCE_CARRIERS)[number];

const STREAM_SENDS = 8;
const EDGE_ORDER_CELLS = [
    ['edge-order-stream', 'ws'],
    ['edge-order-stream', 'rtc'],
    ['edge-order-stream', 'rtc-with-ws-fallback'],
    ['edge-order-jitter-stream', 'ws']
] as const;

function findCell(key: string, carrier: Carrier): AlmConformanceScenario | undefined {
    return createAlmConformanceRecipes(toConformanceInput(carrier)).find((scenario) => scenario.scenarioKey === key);
}

function requireCell(key: string, carrier: Carrier): AlmConformanceScenario {
    const cell = findCell(key, carrier);
    if (cell === undefined) {
        throw new Error(`Missing ${key} over ${carrier}.`);
    }
    return cell;
}

function findCommand(recipe: RallarBlackBoxTestRecipe, name: string): RallarBlackBoxTestCommand {
    const command = recipe.commands.find((candidate) => candidate.commandId === `${recipe.recipeId}-${name}`);
    if (command === undefined) {
        throw new Error(`${recipe.recipeId} has no ${name}.`);
    }
    return command;
}

function toPlace(recipe: RallarBlackBoxTestRecipe, name: string): number {
    return recipe.commands.indexOf(findCommand(recipe, name));
}

function toSends(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestMessagesSendCommand[] {
    return recipe.commands.filter((command): command is RallarBlackBoxTestMessagesSendCommand => command.kind === 'messages.send');
}

describe('the edge order lane cells', () => {
    it('run the swapped stream on every carrier and the jittered one over ws alone, in the full scope', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            expect(requireCell('edge-order-stream', carrier).tags).toEqual(['full']);
            expect(findCell('edge-order-jitter-stream', carrier)?.tags).toEqual(carrier === 'ws' ? ['full'] : undefined);
        }
    });

    it.each(EDGE_ORDER_CELLS)('%s over %s: both pages connect with their channels declared edge-ordered', (key, carrier) => {
        const cell = requireCell(key, carrier);

        for (const recipe of [cell.sender, cell.receiver]) {
            expect(findCommand(recipe, 'connect')).toMatchObject({ kind: 'rtc.connect', rallar: { channelOrder: 'edge' } });
        }
    });

    it('declares no order on a cell that asks for none', () => {
        const baseline = requireCell('delivery-baseline', 'ws');

        expect(findCommand(baseline.sender, 'connect')).not.toMatchObject({ rallar: { channelOrder: 'edge' } });
    });

    it.each(EDGE_ORDER_CELLS)('%s over %s: its sends are receipted room sends that state no hop order', (key, carrier) => {
        const sends = toSends(requireCell(key, carrier).sender);

        expect(sends.map((send) => send.payload)).toEqual(
            Array.from({ length: STREAM_SENDS }, (_, index) => ({ marker: key, seq: index + 1 }))
        );
        for (const send of sends) {
            expect(send).toMatchObject({ carrier, reliability: 'at-least-once', ack: 'receiver' });
            expect(send).not.toHaveProperty('orderingKey');
            expect(send).not.toHaveProperty('seq');
        }
    });

    it.each(EDGE_ORDER_CELLS)('%s over %s: send 2 is released only once send 3 is acknowledged, and every send ends acknowledged', (key, carrier) => {
        const sender = requireCell(key, carrier).sender;
        const holdCarrier = carrier === 'ws' ? 'ws' : 'rtc';

        expect(findCommand(sender, `hold-message-2-${holdCarrier}`)).toMatchObject({
            kind: 'fault.inject',
            match: { msgId: `{resultCache.${sender.recipeId}-send-2.value.msgId}` },
            remaining: 'until-cleared'
        });
        expect(toPlace(sender, 'send-3')).toBeGreaterThan(toPlace(sender, 'send-2'));
        expect(toPlace(sender, 'assert-acknowledged-3')).toBeGreaterThan(toPlace(sender, 'send-3'));
        expect(toPlace(sender, `release-message-2-${holdCarrier}`)).toBeGreaterThan(toPlace(sender, 'assert-acknowledged-3'));
        expect(toPlace(sender, 'send-4')).toBeGreaterThan(toPlace(sender, `release-message-2-${holdCarrier}`));
        for (let seq = 1; seq <= STREAM_SENDS; seq += 1) {
            expect(findCommand(sender, `assert-acknowledged-${seq}`)).toMatchObject({ operator: 'equals', expected: 'acknowledged' });
        }
    });

    it.each(EDGE_ORDER_CELLS)(
        '%s over %s: the receiver held the send that overtook, then recorded all eight in send order, none twice, and no gap',
        (key, carrier) => {
            const receiver = requireCell(key, carrier).receiver;
            const typeId = `alm.conformance.${carrier}.${key}`;

            expect(findCommand(receiver, 'held-overtaking-send')).toMatchObject({
                kind: 'wait',
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.inbound_diagnostics',
                    payloadFields: { 'data.kind': 'edge-order-arrival', 'data.outcome': 'held', 'data.typeId': typeId }
                }
            });
            expect(findCommand(receiver, `received-${STREAM_SENDS}`)).toMatchObject({
                kind: 'messages.received',
                typeId,
                count: STREAM_SENDS,
                absent: false,
                ascendingBy: 'seq'
            });
            expect(findCommand(receiver, `received-${STREAM_SENDS + 1}`)).toMatchObject({ count: STREAM_SENDS + 1, absent: true });
            expect(findCommand(receiver, 'no-order-gap')).toMatchObject({
                kind: 'wait',
                absent: true,
                match: { kind: 'diagnostic', payloadFields: { 'data.kind': 'edge-order-gap' } }
            });
        }
    );

    it('the jittered cell arms a seeded delay before its first send and proves every send met one', () => {
        const sender = requireCell('edge-order-jitter-stream', 'ws').sender;
        const release = findCommand(sender, 'jitter-release');

        expect(findCommand(sender, 'jitter-arm')).toMatchObject({
            kind: 'fault.inject',
            carrier: 'ws',
            match: { typeId: 'alm.conformance.ws.edge-order-jitter-stream' },
            action: { jitter: { minDelayMs: 0, maxDelayMs: 80, seed: expect.any(Number) } },
            remaining: 'until-cleared'
        });
        expect(toPlace(sender, 'jitter-arm')).toBeLessThan(toPlace(sender, 'send-1'));
        expect(findCommand(sender, 'assert-jitter-delayed')).toEqual(expect.objectContaining({
            kind: 'assert',
            source: `resultCache.${release.commandId}.value.acted.delay`,
            operator: 'gte',
            expected: STREAM_SENDS
        }));
    });
});
