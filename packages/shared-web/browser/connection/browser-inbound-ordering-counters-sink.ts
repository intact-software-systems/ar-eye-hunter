import {
    computeALInboundOrderingCounters,
    createALInboundOrderingCounters,
    type ALInboundOrderingCounters
} from '@shared/alm/inbound/admission/al-inbound-ordering-counters.ts';
import type {
    ALInboundRuntimeDiagnosticsEvent,
    ALInboundRuntimeDiagnosticsSink
} from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';

/**
 * One connect's inbound diagnostics port with its ordering positions counted in front of it, so the connect counts
 * whether or not the application supplied a sink, and a sink that throws loses no count.
 */
export class BrowserInboundOrderingCountersSink {
    /** Counts each event, then hands it to the wrapped sink, whose acknowledgement capture it keeps. */
    public readonly sink: ALInboundRuntimeDiagnosticsSink;
    private counters = createALInboundOrderingCounters();

    public constructor(wrapped: ALInboundRuntimeDiagnosticsSink) {
        const sink = (event: ALInboundRuntimeDiagnosticsEvent): void => {
            this.counters = computeALInboundOrderingCounters(this.counters, event);
            wrapped(event);
        };
        this.sink = wrapped.acknowledgementCapture === undefined
            ? sink
            : Object.assign(sink, { acknowledgementCapture: wrapped.acknowledgementCapture });
    }

    /** Cumulative over the connect. */
    public readReport(): ALInboundOrderingCounters {
        return this.counters;
    }
}
