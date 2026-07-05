import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QRtcPeerConnectionDiagnostics } from '@shared/webrtc/QRtcPeerConnection.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';

const mocks = vi.hoisted(() => {
    const session = {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000,
    };
    const webRtcConnectionService = {
        peerIdsWithNoReconnectableLanes: vi.fn((): readonly string[] => []),
        knownPeerIds: vi.fn((): readonly string[] => []),
        activePeerIds: vi.fn((): readonly string[] => []),
        readyPeerIdsForLane: vi.fn((_laneId?: string): readonly string[] => []),
        ensurePeerConnectionStarted: vi.fn((_peerId: string) => ({
            left: {
                kind: 'connect-failed',
                peerId: _peerId,
                error: new Error('connect not mocked'),
            },
        })),
        ensurePeerLaneOpen: vi.fn(async (peerId: string, laneId: string) => ({
            status: 'connect-failed',
            peerId,
            laneId,
            error: new Error('connect not mocked'),
        })),
        disconnectPeer: vi.fn(() => true),
        onRtcPeerLifecycleDo: vi.fn(),
        readPeer: vi.fn(),
        removeRtcPeerLifecycleById: vi.fn(() => true),
    };
    webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() =>
        webRtcConnectionService
    );
    const ctx = {
        session,
        authFetch: vi.fn(),
        middleware: {
            qboxEngine: {
                wake: vi.fn(),
                stop: vi.fn(),
            },
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: vi.fn(async () => ({
                    status: 'enqueued',
                    entries: [],
                })),
                onInboxMessageDo: vi.fn(),
                removeInboxMessageCallback: vi.fn(() => true),
                stopAllHeartbeats: vi.fn(),
            },
            webRtcGroupManager: {},
            webRtcConnectionService,
            heartbeat: {
                stop: vi.fn(),
            },
            webSocketQueueBox: {
                enqueueOutboxIfAbsent: vi.fn(async () => ({
                    status: 'enqueued',
                    entries: [],
                })),
                readHealth: vi.fn(() => ({
                    sessionId: session.sessionId,
                    url: 'ws://localhost/ws',
                    readyState: 'missing',
                    isOpen: false,
                    reconnecting: false,
                    reconnectEnabled: false,
                    reconnectAttempts: 0,
                    maxReconnectAttempts: 12,
                    reconnectExhausted: false,
                })),
                close: vi.fn(),
                onAnyInboxMessageDo: vi.fn(),
                removeAnyInboxMessageCallback: vi.fn(() => true),
                socket: {
                    close: vi.fn(),
                    onWebsocketCallbacksDo: vi.fn(),
                    removeWebsocketCallbackById: vi.fn(() => true),
                },
            },
        },
    } as unknown as ApiMiddleware;

    return {
        ctx,
        hydrateStateCaches: vi.fn(() => Promise.resolve()),
        initMiddleware: vi.fn((_options?: unknown) => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        onStateCacheChange: vi.fn(() => vi.fn()),
        readSession: vi.fn(() => session),
        clientRepositoryMissing: vi.fn((_value?: unknown): unknown => {
            throw new Error(
                'Repository not found: shared.repository.client-state-snapshots',
            );
        }),
        groupRepositoryMissing: vi.fn((_value?: unknown): unknown => {
            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        }),
        webRtcConnectionService,
    };
});

vi.mock('@shared-web/browser/app-context.ts', () => ({
    clearMiddleware: vi.fn(),
    getMiddleware: vi.fn(() => mocks.ctx),
    initMiddleware: mocks.initMiddleware,
    isMiddlewareReady: mocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: mocks.onStateCacheChange,
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn(),
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
    findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
    getAllClientStateSnapshots: mocks.clientRepositoryMissing,
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.groupRepositoryMissing,
    findGroupStateSnapshotByRef: mocks.groupRepositoryMissing,
    getAllGroupStateSnapshots: mocks.groupRepositoryMissing,
}));

describe('Rallar RTC diagnostics compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.clientRepositoryMissing.mockImplementation(() => {
            throw new Error(
                'Repository not found: shared.repository.client-state-snapshots',
            );
        });
        mocks.groupRepositoryMissing.mockImplementation(() => {
            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        });
        mocks.hydrateStateCaches.mockResolvedValue(undefined);
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
            (peerId: string) => ({
                left: {
                    kind: 'connect-failed',
                    peerId,
                    error: new Error('connect not mocked'),
                },
            }),
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId: string, laneId: string) => ({
                status: 'connect-failed',
                peerId,
                laneId,
                error: new Error('connect not mocked'),
            }),
        );
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockReturnValue(
            mocks.webRtcConnectionService,
        );
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: mocks.ctx.session.sessionId,
            url: 'ws://localhost/ws',
            readyState: 'missing',
            isOpen: false,
            reconnecting: false,
            reconnectEnabled: false,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
        });
    });

    it('exposes empty RTC and WS diagnostics before connecting', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        expect(facade.rtc.status()).toEqual({
            sessionId: 'session-1',
            laneId: 'reliable',
            knownPeerIds: [],
            activePeerIds: [],
            peerIdsWithNoReconnectableLanes: [],
            readyPeerIds: [],
            peers: [],
        });
        expect(facade.rtc.knownPeerIds()).toEqual([]);
        expect(facade.rtc.activePeerIds()).toEqual([]);
        expect(facade.rtc.peerIdsWithNoReconnectableLanes()).toEqual([]);
        expect(facade.rtc.readyPeerIds()).toEqual([]);
        expect(facade.ws.status()).toEqual({
            sessionId: 'session-1',
            connectState: 'idle',
            readyState: 'missing',
            isOpen: false,
            reconnecting: false,
            reconnectEnabled: false,
            reconnectAttempts: 0,
            maxReconnectAttempts: 0,
            reconnectExhausted: false,
        });
    });

    it('exposes read-only RTC peer and lane diagnostics', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const reliableHealth = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-data-channel',
            state: 'Open',
            readyState: 'open',
        });
        const realtimeHealth = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-realtime',
            state: 'Open',
            readyState: 'open',
        });
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    state: 'Open',
                    pc: {
                        connectionState: 'connected',
                        iceConnectionState: 'connected',
                        signalingState: 'stable',
                    },
                    reconnectAttempts: 2,
                    reconnectTimer: undefined,
                    disconnectTimer: undefined,
                    makingOffer: false,
                    ignoreOffer: false,
                    iceCandidateQueue: [{}],
                    localStream: {
                        id: 'local-stream',
                    },
                    remoteStreams: new Map([['remote-stream', {}]]),
                },
            },
            channels: new Map([
                ['reliable', { readHealth: vi.fn(() => reliableHealth) }],
                ['realtime', { readHealth: vi.fn(() => realtimeHealth) }],
            ]),
        };
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        expect(facade.rtc.knownPeerIds()).toEqual(['peer-1']);
        expect(facade.rtc.activePeerIds()).toEqual(['peer-1']);
        expect(facade.rtc.peerIdsWithNoReconnectableLanes()).toEqual(['peer-1']);
        expect(facade.rtc.readyPeerIds('realtime')).toEqual(['peer-1']);
        expect(mocks.webRtcConnectionService.readyPeerIdsForLane)
            .toHaveBeenCalledWith('realtime');
        expect(facade.rtc.peer('peer-1', { laneId: 'realtime' }))
            .toMatchObject({
                peerId: 'peer-1',
                isActive: true,
                hasNoReconnectableLanes: true,
                isRoutable: true,
                readyLaneIds: ['reliable', 'realtime'],
                connection: {
                    state: 'Open',
                    connectionState: 'connected',
                    iceConnectionState: 'connected',
                    signalingState: 'stable',
                    reconnectAttempts: 2,
                    reconnecting: false,
                    disconnectPending: false,
                    iceCandidateQueueSize: 1,
                    localStreamId: 'local-stream',
                    remoteStreamIds: ['remote-stream'],
                },
                lanes: [
                    {
                        peerId: 'peer-1',
                        laneId: 'reliable',
                        channel: reliableHealth,
                        isOpen: true,
                        isReconnectable: false,
                    },
                    {
                        peerId: 'peer-1',
                        laneId: 'realtime',
                        channel: realtimeHealth,
                        isOpen: true,
                        isReconnectable: false,
                    },
                ],
            });
        expect(facade.rtc.status({ laneId: 'realtime' })).toMatchObject({
            sessionId: 'session-1',
            laneId: 'realtime',
            knownPeerIds: ['peer-1'],
            activePeerIds: ['peer-1'],
            peerIdsWithNoReconnectableLanes: ['peer-1'],
            readyPeerIds: ['peer-1'],
            peers: [
                expect.objectContaining({
                    peerId: 'peer-1',
                }),
            ],
        });
    });

    it('reads RTC diagnostics from peer stats and detects relay candidates', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const reliableHealth = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-data-channel',
            state: 'Open',
            readyState: 'open',
        });
        const connectionDiagnostics = createPeerConnectionDiagnostics({
            connectCallCount: 2,
            outboundOfferCount: 1,
            inboundAnswerCount: 1,
            reconnectAttemptCount: 1,
            pendingIceCandidateQueueLength: 3,
            reconnectAttemptsInFlight: 1,
            hasReconnectTimer: true,
        });
        const stats = new Map<string, Record<string, unknown>>([
            ['pair-1', {
                id: 'pair-1',
                type: 'candidate-pair',
                state: 'succeeded',
                nominated: true,
                selected: true,
                localCandidateId: 'local-1',
                remoteCandidateId: 'remote-1',
                currentRoundTripTime: 0.042,
                availableOutgoingBitrate: 123_456,
                bytesSent: 100,
                bytesReceived: 200,
            }],
            ['local-1', {
                id: 'local-1',
                type: 'local-candidate',
                candidateType: 'relay',
                protocol: 'udp',
                address: '10.0.0.1',
                port: 1234,
                relayProtocol: 'udp',
                networkType: 'wifi',
                url: 'turn:turn.example.test',
            }],
            ['remote-1', {
                id: 'remote-1',
                type: 'remote-candidate',
                candidateType: 'srflx',
                protocol: 'udp',
                address: '203.0.113.10',
                port: 4321,
            }],
        ]);
        const pc = {
            connectionState: 'connected',
            iceConnectionState: 'connected',
            iceGatheringState: 'complete',
            signalingState: 'stable',
            localDescription: { type: 'offer' },
            remoteDescription: { type: 'answer' },
            canTrickleIceCandidates: true,
            getStats: vi.fn(async () => stats),
        };
        const peer = {
            peerId: 'peer-1',
            connection: {
                readDiagnostics: vi.fn(() => connectionDiagnostics),
                status: {
                    state: 'Open',
                    pc,
                    reconnectAttempts: 0,
                    reconnectTimer: undefined,
                    disconnectTimer: undefined,
                    makingOffer: false,
                    ignoreOffer: false,
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                },
            },
            channels: new Map([
                ['reliable', { readHealth: vi.fn(() => reliableHealth) }],
            ]),
        };
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        const diagnostics = await facade.rtc.diagnostics({
            laneIds: ['reliable'],
        });

        expect(pc.getStats).toHaveBeenCalledOnce();
        expect(peer.connection.readDiagnostics).toHaveBeenCalledOnce();
        expect(diagnostics).toMatchObject({
            sessionId: 'session-1',
            peerCount: 1,
            connectedPeerCount: 1,
            relayPeerCount: 1,
            peers: [
                {
                    peerId: 'peer-1',
                    usesRelay: true,
                    statsAvailable: true,
                    connection: {
                        connectionState: 'connected',
                        iceConnectionState: 'connected',
                        iceGatheringState: 'complete',
                        signalingState: 'stable',
                        hasLocalDescription: true,
                        hasRemoteDescription: true,
                        canTrickleIceCandidates: true,
                    },
                    connectionDiagnostics: {
                        connectCallCount: 2,
                        outboundOfferCount: 1,
                        inboundAnswerCount: 1,
                        reconnectAttemptCount: 1,
                        pendingIceCandidateQueueLength: 3,
                        reconnectAttemptsInFlight: 1,
                        hasReconnectTimer: true,
                    },
                    selectedCandidatePair: {
                        id: 'pair-1',
                        state: 'succeeded',
                        nominated: true,
                        selected: true,
                        currentRoundTripTime: 0.042,
                        availableOutgoingBitrate: 123_456,
                        bytesSent: 100,
                        bytesReceived: 200,
                        usesRelay: true,
                        local: {
                            id: 'local-1',
                            candidateType: 'relay',
                            protocol: 'udp',
                            address: '10.0.0.1',
                            port: 1234,
                            relayProtocol: 'udp',
                            networkType: 'wifi',
                            url: 'turn:turn.example.test',
                        },
                        remote: {
                            id: 'remote-1',
                            candidateType: 'srflx',
                            protocol: 'udp',
                            address: '203.0.113.10',
                            port: 4321,
                        },
                    },
                    lanes: [
                        {
                            laneId: 'reliable',
                            channel: reliableHealth,
                        },
                    ],
                },
            ],
        });
    });
});

function createChannelHealth(
    input: Readonly<{
        peerId: string;
        label: string;
        state: string;
        readyState: RTCDataChannelState;
    }>,
) {
    return {
        peerId: input.peerId,
        label: input.label,
        state: input.state,
        role: 'Initiator',
        readyState: input.readyState,
        binaryType: 'arraybuffer' as const,
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        queuedItemCount: 0,
        rawCallbackCount: 0,
        messageCallbackCount: 0,
        lifecycleCallbackCount: 0,
        flowControl: {
            highWatermarkBytes: 64 * 1024,
            lowWatermarkBytes: 16 * 1024,
            overflow: 'drop-new' as const,
            maxQueueItems: 32,
        },
        counters: {
            sent: 0,
            queued: 0,
            dropped: 0,
            replaced: 0,
            closed: 0,
            flushed: 0,
            droppedOldest: 0,
            droppedStale: 0,
            receivedRaw: 0,
            receivedString: 0,
            receivedBinary: 0,
        },
    };
}

function createPeerConnectionDiagnostics(
    overrides: Partial<QRtcPeerConnectionDiagnostics> = {},
): QRtcPeerConnectionDiagnostics {
    return {
        connectCallCount: 0,
        connectIgnoredCount: 0,
        resetCount: 0,
        closedPeerConnectionCount: 0,
        negotiationNeededCount: 0,
        negotiationSkippedCount: 0,
        offerCreatedCount: 0,
        inboundOfferCount: 0,
        inboundAnswerCount: 0,
        inboundIceCandidateCount: 0,
        staleAnswerIgnoredCount: 0,
        offerCollisionCount: 0,
        ignoredOfferCollisionCount: 0,
        politeOfferRollbackCount: 0,
        outboundOfferCount: 0,
        outboundAnswerCount: 0,
        outboundIceCandidateCount: 0,
        queuedIceCandidateCount: 0,
        addedIceCandidateCount: 0,
        flushedIceCandidateCount: 0,
        ignoredIceCandidateForIgnoredOfferCount: 0,
        reconnectAttemptCount: 0,
        reconnectTimerAlreadyActiveCount: 0,
        reconnectExhaustedCount: 0,
        iceRestartCount: 0,
        iceRestartSkippedConnectedCount: 0,
        disconnectTimerScheduledCount: 0,
        disconnectTimerAlreadyActiveCount: 0,
        disconnectTimerClearedCount: 0,
        disconnectTimerFiredCount: 0,
        outboundSignalingErrorCount: 0,
        inboundSignalingErrorCount: 0,
        pendingIceCandidateQueueLength: 0,
        reconnectAttemptsInFlight: 0,
        hasReconnectTimer: false,
        ...overrides,
    };
}
