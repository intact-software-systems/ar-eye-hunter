import {
    decodeTransportFaultActedCounts,
    toTransportFaultActedCounts
} from '@shared/transport-faults/to-transport-fault-acted-counts.ts';
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { describe, expect, it } from 'vitest';

function toFrame(typeId: string): string {
    return JSON.stringify({ id: { msgId: `msg-${typeId}` }, payload: { typeId } });
}

describe('what a transport fault has acted on', () => {
    it('counts each decision of the named fault and none of another fault', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'drops',
            carrier: 'ws',
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: 'drop',
            remaining: 2
        });
        port.inject({
            faultId: 'delays',
            carrier: 'ws',
            match: { controlType: undefined, typeId: 'move', msgId: undefined },
            action: { delayMs: 5 },
            remaining: 'until-cleared'
        });
        port.decideSend('ws', toFrame('chat'));
        port.decideSend('ws', toFrame('move'));
        port.decideSend('ws', toFrame('chat'));
        port.decideSend('ws', toFrame('chat'));
        port.decideSend('ws', toFrame('move'));
        port.decideSend('ws', toFrame('move'));

        expect(toTransportFaultActedCounts(port.getObservations(), 'drops'))
            .toEqual({ drop: 2, delay: 0, rewrite: 0, 'not-ready': 0, backpressure: 0 });
        expect(toTransportFaultActedCounts(port.getObservations(), 'delays'))
            .toEqual({ drop: 0, delay: 3, rewrite: 0, 'not-ready': 0, backpressure: 0 });
    });

    it('answers zeros for a fault that never acted', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'idle',
            carrier: 'rtc',
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: 'drop',
            remaining: 'until-cleared'
        });

        expect(toTransportFaultActedCounts(port.getObservations(), 'idle'))
            .toEqual({ drop: 0, delay: 0, rewrite: 0, 'not-ready': 0, backpressure: 0 });
        expect(toTransportFaultActedCounts(port.getObservations(), 'never-injected'))
            .toEqual({ drop: 0, delay: 0, rewrite: 0, 'not-ready': 0, backpressure: 0 });
    });
});

describe('acted counts read from a page', () => {
    it('reads a whole record back as it was written', () => {
        const counts = { drop: 2, delay: 1, rewrite: 0, 'not-ready': 0, backpressure: 4 };

        expect(decodeTransportFaultActedCounts(counts).right).toEqual(counts);
    });

    it.each([
        ['a missing decision', { drop: 2, delay: 1, rewrite: 0, 'not-ready': 0 }, 'backpressure'],
        ['a count that is no number', { drop: '2', delay: 1, rewrite: 0, 'not-ready': 0, backpressure: 0 }, 'drop'],
        ['a negative count', { drop: 2, delay: -1, rewrite: 0, 'not-ready': 0, backpressure: 0 }, 'delay'],
        ['a fractional count', { drop: 2, delay: 1, rewrite: 0.5, 'not-ready': 0, backpressure: 0 }, 'rewrite'],
        ['a value that is no object', 3, 'object']
    ])('refuses %s and says which', (_label, value, named) => {
        const decoded = decodeTransportFaultActedCounts(value);

        expect(decoded.right).toBeUndefined();
        expect(decoded.left).toContain(named);
    });
});
