import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import * as rtcEngine from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import * as stateSnapshots from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import * as websocketFactory from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import '../../setup-browser-indexeddb.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { BrowserALSessionChannel } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import {
    createBrowserTransportInput,
    initialiseMiddleware,
    toBrowserWebSocketQueueBoxInput,
    toRtcOverlayMulticastManagerInput,
    type BrowserConnectOptions
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

const OPTIONS: BrowserConnectOptions = {
    rtcCaptureConfiguration: { mode: 'off', origin: 'product-default' },
    qosProvider: undefined,
    readVolatileSessionLimits: () => ({ maxAdmissions: 3, maxBytes: 4_096 }),
    deliverySettlements: { ws: () => {}, rtc: () => {} },
    diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
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

describe('native observation handoff cleanup', () => {
    it.each(['rtc-transport', 'middleware'] as const)('disposes the original diagnostic scope on %s handoff failure', async (boundary) => {
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const events: RtcSignalingDiagnostics.Event[] = [];
        const capture = createBrowserRtcCapture({
            configuration: { mode: 'native', origin: 'step' },
            connectionId: { status: 'observed', value: 'handoff' },
            record: (event) => events.push(event),
            nowEpochMs: () => 1
        });
        const service = new WebRtcConnectionService({ connect: async () => {}, send: async () => {} }, {
            sessionId: SESSION.sessionId,
            token: 'test',
            dataChannelName: 'test',
            rtcSignalingTopicId: 'rtc',
            iceCandidates: { iceServers: [], expiresAtEpochMs: 1000 }
        }, { nowEpochMs: () => 1, createOfferId: () => 'offer', faultPort: createPassThroughTransportFaultPort(), signalingDiagnostics: capture.diagnostics });
        onTestFinished(() => service.disposeNativeObservations());
        const middleware = createDefaultApiMiddlewareTestDouble({
            middleware: { rtcRxStreamer: { onRttMeasurementDo: () => {}, setRttReportingPeerIds: () => {} } }
        });
        const failure = new Error('handoff-failure');
        vi.spyOn(connectionHttp, 'readApiConfig').mockResolvedValue({ apiBaseUrl: 'http://test', wsBaseUrl: 'ws://test', endpoints: { createWs: '/ws' } });
        vi.spyOn(connectionHttp, 'readIceCandidates').mockResolvedValue({ iceServers: [], expiresAtEpochMs: 1000 });
        vi.spyOn(websocketFactory, 'createBrowserWebSocketQueueBox').mockResolvedValue(middleware.middleware.webSocketQueueBox);
        vi.spyOn(rtcEngine, 'initialiseRtcConnectionService').mockResolvedValue({ webRtcConnectionService: service, rtcCaptureReceipt: capture.receipt });
        vi.spyOn(WebRtcGroupManager.prototype, 'startReconcileWakes').mockImplementation(() => {});
        const overlay = vi.spyOn(rtcEngine, 'initialiseRtcOverlayMulticastManager');
        if (boundary === 'rtc-transport') {
            overlay.mockImplementation(() => {
                throw failure;
            });
        }
        else {
            overlay.mockReturnValue(middleware.middleware.webRtcOverlayMulticastManager);
            vi.spyOn(rtcEngine, 'initialiseRtcRxStreamer').mockReturnValue(middleware.middleware.rtcRxStreamer);
            vi.spyOn(browserStateCacheLifecycle, 'initialise').mockImplementation(() => {});
            vi.spyOn(stateSnapshots, 'refreshStateSnapshots').mockRejectedValue(failure);
        }
        await expect(initialiseMiddleware(SESSION, 'rtc', OPTIONS)).rejects.toBe(failure);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'native-observation-status', stage: 'disposed' }));
        expect(capture.diagnostics?.nativeObservation?.status === 'available' && capture.diagnostics.nativeObservation.scope.getActive()).toBe(false);
    });
});

describe('browser connection construction identity', () => {
    it('captures a fresh opaque identity independently of the signaling request source', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const source = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-0000-0000-000000000052');
        onTestFinished(() => source.mockRestore());
        const constructed = createBrowserTransportInput(SESSION, OPTIONS);
        expect(constructed.connectionId).toEqual({ status: 'observed', value: '00000000-0000-0000-0000-000000000052' });
        expect(constructed.creation.newConnectionRequestId()).not.toBe('00000000-0000-0000-0000-000000000052');
    });

    it('keeps identity-source failure as evidence while constructing the normal carrier inputs', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const source = vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
            throw new Error('identity unavailable');
        });
        onTestFinished(() => source.mockRestore());
        const constructed = createBrowserTransportInput(SESSION, OPTIONS);
        expect(constructed.connectionId).toEqual({ status: 'unavailable', reason: 'identity-source-failed' });
        expect(constructed.clientData).toEqual({ clientId: 'client-1', sessionId: 'session-1', isOnline: true });
        expect(constructed.options).toBe(OPTIONS);
    });
});

describe('the one volatile bound a browser session hands its carriers (D74)', () => {
    it('gives the inbound pair, the WS client and the RTC overlay the same budget and provider', () => {
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
    });

    it('bounds the budget by the limits the session reads', () => {
        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
        const { budget } = createBrowserTransportInput(SESSION, OPTIONS).volatileBound;
        const nowMs = Date.now();

        const admissions = [1, 2, 3, 4].map((index) =>
            budget.tryAdmit({ msgId: `sent-${index}`, bytes: 1, deadlineAtMs: nowMs + 30_000, nowMs }).left !== undefined
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
        createOfferId: new DeterministicRtcOfferIds().createOfferId,
        nowEpochMs: () => Date.now()
    });
}
