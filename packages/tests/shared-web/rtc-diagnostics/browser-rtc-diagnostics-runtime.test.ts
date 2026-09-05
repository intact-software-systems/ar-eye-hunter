import type { RtcDataChannelHealth } from '@shared/webrtc/qrtc-data-channel.ts';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { SimulatedNativeRtcPeerConnection } from '../../shared/native-rtc-connection-fixture.ts';
import { EmptyMediaStream } from '../../shared/rtc-media-test-events.ts';
import { createBrowserRtcPeerTestDouble } from '../rtc/browser-rtc-peer-test-double.ts';

// The factories below annotate their return type on purpose: without it the contextual type of a
// `vi.mock` factory is a union, and TypeScript then accepts an export name the module does not
// have. With the annotation a renamed or removed export fails the type check.
type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import(
        '../api-middleware-test-double.ts'
    );
    const ctx = createDefaultApiMiddlewareTestDouble();

    return {
        ctx,
        webRtcConnectionService: ctx.middleware.webRtcConnectionService,
        webSocketQueueBox: ctx.middleware.webSocketQueueBox,
        hydrateStateCache: vi.fn(() => Promise.resolve()),
        initialiseApiMiddleware: vi.fn(() => Promise.resolve(ctx)),
        onCacheChange: vi.fn(() => vi.fn()),
        readSession: vi.fn(() => ctx.session),
        findClientStateSnapshotByPrincipalId: vi.fn<ClientStateSnapshotsModule['findClientStateSnapshotByPrincipalId']>(() => undefined),
        getAllClientStateSnapshots: vi.fn<ClientStateSnapshotsModule['getAllClientStateSnapshots']>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<GroupStateSnapshotsModule['findFirstGroupStateSnapshotRefSessionIdIsIn']>(() => undefined),
        findGroupStateSnapshotByRef: vi.fn<GroupStateSnapshotsModule['findGroupStateSnapshotByRef']>(() => undefined),
        getAllGroupStateSnapshots: vi.fn<GroupStateSnapshotsModule['getAllGroupStateSnapshots']>(() => [])
    };
});

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    (): Partial<MiddlewareModule> => ({
        initialiseMiddleware: async () => (await mocks.initialiseApiMiddleware()).middleware
    })
);

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<StateCacheLifecycleModule> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn(),
            cancelSnapshotAssemblies: vi.fn(() => undefined)
        }
    })
);

vi.mock(
    import('@shared/api/auth.ts'),
    (): Partial<AuthModule> => ({
        clearSession: vi.fn(),
        isLoggedIn: vi.fn(() => true),
        readSession: mocks.readSession,
        writeSession: vi.fn()
    })
);

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<GroupStateSnapshotsModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
    })
);

describe('Rallar RTC diagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
        mocks.getAllClientStateSnapshots.mockReturnValue([]);
        mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
        mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
        mocks.getAllGroupStateSnapshots.mockReturnValue([]);
        mocks.hydrateStateCache.mockResolvedValue(undefined);
        mocks.initialiseApiMiddleware.mockResolvedValue(mocks.ctx);
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
            reconnectExhausted: false
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
            peers: []
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
            reconnectExhausted: false
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
            readyState: 'open'
        });
        const realtimeHealth = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-realtime',
            state: 'Open',
            readyState: 'open'
        });
        const nativePeer = new SimulatedNativeRtcPeerConnection();
        nativePeer.connectionState = 'connected';
        nativePeer.iceConnectionState = 'connected';
        const peer = createBrowserRtcPeerTestDouble({
            peerId: 'peer-1',
            status: {
                state: 'Open',
                pc: nativePeer,
                reconnectAttempts: 2,
                reconnectTimer: undefined,
                disconnectTimer: undefined,
                makingOffer: false,
                ignoreOffer: false,
                iceCandidateQueue: [{ candidate: 'queued-candidate' }],
                localStream: new EmptyMediaStream('local-stream'),
                remoteStreams: new Map([
                    ['remote-stream', new EmptyMediaStream('remote-stream')]
                ])
            },
            channels: [
                ['reliable', { readHealth: vi.fn(() => reliableHealth) }],
                ['realtime', { readHealth: vi.fn(() => realtimeHealth) }]
            ]
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
                    remoteStreamIds: ['remote-stream']
                },
                lanes: [
                    {
                        peerId: 'peer-1',
                        laneId: 'reliable',
                        channel: reliableHealth,
                        isOpen: true,
                        isReconnectable: false
                    },
                    {
                        peerId: 'peer-1',
                        laneId: 'realtime',
                        channel: realtimeHealth,
                        isOpen: true,
                        isReconnectable: false
                    }
                ]
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
                    peerId: 'peer-1'
                })
            ]
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
            readyState: 'open'
        });
        const nativePeer = new SimulatedNativeRtcPeerConnection();
        nativePeer.connectionState = 'connected';
        nativePeer.iceConnectionState = 'connected';
        nativePeer.iceGatheringState = 'complete';
        await nativePeer.setLocalDescription({ type: 'offer', sdp: 'local-offer' });
        await nativePeer.setRemoteDescription({ type: 'answer', sdp: 'remote-answer' });
        vi.spyOn(nativePeer, 'getStats').mockResolvedValue(createRelayStats());
        const peer = createBrowserRtcPeerTestDouble({
            peerId: 'peer-1',
            status: { state: 'Open', pc: nativePeer },
            channels: [['reliable', { readHealth: vi.fn(() => reliableHealth) }]]
        });
        vi.spyOn(peer.connection, 'readDiagnostics').mockReturnValue({
            ...peer.connection.readDiagnostics(),
            connectCallCount: 2,
            outboundOfferCount: 1,
            inboundAnswerCount: 1,
            reconnectAttemptCount: 1,
            pendingIceCandidateQueueLength: 3,
            reconnectAttemptsInFlight: 1,
            hasReconnectTimer: true
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
            laneIds: ['reliable']
        });

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
                        canTrickleIceCandidates: true
                    },
                    connectionDiagnostics: {
                        connectCallCount: 2,
                        outboundOfferCount: 1,
                        inboundAnswerCount: 1,
                        reconnectAttemptCount: 1,
                        pendingIceCandidateQueueLength: 3,
                        reconnectAttemptsInFlight: 1,
                        hasReconnectTimer: true
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
                            url: 'turn:turn.example.test'
                        },
                        remote: {
                            id: 'remote-1',
                            candidateType: 'srflx',
                            protocol: 'udp',
                            address: '203.0.113.10',
                            port: 4321
                        }
                    },
                    lanes: [
                        {
                            laneId: 'reliable',
                            channel: reliableHealth
                        }
                    ]
                }
            ]
        });
    });
});

interface ChannelHealthFixtureInput {
    readonly peerId: string;
    readonly label: string;
    readonly state: string;
    readonly readyState: RTCDataChannelState;
}

function createChannelHealth(input: ChannelHealthFixtureInput): RtcDataChannelHealth {
    return {
        peerId: input.peerId,
        label: input.label,
        state: input.state,
        role: 'Initiator',
        readyState: input.readyState,
        binaryType: 'arraybuffer',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        queuedItemCount: 0,
        rawCallbackCount: 0,
        messageCallbackCount: 0,
        lifecycleCallbackCount: 0,
        flowControl: {
            highWatermarkBytes: 64 * 1024,
            lowWatermarkBytes: 16 * 1024,
            overflow: 'drop-new',
            maxQueueItems: 32
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
            receivedBinary: 0
        }
    };
}

interface SelectedCandidatePairStats extends RTCIceCandidatePairStats {
    readonly selected: boolean;
}

interface CandidateStatsFixture extends RTCStats {
    readonly candidateType: RTCIceCandidateType;
    readonly protocol: RTCIceProtocol;
    readonly address: string;
    readonly port: number;
    readonly relayProtocol?: RTCIceProtocol;
    readonly networkType?: string;
    readonly url?: string;
}

function createRelayStats(): RTCStatsReport {
    const pair: SelectedCandidatePairStats = {
        id: 'pair-1',
        type: 'candidate-pair',
        timestamp: 1,
        transportId: 'transport-1',
        state: 'succeeded',
        nominated: true,
        selected: true,
        localCandidateId: 'local-1',
        remoteCandidateId: 'remote-1',
        currentRoundTripTime: 0.042,
        availableOutgoingBitrate: 123_456,
        bytesSent: 100,
        bytesReceived: 200
    };
    const local: CandidateStatsFixture = {
        id: 'local-1',
        type: 'local-candidate',
        timestamp: 1,
        candidateType: 'relay',
        protocol: 'udp',
        address: '10.0.0.1',
        port: 1234,
        relayProtocol: 'udp',
        networkType: 'wifi',
        url: 'turn:turn.example.test'
    };
    const remote: CandidateStatsFixture = {
        id: 'remote-1',
        type: 'remote-candidate',
        timestamp: 1,
        candidateType: 'srflx',
        protocol: 'udp',
        address: '203.0.113.10',
        port: 4321
    };
    return new Map<string, RTCStats>([
        [pair.id, pair],
        [local.id, local],
        [remote.id, remote]
    ]);
}
