import { describe, expect, it } from 'vitest';

import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import {
    decodeEdgeOrderWirePayload,
    toEdgeOrderWireJson
} from '@shared-web/browser/messages/edge-order/edge-order-wire-payload.ts';

const STAMP: EdgeOrderStamp = {
    stream: 'stream-a',
    position: 7,
    lowestOpenPosition: 5,
    earlierCanArriveUntilMs: 31_000,
    holes: []
};
const HOLED_STAMP: EdgeOrderStamp = { ...STAMP, position: 12, holes: [[6, 6], [8, 10]] };

function wire(edgeOrder: object, payload: object | string | number | boolean | null = { move: 'e4' }): string {
    return JSON.stringify({ edgeOrder, payload });
}

describe('the edge-order wire payload', () => {
    it('wraps the application payload beside its stamp, as JSON a relay carries untouched', () => {
        const json = toEdgeOrderWireJson(STAMP, JSON.stringify({ move: 'e4' }));

        // A stamp with no hole, which is nearly every stamp, spends no bytes on saying so.
        expect(JSON.parse(json)).toEqual({
            edgeOrder: { stream: 'stream-a', position: 7, lowestOpenPosition: 5, earlierCanArriveUntilMs: 31_000 },
            payload: { move: 'e4' }
        });
    });

    it('carries the holes a stamp states, and gives them back', () => {
        const json = toEdgeOrderWireJson(HOLED_STAMP, '"x"');

        expect(JSON.parse(json).edgeOrder.holes).toEqual([[6, 6], [8, 10]]);
        expect(decodeEdgeOrderWirePayload(json)).toEqual({ stamp: HOLED_STAMP, payload: 'x' });
    });

    it.each([{ move: 'e4' }, 'text', 0, false, null, [1, 2]])('gives %j back as the receiver decodes it', (payload) => {
        const decoded = decodeEdgeOrderWirePayload(toEdgeOrderWireJson(STAMP, JSON.stringify(payload)));

        expect(decoded).toEqual({ stamp: STAMP, payload });
    });

    it('reads a stamp with nothing earlier to wait for', () => {
        const stamp: EdgeOrderStamp = { ...STAMP, lowestOpenPosition: 7, earlierCanArriveUntilMs: undefined };

        expect(decodeEdgeOrderWirePayload(toEdgeOrderWireJson(stamp, '"x"'))).toEqual({ stamp, payload: 'x' });
    });

    it.each([
        ['an application payload that was never wrapped', JSON.stringify({ move: 'e4' })],
        ['text that is not JSON', 'e4'],
        ['a JSON array', '[1]'],
        ['null', 'null'],
        ['a wrapper without a payload', JSON.stringify({ edgeOrder: STAMP })],
        ['a stamp that is not an object', JSON.stringify({ edgeOrder: 7, payload: 1 })],
        ['an empty stream', wire({ ...STAMP, stream: '' })],
        ['a stream that is not text', wire({ ...STAMP, stream: 7 })],
        ['a stream longer than 64 characters', wire({ ...STAMP, stream: 's'.repeat(65) })],
        ['a position below 1', wire({ ...STAMP, position: 0, lowestOpenPosition: 0 })],
        ['a position that is not whole', wire({ ...STAMP, position: 7.5 })],
        ['a lowest open position below 1', wire({ ...STAMP, lowestOpenPosition: 0 })],
        ['a lowest open position above the position', wire({ ...STAMP, lowestOpenPosition: 8 })],
        ['a deadline that is not a number', wire({ ...STAMP, earlierCanArriveUntilMs: 'soon' })],
        [
            'a deadline that is not finite',
            '{"edgeOrder":{"stream":"stream-a","position":7,"lowestOpenPosition":5,"earlierCanArriveUntilMs":1e999},"payload":1}'
        ],
        ['holes that are not a list', wire({ ...HOLED_STAMP, holes: 6 })],
        ['a hole that is not a pair of positions', wire({ ...HOLED_STAMP, holes: [[6]] })],
        ['a hole whose end is below its start', wire({ ...HOLED_STAMP, holes: [[8, 6]] })],
        ['a hole that is not whole', wire({ ...HOLED_STAMP, holes: [[6.5, 7]] })],
        ['a hole below the lowest open position', wire({ ...HOLED_STAMP, holes: [[4, 6]] })],
        ['a hole at the lowest open position, which is open', wire({ ...HOLED_STAMP, holes: [[5, 6]] })],
        ['a hole at the stamped position', wire({ ...HOLED_STAMP, holes: [[10, 12]] })],
        ['holes that do not rise', wire({ ...HOLED_STAMP, holes: [[8, 10], [6, 6]] })],
        ['holes that touch, which are one run', wire({ ...HOLED_STAMP, holes: [[6, 7], [8, 10]] })],
        [
            'more than 16 runs of holes',
            wire({ ...HOLED_STAMP, position: 100, holes: Array.from({ length: 17 }, (_run, index) => [6 + index * 2, 6 + index * 2]) })
        ]
    ])('refuses %s', (_description, resource) => {
        expect(decodeEdgeOrderWirePayload(resource)).toBeUndefined();
    });
});
