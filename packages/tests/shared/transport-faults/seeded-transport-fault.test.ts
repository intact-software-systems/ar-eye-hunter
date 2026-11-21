import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import {
    createScriptedTransportFaultPort,
    type ScriptedTransportFault
} from '@shared/transport-faults/transport-fault-port.ts';
import { describe, expect, it } from 'vitest';

const chatFrame = JSON.stringify(newALUntargetedMessage({
    senderId: 'a',
    createdAtEpochMs: 1000,
    route: newALRoute('room.chat', 'room-1', 'r-1'),
    typeId: 'chat',
    resource: {}
}));
const moveFrame = JSON.stringify(newALUntargetedMessage({
    senderId: 'a',
    createdAtEpochMs: 1000,
    route: newALRoute('room.move', 'room-1', 'r-2'),
    typeId: 'move',
    resource: {}
}));
const chatMatch = { controlType: undefined, typeId: 'chat', msgId: undefined };
const FRAMES = 1_000;

function toLoss(seed: number, ratio: number, remaining: ScriptedTransportFault['remaining']): ScriptedTransportFault {
    return { faultId: 'lossy', carrier: 'ws', match: chatMatch, action: { loss: { ratio, seed } }, remaining };
}

/** The positions, among the matching frames sent, that the fault dropped. */
function readDroppedPositions(fault: ScriptedTransportFault, unmatchedBetween = 0): readonly number[] {
    const port = createScriptedTransportFaultPort();
    port.inject(fault);
    const dropped: number[] = [];
    for (let position = 0; position < FRAMES; position += 1) {
        for (let other = 0; other < unmatchedBetween; other += 1) {
            expect(port.decideSend(fault.carrier, moveFrame)).toEqual({ kind: 'pass' });
        }
        if (port.decideSend(fault.carrier, chatFrame).kind === 'drop') {
            dropped.push(position);
        }
    }
    return dropped;
}

function readDelays(seed: number): readonly number[] {
    const port = createScriptedTransportFaultPort();
    port.inject({
        faultId: 'jittery',
        carrier: 'ws',
        match: chatMatch,
        action: { jitter: { minDelayMs: 20, maxDelayMs: 80, seed } },
        remaining: 'until-cleared'
    });
    return Array.from({ length: FRAMES }, () => {
        const decision = port.decideSend('ws', chatFrame);
        return decision.kind === 'delay' ? decision.delayMs : Number.NaN;
    });
}

describe('seeded loss on the transport fault port', () => {
    it('drops the same frames for the same seed and about the declared share of them', () => {
        const first = readDroppedPositions(toLoss(7, 0.1, 'until-cleared'));

        expect(readDroppedPositions(toLoss(7, 0.1, 'until-cleared'))).toEqual(first);
        expect(first.length).toBeGreaterThan(60);
        expect(first.length).toBeLessThan(140);
    });

    it('drops a different set of frames for a different seed', () => {
        expect(readDroppedPositions(toLoss(8, 0.1, 'until-cleared')))
            .not.toEqual(readDroppedPositions(toLoss(7, 0.1, 'until-cleared')));
    });

    it('leaves a frame its match excludes alone and does not let it move the sequence', () => {
        expect(readDroppedPositions(toLoss(7, 0.1, 'until-cleared'), 3))
            .toEqual(readDroppedPositions(toLoss(7, 0.1, 'until-cleared')));
    });

    it('drops no more frames than its count', () => {
        const unbounded = readDroppedPositions(toLoss(7, 0.1, 'until-cleared'));

        expect(readDroppedPositions(toLoss(7, 0.1, 3))).toEqual(unbounded.slice(0, 3));
    });

    it('drops every matching frame at a ratio of one', () => {
        expect(readDroppedPositions(toLoss(7, 1, 'until-cleared'))).toHaveLength(FRAMES);
    });

    it('records each drop and nothing for a frame it let pass', () => {
        const port = createScriptedTransportFaultPort();
        port.inject(toLoss(7, 0.1, 'until-cleared'));
        let drops = 0;
        for (let position = 0; position < FRAMES; position += 1) {
            drops += port.decideSend('ws', chatFrame).kind === 'drop' ? 1 : 0;
        }

        expect(port.getObservations()).toHaveLength(drops);
        expect(port.getObservations()[0]).toEqual({ faultId: 'lossy', carrier: 'ws', decision: 'drop' });
    });

    it('starts its sequence again when the fault is injected again', () => {
        const port = createScriptedTransportFaultPort();
        const readNextTwenty = () => Array.from({ length: 20 }, () => port.decideSend('ws', chatFrame).kind);
        port.inject(toLoss(7, 0.5, 'until-cleared'));
        const first = readNextTwenty();
        port.inject(toLoss(7, 0.5, 'until-cleared'));

        expect(readNextTwenty()).toEqual(first);
    });

    it.each([0, -0.1, 1.01, Number.NaN])('refuses a ratio of %s at injection', (ratio) => {
        expect(() => createScriptedTransportFaultPort().inject(toLoss(7, ratio, 1))).toThrow(TypeError);
    });
});

describe('seeded jitter on the transport fault port', () => {
    it('delays every matching frame within its bounds, the same delays for the same seed', () => {
        const delays = readDelays(11);

        expect(readDelays(11)).toEqual(delays);
        expect(Math.min(...delays)).toBeGreaterThanOrEqual(20);
        expect(Math.max(...delays)).toBeLessThanOrEqual(80);
        expect(new Set(delays).size).toBeGreaterThan(20);
        expect(delays.every(Number.isInteger)).toBe(true);
    });

    it('gives a different seed different delays', () => {
        expect(readDelays(12)).not.toEqual(readDelays(11));
    });

    it.each([
        ['a negative minimum', { minDelayMs: -1, maxDelayMs: 10, seed: 1 }],
        ['a maximum below its minimum', { minDelayMs: 30, maxDelayMs: 10, seed: 1 }],
        ['a bound that is not a number', { minDelayMs: 0, maxDelayMs: Number.NaN, seed: 1 }]
    ])('refuses %s at injection', (_label, jitter) => {
        expect(() =>
            createScriptedTransportFaultPort().inject({
                faultId: 'jittery',
                carrier: 'ws',
                match: chatMatch,
                action: { jitter },
                remaining: 1
            })
        ).toThrow(TypeError);
    });
});
