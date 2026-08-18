import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QRtcPeerDto } from '@shared/services/WebRtcConnectionService.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/QRtcDataChannel.ts';
import type { QRtcPeerConnectionDiagnostics } from '@shared/webrtc/QRtcPeerConnection.ts';

// The factories below annotate their return type on purpose: without it the contextual type of a
// `vi.mock` factory is a union, and TypeScript then accepts an export name the module does not
// have. With the annotation a renamed or removed export fails the type check.
type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type DataCachesModule = typeof import('@shared-web/browser/data-caches.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsModule =
    typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsModule =
    typeof import('@shared/repository/group-state-snapshots-repository.ts');

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        './api-middleware-test-double.ts'
    );
    const ctx = createApiMiddlewareTestDouble();

    return {
        ctx,
        webRtcConnectionService: ctx.middleware.webRtcConnectionService,
        webSocketQueueBox: ctx.middleware.webSocketQueueBox,
        hydrateStateCaches: vi.fn(() => Promise.resolve()),
        initMiddleware: vi.fn(() => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        onStateCacheChange: vi.fn(() => vi.fn()),
        readSession: vi.fn(() => ctx.session),
        clientRepositoryMissing: vi.fn((): never => {
            throw new Error(
                'Repository not found: shared.repository.client-state-snapshots',
            );
        }),
        groupRepositoryMissing: vi.fn((): never => {
            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        }),
    };
});

vi.mock(
    import('@shared-web/browser/app-context.ts'),
    (): Partial<AppContextModule> => ({
        clearMiddleware: vi.fn(),
        getMiddleware: vi.fn(() => mocks.ctx),
        initMiddleware: mocks.initMiddleware,
        isMiddlewareReady: mocks.isMiddlewareReady,
    }),
);

vi.mock(
    import('@shared-web/browser/data-caches.ts'),
    (): Partial<DataCachesModule> => ({
        hydrateStateCaches: mocks.hydrateStateCaches,
        onStateCacheChange: mocks.onStateCacheChange,
    }),
);

vi.mock(
    import('@shared/api/auth.ts'),
    (): Partial<AuthModule> => ({
        clearSession: vi.fn(),
        isLoggedIn: vi.fn(() => true),
        readSession: mocks.readSession,
        writeSession: vi.fn(),
    }),
);

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
        getAllClientStateSnapshots: mocks.clientRepositoryMissing,
    }),
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<GroupStateSnapshotsModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.groupRepositoryMissing,
        findGroupStateSnapshotByRef: mocks.groupRepositoryMissing,
        getAllGroupStateSnapshots: mocks.groupRepositoryMissing,
    }),
);

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
        vi.mocked(mocks.webRtcConnectionService.knownPeerIds).mockReturnValue([]);
        vi.mocked(mocks.webRtcConnectionService.activePeerIds).mockReturnValue([]);
        vi.mocked(mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes)
            .mockReturnValue([]);
        vi.mocked(mocks.webRtcConnectionService.readyPeerIdsForLane)
            .mockReturnValue([]);
        vi.mocked(mocks.webRtcConnectionService.readPeer).mockReturnValue(undefined);
        vi.mocked(mocks.webSocketQueueBox.readHealth).mockReturnValue({
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
        const peer = toRtcPeerTestDouble({
            peerId: 'peer-1',
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
            lanes: new Map([
                ['reliable', vi.fn(() => reliableHealth)],
                ['realtime', vi.fn(() => realtimeHealth)],
            ]),
        });
        vi.mocked(mocks.webRtcConnectionService.knownPeerIds)
            .mockReturnValue(['peer-1']);
        vi.mocked(mocks.webRtcConnectionService.activePeerIds)
            .mockReturnValue(['peer-1']);
        vi.mocked(mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes)
            .mockReturnValue(['peer-1']);
        vi.mocked(mocks.webRtcConnectionService.readyPeerIdsForLane)
            .mockReturnValue(['peer-1']);
        vi.mocked(mocks.webRtcConnectionService.readPeer).mockReturnValue(peer);
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
        const getStats = vi.fn(async () => stats);
        const readDiagnostics = vi.fn(() => connectionDiagnostics);
        const peer = toRtcPeerTestDouble({
            peerId: 'peer-1',
            readDiagnostics,
            status: {
                state: 'Open',
                pc: {
                    connectionState: 'connected',
                    iceConnectionState: 'connected',
                    iceGatheringState: 'complete',
                    signalingState: 'stable',
                    localDescription: { type: 'offer' },
                    remoteDescription: { type: 'answer' },
                    canTrickleIceCandidates: true,
                    getStats,
                },
                reconnectAttempts: 0,
                reconnectTimer: undefined,
                disconnectTimer: undefined,
                makingOffer: false,
                ignoreOffer: false,
                iceCandidateQueue: [],
                remoteStreams: new Map(),
            },
            lanes: new Map([['reliable', vi.fn(() => reliableHealth)]]),
        });
        vi.mocked(mocks.webRtcConnectionService.knownPeerIds)
            .mockReturnValue(['peer-1']);
        vi.mocked(mocks.webRtcConnectionService.activePeerIds)
            .mockReturnValue(['peer-1']);
        vi.mocked(mocks.webRtcConnectionService.readyPeerIdsForLane)
            .mockReturnValue(['peer-1']);
        vi.mocked(mocks.webRtcConnectionService.readPeer).mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        const diagnostics = await facade.rtc.diagnostics({
            laneIds: ['reliable'],
        });

        expect(getStats).toHaveBeenCalledOnce();
        expect(readDiagnostics).toHaveBeenCalledOnce();
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

type RtcPeerConnectionStatus = QRtcPeerDto['connection']['status'];

type RtcPeerConnectionTestDouble =
    & Partial<
        Pick<
            RTCPeerConnection,
            | 'connectionState'
            | 'iceConnectionState'
            | 'iceGatheringState'
            | 'signalingState'
            | 'canTrickleIceCandidates'
        >
    >
    & Readonly<{
        localDescription?: Pick<RTCSessionDescription, 'type'>;
        remoteDescription?: Pick<RTCSessionDescription, 'type'>;
        getStats?: () => Promise<ReadonlyMap<string, Record<string, unknown>>>;
    }>;

type RtcPeerStatusTestDouble =
    & Omit<
        Partial<RtcPeerConnectionStatus>,
        'pc' | 'localStream' | 'remoteStreams'
    >
    & Readonly<{
        pc?: RtcPeerConnectionTestDouble;
        localStream?: Pick<MediaStream, 'id'>;
        remoteStreams?: ReadonlyMap<string, unknown>;
    }>;

type RtcPeerTestDoubleInput = Readonly<{
    peerId: QRtcPeerDto['peerId'];
    status: RtcPeerStatusTestDouble;
    readDiagnostics?: () => QRtcPeerConnectionDiagnostics;
    lanes: ReadonlyMap<string, () => RtcDataChannelHealth>;
}>;

// A QRtcPeerDto hangs off concrete classes (QRtcPeerConnection, QRtcDataChannel) and live DOM
// objects (RTCPeerConnection, MediaStream) that a unit test cannot construct. The RTC diagnostics
// readers walk only the members declared above, so this is the single place where the partial peer
// graph is asserted onto the production DTO; every member name it supplies is still checked against
// the production types.
function toRtcPeerTestDouble(input: RtcPeerTestDoubleInput): QRtcPeerDto {
    return {
        peerId: input.peerId,
        connection: {
            status: input.status,
            readDiagnostics: input.readDiagnostics,
        },
        channels: new Map(
            Array.from(input.lanes, ([laneId, readHealth]) => [
                laneId,
                { readHealth },
            ]),
        ),
    } as unknown as QRtcPeerDto;
}

function createChannelHealth(
    input: Readonly<{
        peerId: string;
        label: string;
        state: string;
        readyState: RTCDataChannelState;
    }>,
): RtcDataChannelHealth {
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
