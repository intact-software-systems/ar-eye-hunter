import { vi } from 'vitest';

import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto, type WebRtcPeerConnectionLeft } from '@shared/services/WebRtcConnectionService.ts';

export type MiddlewareTestOverrides = {
    readonly [K in keyof RallarBrowserMiddleware]?: Partial<RallarBrowserMiddleware[K]>;
};

export interface ApiMiddlewareTestOverrides {
    readonly session?: Partial<AuthSession>;
    readonly authFetch?: ApiMiddleware['authFetch'];
    readonly middleware?: MiddlewareTestOverrides;
}

export function createApiMiddlewareTestDouble(
    overrides: ApiMiddlewareTestOverrides = {}
): ApiMiddleware {
    const session: AuthSession = { ...createDefaultTestSession(), ...overrides.session };
    const middlewareOverrides = overrides.middleware ?? {};

    return {
        session,
        authFetch: overrides.authFetch ?? vi.fn(),
        middleware: {
            qboxEngine: createQboxEngineDouble(middlewareOverrides.qboxEngine),
            webSocketQueueBox: createWebSocketQueueBoxDouble(
                session.sessionId,
                middlewareOverrides.webSocketQueueBox
            ),
            webRtcConnectionService: createWebRtcConnectionServiceDouble(
                middlewareOverrides.webRtcConnectionService
            ),
            rtcRxStreamer: createRtcRxStreamerDouble(middlewareOverrides.rtcRxStreamer),
            webRtcGroupManager: toServiceTestDouble<RallarBrowserMiddleware['webRtcGroupManager']>({
                ...middlewareOverrides.webRtcGroupManager
            }),
            webRtcOverlayMulticastManager: toServiceTestDouble<RallarBrowserMiddleware['webRtcOverlayMulticastManager']>({
                ...middlewareOverrides.webRtcOverlayMulticastManager
            }),
            heartbeat: createHeartbeatDouble(middlewareOverrides.heartbeat)
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

// The seven RallarBrowserMiddleware members are concrete service classes holding private state, so a double can
// only supply the public members the browser facade actually calls. This is the single place in the
// test tree that asserts that partial shape onto the real service type: every default below and
// every override key is still checked against the production signatures.
function toServiceTestDouble<TService>(members: Partial<TService>): TService {
    return members as TService;
}

function createQboxEngineDouble(
    override: Partial<RallarBrowserMiddleware['qboxEngine']> = {}
): RallarBrowserMiddleware['qboxEngine'] {
    return toServiceTestDouble<RallarBrowserMiddleware['qboxEngine']>({
        wake: vi.fn(),
        stop: vi.fn(),
        ...override
    });
}

function createWebSocketQueueBoxDouble(
    sessionId: string,
    override: Partial<RallarBrowserMiddleware['webSocketQueueBox']> = {}
): RallarBrowserMiddleware['webSocketQueueBox'] {
    const queueBox: RallarBrowserMiddleware['webSocketQueueBox'] = toServiceTestDouble<RallarBrowserMiddleware['webSocketQueueBox']>({
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
    });

    return queueBox;
}

function createWebSocketClientDouble(): RallarBrowserMiddleware['webSocketQueueBox']['socket'] {
    const socket: RallarBrowserMiddleware['webSocketQueueBox']['socket'] = toServiceTestDouble<RallarBrowserMiddleware['webSocketQueueBox']['socket']>({
        close: vi.fn(),
        onWebsocketCallbacksDo: vi.fn(() => socket),
        removeWebsocketCallbackById: vi.fn(() => true)
    });

    return socket;
}

function createWebRtcConnectionServiceDouble(
    override: Partial<RallarBrowserMiddleware['webRtcConnectionService']> = {}
): RallarBrowserMiddleware['webRtcConnectionService'] {
    const connectionService: RallarBrowserMiddleware['webRtcConnectionService'] = toServiceTestDouble<RallarBrowserMiddleware['webRtcConnectionService']>({
        peerIdsWithNoReconnectableLanes: vi.fn((): readonly string[] => []),
        knownPeerIds: vi.fn((): readonly string[] => []),
        activePeerIds: vi.fn((): readonly string[] => []),
        readyPeerIdsForLane: vi.fn((): readonly string[] => []),
        ensurePeerConnectionStarted: vi.fn((peerId: string) =>
            Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
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
    });

    return connectionService;
}

function createRtcRxStreamerDouble(
    override: Partial<RallarBrowserMiddleware['rtcRxStreamer']> = {}
): RallarBrowserMiddleware['rtcRxStreamer'] {
    const rtcRxStreamer: RallarBrowserMiddleware['rtcRxStreamer'] = toServiceTestDouble<RallarBrowserMiddleware['rtcRxStreamer']>({
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
    });

    return rtcRxStreamer;
}

// `sessionId` and `generationId` are deliberately absent unless overridden: the twenty-two doubles
// this factory replaces all stub `heartbeat` with `stop` alone, and the room workflows read
// `generationId` as `undefined` in assertions such as leave-room.test.ts.
function createHeartbeatDouble(
    override: Partial<RallarBrowserMiddleware['heartbeat']> = {}
): RallarBrowserMiddleware['heartbeat'] {
    return toServiceTestDouble<RallarBrowserMiddleware['heartbeat']>({
        stop: vi.fn(),
        ...override
    });
}
