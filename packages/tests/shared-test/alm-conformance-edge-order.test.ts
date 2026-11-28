import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { bindAlmReloadPair, toAlmReloadCheckpoints } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
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
                match: {
                    kind: 'diagnostic',
                    payloadFields: { 'data.kind': 'edge-order-gap', 'data.typeId': typeId },
                    sinceCommandIdPrefix: `${receiver.recipeId}-`
                }
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

const LOSS_STREAM_SENDS = 20;
const NEW_EDGE_ORDER_KEYS = ['edge-order-loss-stream', 'edge-order-reload', 'edge-order-late-join'] as const;
const NEW_EDGE_ORDER_CELLS = NEW_EDGE_ORDER_KEYS.flatMap((key) => ALM_CONFORMANCE_CARRIERS.map((carrier) => [key, carrier] as const));
const RELOAD_KEYS = ['edge-order-reload', 'edge-order-late-join'] as const;
const RELOAD_CELLS = RELOAD_KEYS.flatMap((key) => ALM_CONFORMANCE_CARRIERS.map((carrier) => [key, carrier] as const));

function toNumbers(from: number, to: number): readonly number[] {
    return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

function toTypeId(key: string, carrier: Carrier): string {
    return `alm.conformance.${carrier}.${key}`;
}

function toRoot(recipe: RallarBlackBoxTestRecipe, agentId: string) {
    return {
        kind: 'command' as const,
        protocolVersion: 1 as const,
        runId: 'run',
        agentId,
        commandId: `${agentId}-root`,
        command: { kind: 'recipe.run' as const, recipe, timeoutMs: 180_000 }
    };
}

describe('the edge order lane cells beyond the swapped stream', () => {
    it.each(NEW_EDGE_ORDER_CELLS)('%s over %s runs in the full scope with both pages edge-ordered', (key, carrier) => {
        const cell = requireCell(key, carrier);

        expect(cell.tags).toEqual(['full']);
        for (const recipe of [cell.sender, cell.receiver]) {
            expect(findCommand(recipe, 'connect')).toMatchObject({ kind: 'rtc.connect', rallar: { channelOrder: 'edge' } });
        }
    });

    it.each(NEW_EDGE_ORDER_CELLS)('%s over %s: every send is a receipted room send that states no hop order', (key, carrier) => {
        const cell = requireCell(key, carrier);

        for (const send of [...toSends(cell.sender), ...toSends(cell.receiver)]) {
            expect(send).toMatchObject({ carrier, typeId: toTypeId(key, carrier), reliability: 'at-least-once', ack: 'receiver' });
            expect(send).not.toHaveProperty('orderingKey');
            expect(send).not.toHaveProperty('seq');
        }
    });
});

describe('edge-order-loss-stream', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('over %s sends 1 acknowledged, then 2 to 20 under the held seeded loss, released after the last', (carrier) => {
        const sender = requireCell('edge-order-loss-stream', carrier).sender;
        const lossCarrier = carrier === 'ws' ? 'ws' : 'rtc';
        const arm = findCommand(sender, 'loss-arm');

        expect(toSends(sender).map((send) => send.payload)).toEqual(
            toNumbers(1, LOSS_STREAM_SENDS).map((seq) => ({ marker: 'edge-order-loss-stream', seq }))
        );
        expect(arm).toMatchObject({
            kind: 'fault.inject',
            carrier: lossCarrier,
            match: { typeId: toTypeId('edge-order-loss-stream', carrier) },
            action: { loss: { ratio: expect.any(Number), seed: expect.any(Number) } },
            remaining: 'until-cleared'
        });
        expect(findCommand(sender, 'loss-release')).toMatchObject({ faultId: (arm as { faultId: string; }).faultId, remaining: 0 });
        expect(toPlace(sender, 'assert-acknowledged-1')).toBeGreaterThan(toPlace(sender, 'send-1'));
        expect(toPlace(sender, 'loss-arm')).toBeGreaterThan(toPlace(sender, 'assert-acknowledged-1'));
        expect(toPlace(sender, 'send-2')).toBeGreaterThan(toPlace(sender, 'loss-arm'));
        expect(toPlace(sender, 'loss-release')).toBeGreaterThan(toPlace(sender, `send-${LOSS_STREAM_SENDS}`));
        expect(findCommand(sender, 'assert-loss-dropped')).toMatchObject({
            kind: 'assert',
            source: `resultCache.${sender.recipeId}-loss-release.value.acted.drop`,
            operator: 'gte',
            expected: 1
        });
        for (const seq of toNumbers(2, LOSS_STREAM_SENDS)) {
            expect(toPlace(sender, `assert-acknowledged-${seq}`)).toBeGreaterThan(toPlace(sender, 'assert-loss-dropped'));
            expect(findCommand(sender, `assert-acknowledged-${seq}`)).toMatchObject({ expected: 'acknowledged' });
        }
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s the receiver held a later send, then recorded all twenty in send order, none twice, and no gap of its type',
        (carrier) => {
            const receiver = requireCell('edge-order-loss-stream', carrier).receiver;
            const typeId = toTypeId('edge-order-loss-stream', carrier);

            expect(findCommand(receiver, 'held-after-lost-send')).toMatchObject({
                kind: 'wait',
                match: { payloadFields: { 'data.kind': 'edge-order-arrival', 'data.outcome': 'held', 'data.typeId': typeId } }
            });
            expect(findCommand(receiver, `received-${LOSS_STREAM_SENDS}`)).toMatchObject({
                typeId,
                count: LOSS_STREAM_SENDS,
                absent: false,
                ascendingBy: 'seq'
            });
            expect(findCommand(receiver, `received-${LOSS_STREAM_SENDS + 1}`)).toMatchObject({ count: LOSS_STREAM_SENDS + 1, absent: true });
            expect(findCommand(receiver, 'no-order-gap')).toMatchObject({
                absent: true,
                match: {
                    payloadFields: { 'data.kind': 'edge-order-gap', 'data.typeId': typeId },
                    sinceCommandIdPrefix: `${receiver.recipeId}-`
                }
            });
        }
    );
});

describe('the edge order reload cells', () => {
    it.each(RELOAD_CELLS)('%s over %s binds as a reload pair whose sender reloads right after its prefix', (key, carrier) => {
        const { sender, receiver } = requireCell(key, carrier);
        const checkpoints = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints);
        const checkpoint = checkpoints?.[0];

        expect(checkpoints).toHaveLength(1);
        expect(receiver.metadata?.almReloadCheckpoints).toEqual(checkpoints);
        expect(bindAlmReloadPair({ sender: toRoot(sender, 'sender'), receiver: toRoot(receiver, 'receiver') }).left).toBeUndefined();
        expect(checkpoint?.senderReload).toBe(`${sender.recipeId}-reload`);
        expect(toPlace(sender, 'reload')).toBe(sender.commands.findIndex((command) => command.commandId === checkpoint?.senderPrefixEnd) + 1);
        expect(findCommand(sender, 'reconnect')).toMatchObject({
            kind: 'rtc.connect',
            rallar: { restoreSession: true, username: '', password: '', channelOrder: 'edge' }
        });
        expect(toPlace(sender, 'reconnect')).toBe(toPlace(sender, 'reload') + 1);
    });
});

describe('edge-order-reload', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s the old document holds send 2 under a deadline-long lifetime until it ends, and the new one sends 4 to 8',
        (carrier) => {
            const sender = requireCell('edge-order-reload', carrier).sender;
            const holdCarrier = carrier === 'ws' ? 'ws' : 'rtc';
            const sends = toSends(sender);
            const send2 = sends.find((send) => send.commandId === `${sender.recipeId}-send-2`);
            const send3 = sends.find((send) => send.commandId === `${sender.recipeId}-send-3`);
            const reload = toPlace(sender, 'reload');

            expect(sends.map((send) => (send.payload as { seq: number; }).seq)).toEqual(toNumbers(1, STREAM_SENDS));
            expect(send2?.ttlMs).toBe(18_000);
            expect(send3?.ttlMs).toBeGreaterThan(18_000);
            expect(findCommand(sender, `hold-message-2-${holdCarrier}`)).toMatchObject({ remaining: 'until-cleared' });
            expect(sender.commands.some((command) => command.commandId?.startsWith(`${sender.recipeId}-release-message-2`))).toBe(false);
            expect(toPlace(sender, 'hold-message-2-' + holdCarrier)).toBeLessThan(toPlace(sender, 'send-3'));
            expect(toPlace(sender, 'assert-acknowledged-1')).toBeLessThan(toPlace(sender, 'send-2'));
            expect(toPlace(sender, 'assert-acknowledged-3')).toBe(reload - 1);
            for (const seq of toNumbers(4, STREAM_SENDS)) {
                expect(toPlace(sender, `send-${seq}`)).toBeGreaterThan(toPlace(sender, 'reconnect'));
                expect(findCommand(sender, `assert-acknowledged-${seq}`)).toMatchObject({ expected: 'acknowledged' });
            }
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)('over %s the receiver holds 3 before the reload, records 1, 4 to 8, then 3, and states 2 cannot arrive', (carrier) => {
        const { sender, receiver } = requireCell('edge-order-reload', carrier);
        const typeId = toTypeId('edge-order-reload', carrier);
        const [checkpoint] = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints) ?? [];
        const handedOver = [1, 4, 5, 6, 7, 8, 3];
        const turnBySeq = new Map(
            toSends(sender).map((send) => {
                const payload = send.payload as { seq: number; turn?: number; };
                return [payload.seq, payload.turn];
            })
        );

        expect(handedOver.map((seq) => turnBySeq.get(seq))).toEqual(toNumbers(1, handedOver.length));
        expect(turnBySeq.get(2)).toBeUndefined();
        expect(checkpoint?.receiverAbsenceEnd).toBe(`${receiver.recipeId}-held-overtaking-send`);
        expect(findCommand(receiver, 'held-overtaking-send')).toMatchObject({
            match: { payloadFields: { 'data.kind': 'edge-order-arrival', 'data.outcome': 'held', 'data.typeId': typeId } }
        });
        expect(findCommand(receiver, 'received-7')).toMatchObject({ typeId, count: 7, absent: false, ascendingBy: 'turn' });
        expect(findCommand(receiver, 'held-send-cannot-arrive')).toMatchObject({
            kind: 'wait',
            match: {
                payloadFields: {
                    'data.kind': 'edge-order-gap',
                    'data.typeId': typeId,
                    'data.fromPosition': 2,
                    'data.toPosition': 2,
                    'data.reason': 'cannot-arrive'
                }
            }
        });
        expect(findCommand(receiver, 'held-send-cannot-arrive')).not.toHaveProperty('absent');
        expect(findCommand(receiver, 'received-8')).toMatchObject({ count: 8, absent: true });
    });
});

describe('edge-order-late-join', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s the receiver role sends the stream: 1 to 3 acknowledged and 4 held before the reload, 5 to 8 after it, then cancels 4',
        (carrier) => {
            const { sender, receiver } = requireCell('edge-order-late-join', carrier);
            const [checkpoint] = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints) ?? [];
            const holdCarrier = carrier === 'ws' ? 'ws' : 'rtc';
            const absenceEnd = receiver.commands.findIndex((command) => command.commandId === checkpoint?.receiverAbsenceEnd);
            const recoveryEnd = receiver.commands.findIndex((command) => command.commandId === checkpoint?.receiverRecoveryEnd);

            expect(toSends(sender)).toEqual([]);
            expect(toSends(receiver).map((send) => send.payload)).toEqual(
                toNumbers(1, STREAM_SENDS).map((seq) => ({ marker: 'edge-order-late-join', seq }))
            );
            expect(toPlace(receiver, 'hold-message-4-' + holdCarrier)).toBeGreaterThan(toPlace(receiver, 'assert-acknowledged-3'));
            expect(toPlace(receiver, 'hold-message-4-' + holdCarrier)).toBeLessThan(absenceEnd);
            expect(toPlace(receiver, 'assert-acknowledged-3')).toBeLessThan(absenceEnd);
            for (const seq of toNumbers(5, STREAM_SENDS)) {
                expect(toPlace(receiver, `send-${seq}`)).toBeGreaterThan(recoveryEnd);
                expect(findCommand(receiver, `assert-acknowledged-${seq}`)).toMatchObject({ expected: 'acknowledged' });
            }
            expect(receiver.commands.some((command) => command.commandId === `${receiver.recipeId}-assert-acknowledged-4`)).toBe(false);
            expect(toPlace(receiver, 'cancel-4')).toBeGreaterThan(toPlace(receiver, `assert-acknowledged-${STREAM_SENDS}`));
            expect(findCommand(receiver, 'assert-cancelled-4')).toMatchObject({ operator: 'equals', expected: 'cancelled' });
            expect(toPlace(receiver, `release-message-4-${holdCarrier}`)).toBeGreaterThan(toPlace(receiver, 'assert-cancelled-4'));
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s the reloaded page held its first arrival for entry, then recorded 5 to 8 alone in send order and no gap',
        (carrier) => {
            const { sender } = requireCell('edge-order-late-join', carrier);
            const [checkpoint] = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints) ?? [];
            const typeId = toTypeId('edge-order-late-join', carrier);
            const secondRun = toNumbers(5, STREAM_SENDS).length;

            expect(checkpoint?.senderSuffixEnd).toBe(`${sender.recipeId}-reconnect`);
            expect(findCommand(sender, 'held-at-entry')).toMatchObject({
                match: { payloadFields: { 'data.kind': 'edge-order-arrival', 'data.outcome': 'held', 'data.typeId': typeId } }
            });
            expect(toPlace(sender, 'held-at-entry')).toBeGreaterThan(toPlace(sender, 'reconnect'));
            expect(findCommand(sender, `received-${secondRun}`)).toMatchObject({ typeId, count: secondRun, absent: false, ascendingBy: 'seq' });
            expect(findCommand(sender, `received-${secondRun + 1}`)).toMatchObject({ count: secondRun + 1, absent: true });
            expect(findCommand(sender, 'no-order-gap')).toMatchObject({
                absent: true,
                match: {
                    payloadFields: { 'data.kind': 'edge-order-gap', 'data.typeId': typeId },
                    sinceCommandIdPrefix: `${sender.recipeId}-`
                }
            });
        }
    );
});

describe('edge-order-unretried-loss-stream', () => {
    const KEY = 'edge-order-unretried-loss-stream';
    /**
     * What the seeded loss takes of sends 2 to 19 over `ws`, where a lost frame is gone and each send is one draw. Over
     * the RTC carriers the page submits a dropped frame again after 50 ms, and each new attempt is a draw of its own:
     * a hosted run of 2026-11-27 lost 2, 3, 9, 11, 14 and 19 where three local runs lost 2, 3, 9, 13 and 16.
     */
    const WS_LOST_RUNS = [[2, 3], [9, 9], [13, 13], [16, 16]] as const;
    const WS_ARRIVING = 15;
    const RTC_CARRIERS = ALM_CONFORMANCE_CARRIERS.filter((carrier) => carrier !== 'ws');

    it.each(ALM_CONFORMANCE_CARRIERS)('over %s runs in the full scope with both pages edge-ordered', (carrier) => {
        const cell = requireCell(KEY, carrier);

        expect(cell.tags).toEqual(['full']);
        for (const recipe of [cell.sender, cell.receiver]) {
            expect(findCommand(recipe, 'connect')).toMatchObject({ kind: 'rtc.connect', rallar: { channelOrder: 'edge' } });
        }
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('over %s sends twenty best-effort room sends that ask no receipt, 2 to 19 under the held seeded loss', (carrier) => {
        const sender = requireCell(KEY, carrier).sender;
        const sends = toSends(sender);

        expect(sends.map((send) => send.payload)).toEqual(toNumbers(1, LOSS_STREAM_SENDS).map((seq) => ({ marker: KEY, seq })));
        for (const send of sends) {
            expect(send).toMatchObject({ carrier, typeId: toTypeId(KEY, carrier), reliability: 'best-effort', ack: 'none' });
            expect(send).not.toHaveProperty('orderingKey');
            expect(send).not.toHaveProperty('seq');
        }
        expect(findCommand(sender, 'loss-arm')).toMatchObject({
            kind: 'fault.inject',
            carrier: carrier === 'ws' ? 'ws' : 'rtc',
            match: { typeId: toTypeId(KEY, carrier) },
            action: { loss: { ratio: 0.25, seed: 7 } },
            remaining: 'until-cleared'
        });
        expect(toPlace(sender, 'send-1')).toBeLessThan(toPlace(sender, 'loss-arm'));
        expect(toPlace(sender, 'loss-arm')).toBeLessThan(toPlace(sender, 'send-2'));
        expect(toPlace(sender, 'send-19')).toBeLessThan(toPlace(sender, 'loss-release'));
        expect(toPlace(sender, 'loss-release')).toBeLessThan(toPlace(sender, 'send-20'));
        expect(findCommand(sender, 'assert-loss-dropped')).toMatchObject({ operator: 'gte', expected: 1 });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('over %s the receiver waits for the last send, which leaves after the loss', (carrier) => {
        const receiver = requireCell(KEY, carrier).receiver;

        expect(findCommand(receiver, 'received-last-send')).toMatchObject({
            kind: 'wait',
            match: {
                equals: { marker: KEY, seq: LOSS_STREAM_SENDS },
                payloadFields: { 'data.typeId': toTypeId(KEY, carrier) }
            }
        });
    });

    it('over ws the receiver records exactly the sends that arrive, in send order, and states each lost run as a gap', () => {
        const receiver = requireCell(KEY, 'ws').receiver;
        const typeId = toTypeId(KEY, 'ws');

        expect(findCommand(receiver, `received-${WS_ARRIVING}`)).toMatchObject({ typeId, count: WS_ARRIVING, absent: false, ascendingBy: 'seq' });
        expect(findCommand(receiver, `received-${WS_ARRIVING + 1}`)).toMatchObject({ typeId, count: WS_ARRIVING + 1, absent: true });
        expect(toPlace(receiver, 'received-last-send')).toBeLessThan(toPlace(receiver, `received-${WS_ARRIVING}`));
        for (const [from, to] of WS_LOST_RUNS) {
            const gap = findCommand(receiver, `gap-${from}-${to}`);
            expect(gap).toMatchObject({
                kind: 'wait',
                match: {
                    payloadFields: {
                        'data.kind': 'edge-order-gap',
                        'data.typeId': typeId,
                        'data.fromPosition': from,
                        'data.toPosition': to,
                        'data.reason': 'ended-at-sender'
                    }
                }
            });
            expect(gap).not.toHaveProperty('absent');
        }
    });

    it.each(RTC_CARRIERS)(
        'over %s the receiver claims only what holds at any pace: what it was handed is in send order, none twice',
        (carrier) => {
            const receiver = requireCell(KEY, carrier).receiver;

            expect(findCommand(receiver, 'received-2')).toMatchObject({
                typeId: toTypeId(KEY, carrier),
                count: 2,
                absent: false,
                ascendingBy: 'seq'
            });
            expect(toPlace(receiver, 'received-last-send')).toBeLessThan(toPlace(receiver, 'received-2'));
            const claimed = receiver.commands.map((command) => (command.commandId ?? '').slice(receiver.recipeId.length + 1));
            expect(claimed.filter((name) => name.startsWith('received-'))).toEqual(['received-last-send', 'received-2']);
            expect(claimed.filter((name) => name.startsWith('gap-') || name.startsWith('late-'))).toEqual([]);
        }
    );
});

describe('edge-order-audiences', () => {
    const KEY = 'edge-order-audiences';
    const SENDS = 7;
    const LIST = { recipientPeers: ['receiver'] };
    const PRINCIPAL = { scope: 'principal', principalId: '{auth.clientId}' };
    /** Each recipient is inside one narrowed audience, whose two sends it receives, and outside the other. */
    const NARROWED_BY_ROLE = { receiver: [2, 6], sibling: [3, 7] } as const;
    const RECIPIENT_CELLS = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) => (['receiver', 'sibling'] as const).map((role) => [carrier, role] as const));

    function requireRecipient(cell: AlmConformanceScenario, role: keyof typeof NARROWED_BY_ROLE): RallarBlackBoxTestRecipe {
        const recipe = role === 'receiver' ? cell.receiver : cell.sibling;
        if (recipe === undefined) {
            throw new Error(`${cell.scenarioKey} declares no ${role}.`);
        }
        return recipe;
    }

    it.each(ALM_CONFORMANCE_CARRIERS)('over %s runs in the full scope on the sender\'s principal twice, every page edge-ordered', (carrier) => {
        const cell = requireCell(KEY, carrier);

        expect(cell.tags).toEqual(['full']);
        expect(cell.laneFamily).toBe('same-principal');
        expect(cell.roles).toEqual(['sender', 'receiver', 'sibling']);
        for (const recipe of [cell.sender, requireRecipient(cell, 'receiver'), requireRecipient(cell, 'sibling')]) {
            expect(findCommand(recipe, 'connect')).toMatchObject({ kind: 'rtc.connect', rallar: { channelOrder: 'edge' } });
        }
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s sends seven receipted sends that state no hop order: to the room, the receiver\'s list, the sender\'s principal',
        (carrier) => {
            const sends = toSends(requireCell(KEY, carrier).sender);

            expect(sends.map((send) => send.payload)).toEqual(toNumbers(1, SENDS).map((seq) => ({ marker: KEY, seq })));
            sends.forEach((send, index) => {
                const seq = index + 1;
                expect(send).toMatchObject({ reliability: 'at-least-once', ack: 'receiver' });
                expect(send).not.toHaveProperty('orderingKey');
                expect(send).not.toHaveProperty('seq');
                if (seq === 2 || seq === 6) {
                    expect(send).toMatchObject(LIST);
                }
                else if (seq === 3 || seq === 7) {
                    expect(send).toMatchObject(PRINCIPAL);
                }
                else {
                    expect(send).not.toHaveProperty('recipientPeers');
                    expect(send).not.toHaveProperty('scope');
                }
            });
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s sends 1 to 3 before it waits for them, holds room send 4 while 5, 6 and 7 are acknowledged, then releases it and sees it acknowledged',
        (carrier) => {
            const sender = requireCell(KEY, carrier).sender;
            const faultCarriers = carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [carrier];
            const names = [
                'send-1',
                'send-2',
                'send-3',
                'observe-acknowledged-1',
                'observe-acknowledged-2',
                'observe-acknowledged-3',
                'send-4',
                ...faultCarriers.map((faultCarrier) => `hold-message-4-${faultCarrier}`),
                'send-5',
                'observe-acknowledged-5',
                'send-6',
                'observe-acknowledged-6',
                'send-7',
                'observe-acknowledged-7',
                ...faultCarriers.map((faultCarrier) => `release-message-4-${faultCarrier}`),
                'observe-acknowledged-4'
            ];
            const places = names.map((name) => toPlace(sender, name));

            expect(places).toEqual([...places].sort((left, right) => left - right));
            for (const faultCarrier of faultCarriers) {
                expect(findCommand(sender, `hold-message-4-${faultCarrier}`)).toMatchObject({
                    kind: 'fault.inject',
                    match: { msgId: `{resultCache.${sender.recipeId}-send-4.value.msgId}` },
                    remaining: 'until-cleared'
                });
            }
            for (const seq of toNumbers(1, SENDS)) {
                expect(findCommand(sender, `assert-acknowledged-${seq}`)).toMatchObject({ operator: 'equals', expected: 'acknowledged' });
            }
        }
    );

    it.each(RECIPIENT_CELLS)(
        'over %s the %s held the room send that overtook, was handed the room stream and its own stream each in send order, and states no gap',
        (carrier, role) => {
            const cell = requireCell(KEY, carrier);
            const recipient = requireRecipient(cell, role);
            const typeId = toTypeId(KEY, carrier);
            const [first, second] = NARROWED_BY_ROLE[role];
            const outside = NARROWED_BY_ROLE[role === 'receiver' ? 'sibling' : 'receiver'];
            const toOrdinal = (seq: number) => `resultCache.${recipient.recipeId}-received-seq-${seq}.value.event.history.ordinal`;

            expect(findCommand(recipient, 'held-overtaking-send')).toMatchObject({
                kind: 'wait',
                match: { payloadFields: { 'data.kind': 'edge-order-arrival', 'data.outcome': 'held', 'data.typeId': typeId } }
            });
            for (const seq of [1, 4, 5, first, second]) {
                expect(findCommand(recipient, `received-seq-${seq}`)).toMatchObject({
                    match: { equals: { marker: KEY, seq }, payloadFields: { 'data.typeId': typeId } }
                });
            }
            for (const seq of outside) {
                expect(() => findCommand(recipient, `received-seq-${seq}`)).toThrow();
            }
            for (const [later, earlier] of [[4, 1], [5, 4], [second, first], [5, second]] as const) {
                expect(findCommand(recipient, `assert-seq-${later}-after-seq-${earlier}`)).toMatchObject({
                    kind: 'assert',
                    operator: 'gte',
                    source: toOrdinal(later),
                    comparisonSource: toOrdinal(earlier)
                });
            }
            expect(findCommand(recipient, 'received-5')).toMatchObject({ typeId, count: 5, absent: false });
            expect(findCommand(recipient, 'received-5')).not.toHaveProperty('ascendingBy');
            expect(findCommand(recipient, 'received-6')).toMatchObject({ count: 6, absent: true });
            expect(findCommand(recipient, 'no-order-gap')).toMatchObject({
                absent: true,
                match: { sinceCommandIdPrefix: `${recipient.recipeId}-` }
            });
        }
    );
});

describe('edge-order-supersedence', () => {
    const KEY = 'edge-order-supersedence';
    const SENDS = 4;
    const KEYED_SENDS = [2, 3];

    it.each(ALM_CONFORMANCE_CARRIERS)('over %s runs in the full scope with both pages edge-ordered', (carrier) => {
        const cell = requireCell(KEY, carrier);

        expect(cell.tags).toEqual(['full']);
        for (const recipe of [cell.sender, cell.receiver]) {
            expect(findCommand(recipe, 'connect')).toMatchObject({ kind: 'rtc.connect', rallar: { channelOrder: 'edge' } });
        }
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('over %s sends four receipted room sends that state no hop order, 2 and 3 under one latest-wins key', (carrier) => {
        const sends = toSends(requireCell(KEY, carrier).sender);

        expect(sends.map((send) => send.payload)).toEqual(toNumbers(1, SENDS).map((seq) => ({ marker: KEY, seq })));
        sends.forEach((send, index) => {
            expect(send).toMatchObject({ reliability: 'at-least-once', ack: 'receiver' });
            expect(send).not.toHaveProperty('orderingKey');
            expect(send).not.toHaveProperty('seq');
            if (KEYED_SENDS.includes(index + 1)) {
                expect(send).toMatchObject({ supersedenceKey: `${toTypeId(KEY, carrier)}.cursor` });
            }
            else {
                expect(send).not.toHaveProperty('supersedenceKey');
            }
        });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s holds send 2 until send 3 has superseded it and is acknowledged, then releases it and sends 4',
        (carrier) => {
            const sender = requireCell(KEY, carrier).sender;
            const faultCarriers = carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [carrier];
            const names = [
                'observe-acknowledged-1',
                'send-2',
                ...faultCarriers.map((faultCarrier) => `hold-message-2-${faultCarrier}`),
                'send-3',
                'observe-superseded-2',
                'observe-acknowledged-3',
                ...faultCarriers.map((faultCarrier) => `release-message-2-${faultCarrier}`),
                'send-4',
                'observe-acknowledged-4'
            ];
            const places = names.map((name) => toPlace(sender, name));

            expect(places).toEqual([...places].sort((left, right) => left - right));
            expect(findCommand(sender, 'assert-superseded-2')).toMatchObject({ operator: 'equals', expected: 'superseded' });
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s the receiver records 1, 3 and 4 in send order, states 2 as a hole its sender ended, and held nothing',
        (carrier) => {
            const receiver = requireCell(KEY, carrier).receiver;
            const typeId = toTypeId(KEY, carrier);

            expect(findCommand(receiver, 'received-3')).toMatchObject({ typeId, count: 3, absent: false, ascendingBy: 'seq' });
            expect(findCommand(receiver, 'gap-2-2')).toMatchObject({
                kind: 'wait',
                match: {
                    payloadFields: {
                        'data.kind': 'edge-order-gap',
                        'data.typeId': typeId,
                        'data.fromPosition': 2,
                        'data.toPosition': 2,
                        'data.reason': 'ended-at-sender'
                    }
                }
            });
            expect(findCommand(receiver, 'gap-2-2')).not.toHaveProperty('absent');
            expect(findCommand(receiver, 'no-held-arrival')).toMatchObject({
                absent: true,
                match: {
                    payloadFields: { 'data.kind': 'edge-order-arrival', 'data.outcome': 'held', 'data.typeId': typeId },
                    sinceCommandIdPrefix: `${receiver.recipeId}-`
                }
            });
            expect(findCommand(receiver, 'received-4')).toMatchObject({ count: 4, absent: true });
            expect(toPlace(receiver, 'received-3')).toBeLessThan(toPlace(receiver, 'no-held-arrival'));
        }
    );
});

describe('edge-order-live-stream', () => {
    const KEY = 'edge-order-live-stream';
    const PUBLICATION = { cadenceMs: 2000, retainNewest: 2, drain: { messages: 8, bytes: 65536 } };

    /** A count of arrivals spans the sender's send budget, its RTC layout wait, and one cadence past `opportunity`. */
    function toArrivalWindow(carrier: Carrier, opportunity: number) {
        const timeoutMs = 28_000 + (carrier === 'ws' ? 0 : 90_000) + (opportunity + 1) * PUBLICATION.cadenceMs;
        return { windowMs: timeoutMs - 1_000, timeoutMs };
    }

    it.each(ALM_CONFORMANCE_CARRIERS)('over %s runs in the full scope with both pages edge-ordered', (carrier) => {
        const cell = requireCell(KEY, carrier);

        expect(cell.tags).toEqual(['full']);
        for (const recipe of [cell.sender, cell.receiver]) {
            expect(findCommand(recipe, 'connect')).toMatchObject({ kind: 'rtc.connect', rallar: { channelOrder: 'edge' } });
        }
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s publishes three live values on one stream, 1 and 2 with the 30 s lifetime, so neither expires on the stage while held',
        (carrier) => {
            const sender = requireCell(KEY, carrier).sender;
            const sends = toSends(sender);

            expect(sends.map((send) => send.commandId)).toEqual([0, 1, 2].map((seq) => `${sender.recipeId}-send-${seq}`));
            sends.forEach((send, seq) => {
                expect(send).toMatchObject({ purpose: 'live', publication: PUBLICATION, resourceId: `alm-${KEY}` });
                expect(send.payload).toEqual({ specimen: 'paced', seq });
                expect(send).not.toHaveProperty('orderingKey');
                expect(send).not.toHaveProperty('reliability');
                expect(send).not.toHaveProperty('ack');
            });
            expect(sends[0]).not.toHaveProperty('ttlMs');
            expect(sends[1]).toMatchObject({ ttlMs: 30000 });
            expect(sends[2]).toMatchObject({ ttlMs: 30000 });
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s holds value 1 until value 2 is admitted and value 1 superseded, then releases it',
        (carrier) => {
            const sender = requireCell(KEY, carrier).sender;
            const faultCarriers = carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [carrier];
            const names = [
                'observe-transport-accepted-0',
                'send-1',
                ...faultCarriers.map((faultCarrier) => `hold-message-1-${faultCarrier}`),
                'send-2',
                'observe-transport-accepted-2',
                'observe-superseded-1',
                ...faultCarriers.map((faultCarrier) => `release-message-1-${faultCarrier}`)
            ];
            const places = names.map((name) => toPlace(sender, name));

            expect(places).toEqual([...places].sort((left, right) => left - right));
            expect(findCommand(sender, 'assert-superseded-1')).toMatchObject({ operator: 'equals', expected: 'superseded' });
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'over %s the receiver is handed values 0 and 2 in order, states value 1 as a hole its sender ended, and claims no late drop',
        (carrier) => {
            const receiver = requireCell(KEY, carrier).receiver;
            const typeId = toTypeId(KEY, carrier);

            expect(findCommand(receiver, 'received-1')).toMatchObject({ count: 1, absent: false, ...toArrivalWindow(carrier, 0) });
            for (const seq of [0, 2]) {
                expect(findCommand(receiver, `arrived-seq-${seq}`)).toMatchObject({
                    match: { equals: { specimen: 'paced', seq }, payloadFields: { 'data.typeId': typeId } }
                });
            }
            expect(findCommand(receiver, 'received-2')).toMatchObject({
                count: 2,
                absent: false,
                ascendingBy: 'seq',
                ...toArrivalWindow(carrier, 2)
            });
            expect(findCommand(receiver, 'gap-2-2')).toMatchObject({
                kind: 'wait',
                match: {
                    payloadFields: {
                        'data.kind': 'edge-order-gap',
                        'data.typeId': typeId,
                        'data.fromPosition': 2,
                        'data.toPosition': 2,
                        'data.reason': 'ended-at-sender'
                    }
                }
            });
            expect(findCommand(receiver, 'gap-2-2')).not.toHaveProperty('absent');
            expect(findCommand(receiver, 'received-3')).toMatchObject({ count: 3, absent: true, windowMs: 4000, timeoutMs: 5000 });
            expect(JSON.stringify(receiver.commands)).not.toContain('"data.outcome":"late"');
        }
    );
});
