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
import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';
import {
    createBrowserTransportInput,
    initialiseMiddleware,
    toBrowserMiddleware,
    toBrowserWebSocketQueueBoxInput,
    toRtcOverlayMulticastManagerInput,
    type BrowserConnectOptions
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import * as rtcEngine from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import * as stateSnapshots from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import * as websocketFactory from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { AL_VOLATILE_SESSION_LIMITS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import * as wsClientFactory from '@shared/services/ws-queue-box-client-service.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import '../../setup-browser-indexeddb.ts';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { installNativeRtcRuntime } from '../../shared/native-rtc-connection-fixture.ts';
import { DeterministicRtcOfferIds } from '../../shared/webrtc/deterministic-rtc-offer-ids.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { createAcceptedGroupSnapshotFixture, createAcceptedOverlayFixture } from '../authoritative-group-fixtures.ts';

const SESSION: AuthSession = {
    clientId: 'client-1',
    sessionId: 'session-1',
    username: 'user',
    accessToken: 'test',
    expiresAtEpochMs: 60_000
};

const OPTIONS: BrowserConnectOptions = {
    readIceCandidates: (signal) => connectionHttp.readIceCandidates({ signal }),
    rtcCaptureConfiguration: { mode: 'off', origin: 'product-default' },
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
        }, {
            nowEpochMs: () => 1,
            createOfferId: () => 'offer',
            faultPort: createPassThroughTransportFaultPort(),
            signalingDiagnostics: capture.diagnostics,
            writeRetainedSignalsDueNow: async () => []
        });
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

describe('browser RTC layout adoption composition', () => {
    it('applies an offer the browser held for its layout as soon as the connect adopts that layout', async () => {
        const nativeRuntime = installNativeRtcRuntime();
        configureTestCacheRepositories();
        const inboundEvents: ALInboundRuntimeDiagnosticsEvent[] = [];
        const options: BrowserConnectOptions = {
            ...OPTIONS,
            diagnosticsPorts: toRallarDiagnosticsPorts({ inboundDiagnostics: (event) => inboundEvents.push(event) })
        };
        let acquired: { engine: InboxOutboxEngine; close: () => Promise<void>; } | undefined;
        onTestFinished(async () => {
            if (acquired) {
                await Promise.allSettled([acquired.close(), acquired.engine.stop()]);
            }
            nativeRuntime.dispose();
            vi.restoreAllMocks();
        });
        const doubles = createDefaultApiMiddlewareTestDouble({
            middleware: { rtcRxStreamer: { onRttMeasurementDo: () => {}, setRttReportingPeerIds: () => {} } }
        }).middleware;
        vi.spyOn(connectionHttp, 'readApiConfig').mockResolvedValue({ apiBaseUrl: 'http://test', wsBaseUrl: 'ws://test', endpoints: { createWs: '/ws' } });
        vi.spyOn(connectionHttp, 'readIceCandidates').mockResolvedValue({ iceServers: [], expiresAtEpochMs: Date.now() + 600_000 });
        vi.spyOn(JsonWebSocketClient.prototype, 'connect').mockResolvedValue();
        vi.spyOn(websocketFactory, 'createBrowserWebSocketQueueBox').mockImplementation(async (input) => {
            const queueBox = createDefaultWsQueueBoxClientService({
                sessionId: input.clientData.sessionId,
                serverPeerId: input.serverPeerId,
                socket: input.socket,
                queueEngine: input.qboxEngine,
                outbox: new InMemoryQueueBox(),
                inboundStores: input.inboundStores,
                inboundVolatileStores: input.inboundVolatileStores,
                inboundDiagnostics: input.inboundDiagnostics
            });
            acquired = { engine: input.qboxEngine, close: () => queueBox.close() };
            input.qboxEngine.start();
            return queueBox;
        });
        vi.spyOn(rtcEngine, 'initialiseRtcOverlayMulticastManager').mockReturnValue(doubles.webRtcOverlayMulticastManager);
        vi.spyOn(rtcEngine, 'initialiseRtcRxStreamer').mockReturnValue(doubles.rtcRxStreamer);
        vi.spyOn(browserStateCacheLifecycle, 'initialise').mockImplementation(() => {});
        vi.spyOn(browserStateCacheLifecycle, 'hydrate').mockResolvedValue();
        vi.spyOn(stateSnapshots, 'refreshStateSnapshots').mockResolvedValue({ clients: [], groups: [] });
        vi.spyOn(heartbeat, 'initHeartbeat').mockResolvedValue(doubles.heartbeat);

        const connected = await initialiseMiddleware(SESSION, 'rtc', options);
        const { webSocketQueueBox, webRtcGroupManager } = connected.middleware;
        await webSocketQueueBox.acceptIncomingMessage(toHeldOfferEnvelope('startup-peer'));
        // The sixth refusal leaves the offer's next retry a second out.
        await vi.waitFor(() => expect(readRetriedOfferCount(inboundEvents)).toBe(6), { timeout: 5_000 });
        expect(nativeRuntime.createdConnections).toEqual([]);

        const group = createAcceptedGroupSnapshotFixture([SESSION.sessionId, 'startup-peer']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        overlaysRepository.setAcceptedOverlayById(toScopedOverlayId(group.group), createAcceptedOverlayFixture(group, 1, ['startup-peer']));
        await webRtcGroupManager.getOrCreate(group.group).acceptGroupUpdate(group);
        await webRtcGroupManager.notifyOverlayTopologyChanged();

        await vi.waitFor(
            () => expect(nativeRuntime.createdConnections[0]?.receivedDescriptions).toEqual([{ type: 'offer', sdp: 'held-offer-sdp' }]),
            { timeout: 400 }
        );
        expect(readRetriedOfferCount(inboundEvents)).toBe(6);
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

function toHeldOfferEnvelope(senderId: string) {
    const message = newALUnicastMessage(senderId, newALEventRoute('rtc', SESSION.sessionId), SESSION.sessionId, 'rtc', {
        channel: 'RtcSignal',
        type: 'Signal',
        fromId: senderId,
        toId: SESSION.sessionId,
        sessionId: senderId,
        token: 'test-token',
        signalType: 'Offer',
        offerId: 'offer-1',
        payload: { description: { type: 'offer', sdp: 'held-offer-sdp' }, candidate: null }
    });
    return { ...message, id: { ...message.id, msgId: 'held-offer' } };
}

function readRetriedOfferCount(events: readonly ALInboundRuntimeDiagnosticsEvent[]): number {
    return events.filter((event) => event.kind === 'consumer-invocation' && event.msgId === 'held-offer' && event.outcome === 'retry').length;
}

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
        nowEpochMs: () => Date.now(),
        writeRetainedSignalsDueNow: async () => []
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

describe('failed browser startup owns acquired transport completion', () => {
    it('preserves the real WS connection Error when the startup reporting sink throws and joins acquired engine work', async () => {
        const failure = new Error('initial WS connection');
        const sinkFailure = new Error('startup reporting sink');
        const gate = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        let readFinished = false;
        let acquiredEngine: InboxOutboxEngine | undefined;
        let completed = false;
        onTestFinished(async () => {
            gate.resolve();
            if (acquiredEngine) {
                await acquiredEngine.stop();
            }
            vi.restoreAllMocks();
        });
        vi.spyOn(console, 'error').mockImplementation(() => {
            throw sinkFailure;
        });
        vi.spyOn(connectionHttp, 'readApiConfig').mockResolvedValue({ apiBaseUrl: 'http://test', wsBaseUrl: 'ws://test', endpoints: { createWs: '/ws' } });
        const original = wsClientFactory.createDefaultWsQueueBoxClientService;
        vi.spyOn(wsClientFactory, 'createDefaultWsQueueBoxClientService').mockImplementation((input) => {
            if (!input.queueEngine) {
                throw new Error('Browser startup must supply its owned queue engine');
            }
            acquiredEngine = input.queueEngine;
            input.queueEngine.includeTask('initial-connect-readiness', {
                name: 'initial-connect-readiness',
                maxConcurrency: () => 1,
                ongoingTasks: [],
                runnable: () => {},
                isWork: async () => {
                    entered.resolve();
                    await gate.promise;
                    readFinished = true;
                    return false;
                }
            });
            void input.queueEngine.executeOnce();
            return original(input);
        });
        vi.spyOn(JsonWebSocketClient.prototype, 'connect').mockImplementation(async () => {
            await entered.promise;
            throw failure;
        });
        const outcome = initialiseMiddleware(SESSION, 'rtc', OPTIONS).catch((error) => {
            completed = true;
            return error;
        });
        await entered.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
            expect(completed).toBe(false);
            expect(readFinished).toBe(false);
        }
        finally {
            gate.resolve();
        }
        expect(await outcome).toBe(failure);
        expect(readFinished).toBe(true);
    });

    it.each((['rtc-request', 'state', 'heartbeat'] as const).flatMap((boundary) => ['records', 'throws'].map((reporting) => ({ boundary, reporting }))))(
        'joins acquired WS and engine work after $boundary fails and cleanup reporting $reporting',
        async ({ boundary, reporting }) => {
            const failure = new Error(`startup-${boundary}`);
            const reported = vi.spyOn(console, 'error').mockImplementation(() => {
                if (reporting === 'throws') {
                    throw new Error('reporting failed');
                }
            });
            const cleanupFailure = new Error('secondary socket cleanup failure');
            const gate = Promise.withResolvers<void>();
            const entered = Promise.withResolvers<void>();
            const failed = Promise.withResolvers<void>();
            let completed = false;
            let readFinished = false;
            let acquired: { engine: InboxOutboxEngine; close: () => Promise<void>; } | undefined;
            onTestFinished(async () => {
                gate.resolve();
                if (acquired) {
                    await Promise.allSettled([acquired.close(), acquired.engine.stop()]);
                }
                vi.restoreAllMocks();
            });
            configureFailedStartup(boundary, failure, failed.resolve);
            const socketClosed = vi.fn();
            vi.spyOn(websocketFactory, 'createBrowserWebSocketQueueBox').mockImplementation(async (input) => {
                const service = createDefaultWsQueueBoxClientService({
                    sessionId: input.clientData.sessionId,
                    serverPeerId: input.serverPeerId,
                    socket: input.socket,
                    queueEngine: input.qboxEngine,
                    outbox: new InMemoryQueueBox(),
                    inboundStores: input.inboundStores
                });
                vi.spyOn(input.socket, 'close').mockImplementation(() => {
                    socketClosed();
                    throw cleanupFailure;
                });
                acquired = { engine: input.qboxEngine, close: () => service.close() };
                input.qboxEngine.includeTask('startup-readiness', {
                    name: 'startup-readiness',
                    maxConcurrency: () => 1,
                    ongoingTasks: [],
                    runnable: () => {},
                    isWork: async () => {
                        entered.resolve();
                        await gate.promise;
                        readFinished = true;
                        return false;
                    }
                });
                void input.qboxEngine.executeOnce();
                await entered.promise;
                return service;
            });
            const initialization = initialiseMiddleware(SESSION, 'rtc', OPTIONS);
            const rejection = initialization.catch((error) => {
                completed = true;
                return error;
            });
            await failed.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            try {
                expect(readFinished).toBe(false);
                expect(completed, 'Startup failure escaped before acquired engine completion').toBe(false);
                expect(socketClosed).toHaveBeenCalledOnce();
            }
            finally {
                gate.resolve();
            }
            expect(await rejection).toBe(failure);
            expect(reported).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    errors: [expect.objectContaining({ errors: [cleanupFailure] })]
                })
            );
            expect(readFinished).toBe(true);
        }
    );
});

function configureFailedStartup(
    boundary: 'rtc-request' | 'state' | 'heartbeat',
    failure: Error,
    failed: () => void
): void {
    const reject = async () => {
        failed();
        throw failure;
    };
    vi.spyOn(connectionHttp, 'readApiConfig').mockResolvedValue({ apiBaseUrl: 'http://test', wsBaseUrl: 'ws://test', endpoints: { createWs: '/ws' } });
    const ice = vi.spyOn(connectionHttp, 'readIceCandidates');
    if (boundary === 'rtc-request') {
        ice.mockImplementation(reject);
        return;
    }
    ice.mockResolvedValue({ iceServers: [], expiresAtEpochMs: 1000 });
    const service = createConnectionService();
    const capture = createBrowserRtcCapture({
        configuration: OPTIONS.rtcCaptureConfiguration,
        connectionId: { status: 'observed', value: 'startup' },
        record: () => {},
        nowEpochMs: () => 1
    });
    onTestFinished(() => service.disposeNativeObservations());
    const middleware =
        createDefaultApiMiddlewareTestDouble({ middleware: { rtcRxStreamer: { onRttMeasurementDo: () => {}, setRttReportingPeerIds: () => {} } } }).middleware;
    vi.spyOn(rtcEngine, 'initialiseRtcConnectionService').mockResolvedValue({ webRtcConnectionService: service, rtcCaptureReceipt: capture.receipt });
    vi.spyOn(rtcEngine, 'initialiseRtcOverlayMulticastManager').mockReturnValue(middleware.webRtcOverlayMulticastManager);
    vi.spyOn(rtcEngine, 'initialiseRtcRxStreamer').mockReturnValue(middleware.rtcRxStreamer);
    vi.spyOn(WebRtcGroupManager.prototype, 'startReconcileWakes').mockImplementation(() => {});
    vi.spyOn(browserStateCacheLifecycle, 'initialise').mockImplementation(() => {});
    const refresh = vi.spyOn(stateSnapshots, 'refreshStateSnapshots');
    if (boundary === 'state') {
        refresh.mockImplementation(reject);
        return;
    }
    refresh.mockResolvedValue({ clients: [], groups: [] });
    vi.spyOn(browserStateCacheLifecycle, 'hydrate').mockResolvedValue();
    vi.spyOn(heartbeat, 'initHeartbeat').mockImplementation(reject);
}
