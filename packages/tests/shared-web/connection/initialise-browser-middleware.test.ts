import { describe, expect, it, onTestFinished } from 'vitest';

import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { BrowserALSessionChannel } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import {
    createBrowserTransportInput,
    toBrowserMiddleware,
    toBrowserWebSocketQueueBoxInput,
    toRtcOverlayMulticastManagerInput,
    type BrowserConnectOptions
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { AL_VOLATILE_SESSION_LIMITS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { DeterministicRtcOfferIds } from '../../shared/webrtc/deterministic-rtc-offer-ids.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const SESSION: AuthSession = {
    clientId: 'client-1',
    sessionId: 'session-1',
    username: 'user',
    accessToken: 'test',
    expiresAtEpochMs: 60_000
};

const OPTIONS: BrowserConnectOptions = {
    qosProvider: undefined,
    readVolatileSessionLimits: () => ({ ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 3, maxBytes: 4_096 }),
    deliverySettlements: { ws: () => {}, rtc: () => {} },
    diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
    onResyncRequired: () => {},
    durableWorkOwnership: new BrowserALDurableWorkClaim({
        scope: defaultStateScope(),
        sessionId: SESSION.sessionId,
        locks: undefined,
        sessionChannel: new BrowserALSessionChannel({
            scope: defaultStateScope(),
            sessionId: SESSION.sessionId,
            instanceId: 'session-channel',
            openPort: () => undefined,
            applySettlement: () => {}
        })
    })
};

describe('the one volatile bound a browser session hands its carriers (D74)', () => {
    it('gives the inbound pair, the WS client, the RTC overlay and the middleware the same budget and provider', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const input = createBrowserTransportInput(SESSION, OPTIONS);

        const ws = toBrowserWebSocketQueueBoxInput(input, {
            qboxEngine,
            socket: new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort()),
            serverPeerId: 'server'
        });
        const rtc = toRtcOverlayMulticastManagerInput(input, {
            qboxEngine,
            webRtcConnectionService: createConnectionService()
        });

        const { budget, qosProvider } = input.volatileBound;
        expect(input.inboundVolatileStores.budget).toBe(budget);
        expect(ws.volatileBudget).toBe(budget);
        expect(ws.inboundVolatileStores).toBe(input.inboundVolatileStores);
        expect(ws.qosProvider).toBe(qosProvider);
        expect(rtc.volatileBudget).toBe(budget);
        expect(rtc.qosProvider).toBe(qosProvider);
        // The carriers stand in with a ledger of their own, which the session's must replace.
        expect(toBrowserMiddleware(input, createDefaultApiMiddlewareTestDouble().middleware).volatileBudget).toBe(budget);
    });

    it('bounds the budget by the limits the session reads', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const { budget } = createBrowserTransportInput(SESSION, OPTIONS).volatileBound;
        const nowMs = Date.now();

        const admissions = [1, 2, 3, 4].map((index) =>
            budget.tryAdmit({ msgId: `sent-${index}`, bytes: 1, deadlineAtMs: nowMs + 30_000, nowMs, trackKey: undefined }).left !== undefined
        );

        expect(admissions).toEqual([false, false, false, true]);
    });
});

describe('the durable work claim a connect hands its carriers', () => {
    it('gives the WS client and the RTC overlay the connect\'s claim', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const input = createBrowserTransportInput(SESSION, OPTIONS);

        const ws = toBrowserWebSocketQueueBoxInput(input, {
            qboxEngine,
            socket: new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort()),
            serverPeerId: 'server'
        });
        const rtc = toRtcOverlayMulticastManagerInput(input, {
            qboxEngine,
            webRtcConnectionService: createConnectionService()
        });

        expect(ws.durableWorkOwnership).toBe(OPTIONS.durableWorkOwnership);
        expect(rtc.durableWorkOwnership).toBe(OPTIONS.durableWorkOwnership);
    });
});

describe('the transport faults a connect hands its RTC overlay', () => {
    it('gives the RTC overlay the session\'s transport fault port, which its data channels decide frames by', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const input = createBrowserTransportInput(SESSION, OPTIONS);

        const rtc = toRtcOverlayMulticastManagerInput(input, {
            qboxEngine,
            webRtcConnectionService: createConnectionService()
        });

        expect(rtc.faultPort).toBe(OPTIONS.diagnosticsPorts.transportFaultPort);
    });
});

describe('the checkpoint stores a connect hands its carriers', () => {
    it('gives the WS client and the RTC overlay each the checkpoint pair of its own store', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const input = createBrowserTransportInput(SESSION, OPTIONS);
        onTestFinished(() => {
            input.checkpointStores.wsClient.checkpoint.dispose();
            input.checkpointStores.rtcOverlay.checkpoint.dispose();
        });

        const ws = toBrowserWebSocketQueueBoxInput(input, {
            qboxEngine,
            socket: new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort()),
            serverPeerId: 'server'
        });
        const rtc = toRtcOverlayMulticastManagerInput(input, {
            qboxEngine,
            webRtcConnectionService: createConnectionService()
        });

        expect(ws.checkpointStores).toBe(input.checkpointStores.wsClient);
        expect(rtc.checkpointStores).toBe(input.checkpointStores.rtcOverlay);
        expect(ws.checkpointStores.admissionStore.namespace).toBe(
            'browser:browser-ws-client-checkpoint:session-1:outbound:admission'
        );
        expect(rtc.checkpointStores.admissionStore.namespace).toBe(
            'browser:browser-rtc-overlay-checkpoint:session-1:outbound:admission'
        );
    });
});

function createConnectionService(): WebRtcConnectionService {
    return new WebRtcConnectionService({
        send: async () => undefined,
        connect: async () => undefined
    }, {
        sessionId: SESSION.sessionId,
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc-signaling'
    }, {
        faultPort: createPassThroughTransportFaultPort(),
        createOfferId: new DeterministicRtcOfferIds().createOfferId
    });
}

describe('the outbound diagnostics sink a connect hands its middleware', () => {
    it('gives the middleware the connect\'s own sink, which its carriers report to', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const input = createBrowserTransportInput(SESSION, OPTIONS);
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());

        const ws = toBrowserWebSocketQueueBoxInput(input, {
            qboxEngine,
            socket: new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort()),
            serverPeerId: 'server'
        });
        const middleware = toBrowserMiddleware(input, createDefaultApiMiddlewareTestDouble().middleware);

        expect(middleware.outboundDiagnostics).toBe(OPTIONS.diagnosticsPorts.outboundDiagnostics);
        expect(ws.outboundDiagnostics).toBe(middleware.outboundDiagnostics);
    });
});
