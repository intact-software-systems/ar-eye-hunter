import { describe, expect, it } from 'vitest';

import { BrowserInboundOrderingCountersSink } from '@shared-web/browser/connection/browser-inbound-ordering-counters-sink.ts';
import {
    recordALInboundDiagnostic,
    type ALInboundRuntimeDiagnosticsEvent,
    type ALInboundRuntimeDiagnosticsSink
} from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { ALInboundAcknowledgementEvidence } from '@shared/alm/inbound/control/al-inbound-acknowledgement-evidence.ts';
import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';

const ENTERED = toOrderingPosition('entered');
const WITNESSED = toOrderingPosition('witnessed');
const UNDECODED: ALInboundRuntimeDiagnosticsEvent = {
    kind: 'undecoded-rejection',
    carrier: 'rtc',
    fromPeerId: 'peer-a',
    rejection: 'malformed'
};

describe('BrowserInboundOrderingCountersSink', () => {
    it('hands every event to the wrapped sink, in order, and counts the ordering positions among them', () => {
        const forwarded: ALInboundRuntimeDiagnosticsEvent[] = [];
        const tee = new BrowserInboundOrderingCountersSink((event) => forwarded.push(event));

        tee.sink(ENTERED);
        tee.sink(UNDECODED);
        tee.sink(WITNESSED);
        tee.sink(WITNESSED);

        expect(forwarded).toEqual([ENTERED, UNDECODED, WITNESSED, WITNESSED]);
        expect(tee.readReport()).toEqual({ entered: 1, omitted: 0, witnessed: 2, beforeEntry: 0 });
    });

    it('reads zero for every status before any event', () => {
        expect(new BrowserInboundOrderingCountersSink(() => {}).readReport())
            .toEqual({ entered: 0, omitted: 0, witnessed: 0, beforeEntry: 0 });
    });

    it('keeps the wrapped sink\'s acknowledgement capture, which the inbound runtime creates its evidence through', () => {
        const capture = { evidence: ALInboundAcknowledgementEvidence, batchObservations: ALWorkBatchObservations };
        const wrapped: ALInboundRuntimeDiagnosticsSink = Object.assign(() => {}, { acknowledgementCapture: capture });

        expect(new BrowserInboundOrderingCountersSink(wrapped).sink.acknowledgementCapture).toBe(capture);
    });

    it('adds no acknowledgement capture to a sink that has none', () => {
        expect(new BrowserInboundOrderingCountersSink(() => {}).sink.acknowledgementCapture).toBeUndefined();
    });

    // The runtime swallows a throwing sink (recordALInboundDiagnostic), so the count must not depend on the wrapped one.
    it('counts an event the wrapped sink throws on', () => {
        const tee = new BrowserInboundOrderingCountersSink(() => {
            throw new Error('application sink failed');
        });

        recordALInboundDiagnostic(tee.sink, ENTERED);
        recordALInboundDiagnostic(tee.sink, ENTERED);

        expect(tee.readReport()).toEqual({ entered: 2, omitted: 0, witnessed: 0, beforeEntry: 0 });
    });
});

function toOrderingPosition(
    status: Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'ordering-position'; }>['status']
): ALInboundRuntimeDiagnosticsEvent {
    return {
        kind: 'ordering-position',
        workerId: 'worker-1',
        trackKey: 'track-a',
        seq: 3,
        priorSeq: 2,
        status,
        carrier: 'rtc',
        traceId: 'trace-1',
        corrId: 'corr-1'
    };
}
