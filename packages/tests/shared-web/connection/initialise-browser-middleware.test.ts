import { describe, expect, it, onTestFinished } from 'vitest';

import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import {
    createBrowserTransportInput,
    toBrowserWebSocketQueueBoxInput,
    toRtcOverlayMulticastManagerInput,
    type MiddlewareInitOptions
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { DeterministicRtcOfferIds } from '../../shared/webrtc/deterministic-rtc-offer-ids.ts';

const SESSION: AuthSession = {
    clientId: 'client-1',
    sessionId: 'session-1',
    username: 'user',
    accessToken: 'test',
    expiresAtEpochMs: 60_000
};

const OPTIONS: MiddlewareInitOptions = {
    qosProvider: undefined,
    readVolatileSessionLimits: () => ({ maxAdmissions: 3, maxBytes: 4_096 }),
    deliverySettlements: { ws: () => {}, rtc: () => {} },
    diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
};

describe('the one volatile bound a browser session hands its carriers (D74)', () => {
    it('gives the inbound pair, the WS client and the RTC overlay the same budget and provider', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { diagnosticsPorts: OPTIONS.diagnosticsPorts });
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
    });

    it('bounds the budget by the limits the session reads', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const { budget } = createBrowserTransportInput(SESSION, OPTIONS).volatileBound;
        const nowMs = Date.now();

        const admissions = [1, 2, 3, 4].map((index) =>
            budget.tryAdmit({ msgId: `sent-${index}`, bytes: 1, deadlineAtMs: nowMs + 30_000, nowMs }).left !== undefined
        );

        expect(admissions).toEqual([false, false, false, true]);
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
