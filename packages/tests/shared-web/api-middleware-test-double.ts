import { createInMemoryALInboundRuntimeStores } from '@shared/alm/ALRuntimeStores.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import { WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import { WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';
import { vi } from 'vitest';

import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, WebRtcConnectionService, type QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';

export type MiddlewareTestOverrides = {
    readonly [K in keyof RallarBrowserMiddleware]?: Partial<RallarBrowserMiddleware[K]>;
};

export interface ApiMiddlewareTestOverrides {
    readonly session?: Partial<AuthSession>;
    readonly authFetch?: ApiMiddleware['authFetch'];
    readonly middleware?: MiddlewareTestOverrides;
}

export interface ApiMiddlewareTestInput {
    readonly session: AuthSession;
    readonly authFetch: ApiMiddleware['authFetch'];
    readonly middleware: MiddlewareTestOverrides;
}

export function createDefaultApiMiddlewareTestDouble(overrides: ApiMiddlewareTestOverrides = {}): ApiMiddleware {
    return createApiMiddlewareTestDouble({
        session: { ...createDefaultTestSession(), ...overrides.session },
        authFetch: overrides.authFetch ?? vi.fn<ApiMiddleware['authFetch']>(async () => {
            throw new Error('HTTP request not configured in the facade fixture');
        }),
        middleware: overrides.middleware ?? {}
    });
}

export function createApiMiddlewareTestDouble(input: ApiMiddlewareTestInput): ApiMiddleware {
    const { session, middleware: middlewareOverrides } = input;
    const connection = createWebRtcConnectionServiceDouble(session.sessionId, middlewareOverrides.webRtcConnectionService);
    const groups = new WebRtcGroupManager(connection, {
        groupCache: new LatestRepository(),
        clientCache: new LatestRepository(),
        plannedOverlayCache: new LatestRepository(),
        acceptedOverlayCache: new LatestRepository()
    });
    const multicast = new WebRtcOverlayMulticastManager(
        new InMemoryQueueBox(),
        connection,
        new LatestRepository(),
        new LatestRepository(),
        (overlayId) => new WebRtcOverlayMulticastService(overlayId, connection)
    );

    return {
        session,
        authFetch: input.authFetch,
        middleware: {
            qboxEngine: createQboxEngineDouble(middlewareOverrides.qboxEngine),
            webSocketQueueBox: createWebSocketQueueBoxDouble(session.sessionId, middlewareOverrides.webSocketQueueBox),
            webRtcConnectionService: connection,
            rtcRxStreamer: createRtcRxStreamerDouble(session.sessionId, multicast, middlewareOverrides.rtcRxStreamer),
            webRtcGroupManager: Object.assign(groups, middlewareOverrides.webRtcGroupManager),
            webRtcOverlayMulticastManager: Object.assign(multicast, middlewareOverrides.webRtcOverlayMulticastManager),
            heartbeat: createHeartbeatDouble(session.sessionId, middlewareOverrides.heartbeat)
        }
    };
}

export function createDefaultTestSession(): AuthSession {
    return {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000
    };
}

function createQboxEngineDouble(
    override: Partial<RallarBrowserMiddleware['qboxEngine']> = {}
): RallarBrowserMiddleware['qboxEngine'] {
    return Object.assign(new InboxOutboxEngine(), {
        wake: vi.fn(),
        stop: vi.fn(),
        ...override
    });
}

function createWebSocketQueueBoxDouble(
    sessionId: string,
    override: Partial<RallarBrowserMiddleware['webSocketQueueBox']> = {}
): RallarBrowserMiddleware['webSocketQueueBox'] {
    const queueBox: RallarBrowserMiddleware['webSocketQueueBox'] = Object.assign(
        new WsQueueBoxClientService(
            { inbox: new InMemoryQueueBox(), outbox: new InMemoryQueueBox(), socket: createWebSocketClientDouble() },
            { sessionId }
        ),
        {
            enqueueOutboxIfAbsent: vi.fn(async (message: ALMessage) => ({
                status: 'enqueued' as const,
                message,
                entries: []
            })),
            readHealth: vi.fn(() => ({
                sessionId,
                url: 'ws://localhost/ws',
                readyState: 'missing' as const,
                isOpen: false,
                reconnecting: false,
                reconnectEnabled: false,
                reconnectAttempts: 0,
                maxReconnectAttempts: 12,
                reconnectExhausted: false
            })),
            close: vi.fn(),
            onAnyInboxMessageDo: vi.fn(() => queueBox),
            removeAnyInboxMessageCallback: vi.fn(() => true),
            socket: createWebSocketClientDouble(),
            ...override
        }
    );

    return queueBox;
}

function createWebSocketClientDouble(): RallarBrowserMiddleware['webSocketQueueBox']['socket'] {
    const socket: RallarBrowserMiddleware['webSocketQueueBox']['socket'] = Object.assign(new JsonWebSocketClient('ws://fixture.invalid'), {
        close: vi.fn(),
        onWebsocketCallbacksDo: vi.fn(() => socket),
        removeWebsocketCallbackById: vi.fn(() => true)
    });

    return socket;
}

function createWebRtcConnectionServiceDouble(
    sessionId: string,
    override: Partial<RallarBrowserMiddleware['webRtcConnectionService']> = {}
): RallarBrowserMiddleware['webRtcConnectionService'] {
    const connectionService: RallarBrowserMiddleware['webRtcConnectionService'] = Object.assign(
        new WebRtcConnectionService(
            { send: async () => undefined, connect: async () => undefined },
            {
                sessionId,
                token: 'fixture-token',
                iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
                dataChannelName: 'test',
                rtcSignalingTopicId: 'rtc'
            }
        ),
        {
            peerIdsWithNoReconnectableLanes: vi.fn((): readonly string[] => []),
            knownPeerIds: vi.fn((): readonly string[] => []),
            activePeerIds: vi.fn((): readonly string[] => []),
            readyPeerIdsForLane: vi.fn((): readonly string[] => []),
            ensurePeerConnectionStarted: vi.fn((peerId: string) =>
                Either.ofLeft<WebRtcConnectionService.PeerConnectionLeft, QRtcPeerDto>({
                    kind: 'connect-failed',
                    peerId,
                    error: new Error('connect not mocked')
                })
            ),
            ensurePeerLaneOpen: vi.fn(
                async (peerId: string, laneId: string = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                    status: 'connect-failed' as const,
                    peerId,
                    laneId,
                    error: new Error('connect not mocked')
                })
            ),
            disconnectPeer: vi.fn(() => true),
            readPeer: vi.fn(() => undefined),
            onRtcPeerLifecycleDo: vi.fn(() => connectionService),
            removeRtcPeerLifecycleById: vi.fn(() => true),
            ...override
        }
    );

    return connectionService;
}

function createRtcRxStreamerDouble(
    sessionId: string,
    multicast: WebRtcOverlayMulticastManager,
    override: Partial<RallarBrowserMiddleware['rtcRxStreamer']> = {}
): RallarBrowserMiddleware['rtcRxStreamer'] {
    const rtcRxStreamer: RallarBrowserMiddleware['rtcRxStreamer'] = Object.assign(
        new WebRtcRxStreamerService({
            inbox: new InMemoryQueueBox(),
            multicast,
            sessionId,
            inboundStores: createInMemoryALInboundRuntimeStores(),
            nowEpochMs: Date.now,
            heartbeat: { maxMissedPings: 5, pingFrequencyMsecs: 5000 }
        }),
        {
            enqueueOutboxIfAbsent: vi.fn(async (message: ALMessage) => ({
                status: 'enqueued' as const,
                message,
                entries: []
            })),
            onInboxMessageDo: vi.fn(() => rtcRxStreamer),
            removeInboxMessageCallback: vi.fn(() => true),
            onRemoteStreamDo: vi.fn(() => rtcRxStreamer),
            removeOnRemoteStreamCallbackById: vi.fn(() => true),
            setLocalMediaStream: vi.fn(async () => undefined),
            setLocalAudioEnabled: vi.fn(),
            setLocalVideoEnabled: vi.fn(),
            setMediaPolicy: vi.fn(),
            stopLocalMedia: vi.fn(),
            stopAllHeartbeats: vi.fn(),
            ...override
        }
    );

    return rtcRxStreamer;
}

function createHeartbeatDouble(
    sessionId: string,
    override: Partial<RallarBrowserMiddleware['heartbeat']> = {}
): RallarBrowserMiddleware['heartbeat'] {
    return {
        sessionId,
        generationId: `generation-${sessionId}`,
        stop: vi.fn(),
        ...override
    };
}
