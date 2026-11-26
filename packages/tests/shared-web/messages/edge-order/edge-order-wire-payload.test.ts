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
    earlierCanArriveUntilMs: 31_000
};

function wire(edgeOrder: object, payload: object | string | number | boolean | null = { move: 'e4' }): string {
    return JSON.stringify({ edgeOrder, payload });
}

describe('the edge-order wire payload', () => {
    it('wraps the application payload beside its stamp, as JSON a relay carries untouched', () => {
        const json = toEdgeOrderWireJson(STAMP, JSON.stringify({ move: 'e4' }));

        expect(JSON.parse(json)).toEqual({ edgeOrder: STAMP, payload: { move: 'e4' } });
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
        ['a deadline that is not a number', wire({ ...STAMP, earlierCanArriveUntilMs: 'soon' })]
    ])('refuses %s', (_description, resource) => {
        expect(decodeEdgeOrderWirePayload(resource)).toBeUndefined();
    });
});
