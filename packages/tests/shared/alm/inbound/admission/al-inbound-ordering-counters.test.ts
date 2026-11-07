import { describe, expect, it } from 'vitest';

import {
    computeALInboundOrderingCounters,
    createALInboundOrderingCounters,
    type ALInboundOrderingCounters
} from '@shared/alm/inbound/admission/al-inbound-ordering-counters.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';

type OrderingStatus = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'ordering-position'; }>['status'];

const NONE: ALInboundOrderingCounters = { entered: 0, omitted: 0, witnessed: 0, beforeEntry: 0 };

describe('ALInboundOrderingCounters', () => {
    it('starts at zero for every status', () => {
        expect(createALInboundOrderingCounters()).toEqual(NONE);
    });

    it.each<[OrderingStatus, keyof ALInboundOrderingCounters]>([
        ['entered', 'entered'],
        ['omitted', 'omitted'],
        ['witnessed', 'witnessed'],
        ['before-entry', 'beforeEntry']
    ])('counts a %s position under %s and leaves the other keys', (status, key) => {
        expect(computeALInboundOrderingCounters(NONE, toOrderingPosition(status))).toEqual({ ...NONE, [key]: 1 });
    });

    it('returns the counters it was given for an event that states no position', () => {
        const counters: ALInboundOrderingCounters = { entered: 2, omitted: 1, witnessed: 0, beforeEntry: 3 };
        const event: ALInboundRuntimeDiagnosticsEvent = {
            kind: 'undecoded-rejection',
            carrier: 'rtc',
            fromPeerId: 'peer-a',
            rejection: 'malformed'
        };

        expect(computeALInboundOrderingCounters(counters, event)).toBe(counters);
    });

    // A refused copy keeps no dedup row, so each repeat arrival below the position states another before-entry (S4-i).
    it('counts events, not distinct copies: the same before-entry copy stated twice counts twice', () => {
        const repeat = toOrderingPosition('before-entry');

        const counters = [repeat, repeat].reduce(computeALInboundOrderingCounters, createALInboundOrderingCounters());

        expect(counters).toEqual({ ...NONE, beforeEntry: 2 });
    });
});

function toOrderingPosition(status: OrderingStatus): ALInboundRuntimeDiagnosticsEvent {
    return {
        kind: 'ordering-position',
        workerId: 'worker-1',
        trackKey: 'track-a',
        seq: 3,
        priorSeq: 2,
        status,
        carrier: 'ws',
        traceId: 'trace-1',
        corrId: 'corr-1'
    };
}
