import { describe, expect, it } from 'vitest';

import { BrowserOutboundCongestionEpisodesSink } from '@shared-web/browser/connection/browser-outbound-congestion-episodes-sink.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';

const DEFERRED: ALOutboundRuntimeDiagnosticsEvent = {
    kind: 'congestion',
    carrier: 'ws',
    cause: 'backpressured',
    action: 'defer',
    priority: 5,
    msgId: 'm1',
    atMs: 1_000,
    traceId: 'trace-m1',
    corrId: 'm1'
};
const QUEUE_HIGH_WATER: ALOutboundRuntimeDiagnosticsEvent = { kind: 'rtc-queued-bytes-high-water', queuedBytes: 9 };
const SENT: ALDeliverySettlement = {
    kind: 'attempt-settled',
    msgId: 'm1',
    traceId: 'trace-m1',
    carrier: 'ws',
    lane: 'volatile',
    atMs: 1_240,
    attemptId: 'm1-attempt-2',
    outcome: 'sent',
    submissionAttempted: true,
    detail: undefined,
    willRetry: false
};

describe('BrowserOutboundCongestionEpisodesSink', () => {
    it('hands every diagnostic and settlement on to the connect\'s own sinks, each on its carrier', () => {
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const ws: ALDeliverySettlement[] = [];
        const rtc: ALDeliverySettlement[] = [];
        const tee = new BrowserOutboundCongestionEpisodesSink({
            diagnostics: (event) => diagnostics.push(event),
            settlements: { ws: (settlement) => ws.push(settlement), rtc: (settlement) => rtc.push(settlement) }
        });

        tee.diagnostics(DEFERRED);
        tee.diagnostics(QUEUE_HIGH_WATER);
        tee.settlements.ws(SENT);
        tee.settlements.rtc({ ...SENT, carrier: 'rtc' });

        expect(diagnostics).toEqual([DEFERRED, QUEUE_HIGH_WATER]);
        expect(ws).toEqual([SENT]);
        expect(rtc).toEqual([{ ...SENT, carrier: 'rtc' }]);
    });

    // The connect measures a deferral on one port against a settlement on another: neither port alone sees an episode.
    it('measures the episode between a deferral on the diagnostics port and its attempt\'s settlement', () => {
        const tee = new BrowserOutboundCongestionEpisodesSink({
            diagnostics: () => {},
            settlements: { ws: () => {}, rtc: () => {} }
        });

        tee.diagnostics(DEFERRED);
        expect(tee.readReport()).toMatchObject({ openEpisodes: 1, durationMs: { count: 0 } });

        tee.settlements.ws(SENT);

        expect(tee.readReport()).toMatchObject({
            openEpisodes: 0,
            unrecordedSamples: 0,
            durationMs: { count: 1, sum: 240 }
        });
    });

    // The runtime swallows a throwing sink (writeALOutboundRuntimeDiagnostic), so the episode must not depend on it.
    it('opens the episode of a deferral the application\'s diagnostics sink throws on', () => {
        const tee = new BrowserOutboundCongestionEpisodesSink({
            diagnostics: () => {
                throw new Error('application sink failed');
            },
            settlements: { ws: () => {}, rtc: () => {} }
        });

        writeALOutboundRuntimeDiagnostic(tee.diagnostics, DEFERRED);

        expect(tee.readReport().openEpisodes).toBe(1);
    });
});
