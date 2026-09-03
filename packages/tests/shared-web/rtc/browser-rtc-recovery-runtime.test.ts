import type { RallarRtcLifecycleEvent, RallarRtcStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/web-rtc-connection-service.ts';
import type { QRtcDataChannel, RtcDataChannelHealth } from '@shared/webrtc/qrtc-data-channel.ts';
import type { QRtcClientCallbacks } from '@shared/webrtc/QRtcClientCallbacks.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedNativeRtcPeerConnection } from '../../shared/native-rtc-connection-fixture.ts';
import { createBrowserRtcPeerTestDouble } from './browser-rtc-peer-test-double.ts';

import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type StateEventHttpApiModule = typeof import('@shared-web/browser/state-read/state-event-http-api.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');
type RoomMutationWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

const CLIENT_REPOSITORY_MISSING_MESSAGE = 'Repository not found: shared.repository.client-state-snapshots';
const GROUP_REPOSITORY_MISSING_MESSAGE = 'Repository not found: shared.repository.group-state-snapshots';

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import(
        '../api-middleware-test-double.ts'
    );
    const ctx = createDefaultApiMiddlewareTestDouble();
    const throwClientRepositoryMissing = (): never => {
        throw new Error('Repository not found: shared.repository.client-state-snapshots');
    };
    const throwGroupRepositoryMissing = (): never => {
        throw new Error('Repository not found: shared.repository.group-state-snapshots');
    };

    return {
        ctx,
        webRtcConnectionService: vi.mocked(ctx.middleware.webRtcConnectionService),
        rtcRxStreamer: vi.mocked(ctx.middleware.rtcRxStreamer),
        webSocketQueueBox: vi.mocked(ctx.middleware.webSocketQueueBox),
        webSocketClient: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
        clearSession: vi.fn<AuthModule['clearSession']>(),
        hydrateStateCache: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['hydrate']>(() => Promise.resolve()),
        initialiseApiMiddleware: vi.fn<BrowserTransportRuntimePort['init']>(() => Promise.resolve(ctx)),
        createAndJoinStateGroup: vi.fn<RoomGroupStateWorkflowsModule['createAndJoinStateGroup']>(
            () => Promise.reject(new Error('create not mocked'))
        ),
        joinStateGroup: vi.fn<RoomGroupStateWorkflowsModule['joinStateGroup']>(() => Promise.reject(new Error('join not mocked'))),
        leaveStateGroup: vi.fn<RoomGroupStateWorkflowsModule['leaveStateGroup']>(() => Promise.reject(new Error('leave not mocked'))),
        updateStateGroupMetadata: vi.fn<RoomMutationWorkflowsModule['updateStateGroupMetadata']>(
            () => Promise.reject(new Error('metadata update not mocked'))
        ),
        loginToApi: vi.fn<AuthApiModule['loginToApi']>(() => Promise.resolve(ctx.session)),
        listStateClientEvents: vi.fn<StateEventHttpApiModule['listStateClientEvents']>(() => Promise.reject(new Error('client events not mocked'))),
        listStateClientEventPage: vi.fn<StateEventHttpApiModule['listStateClientEventPage']>(() => Promise.reject(new Error('client event page not mocked'))),
        listStateGroupEvents: vi.fn<StateEventHttpApiModule['listStateGroupEvents']>(() => Promise.reject(new Error('group events not mocked'))),
        listStateGroupEventPage: vi.fn<StateEventHttpApiModule['listStateGroupEventPage']>(
            () => Promise.reject(new Error('group event page not mocked'))
        ),
        logoutFromApi: vi.fn<AuthApiModule['logoutFromApi']>(() => Promise.resolve({ loggedOut: true })),
        registerWithApi: vi.fn<AuthApiModule['registerWithApi']>(() =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            })
        ),
        onCacheChange: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['onChange']>(() => vi.fn()),
        readSession: vi.fn<AuthModule['readSession']>(() => ctx.session),
        refreshStateSnapshots: vi.fn<RefreshStateSnapshotsModule['refreshStateSnapshots']>(() => Promise.resolve({ clients: [], groups: [] })),
        findClientStateSnapshotByPrincipalId: vi.fn<ClientStateSnapshotsRepositoryModule['findClientStateSnapshotByPrincipalId']>(throwClientRepositoryMissing),
        getAllClientStateSnapshots: vi.fn<ClientStateSnapshotsRepositoryModule['getAllClientStateSnapshots']>(throwClientRepositoryMissing),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<
            GroupStateSnapshotsRepositoryModule[
                'findFirstGroupStateSnapshotRefSessionIdIsIn'
            ]
        >(throwGroupRepositoryMissing),
        findGroupStateSnapshotByRef: vi.fn<GroupStateSnapshotsRepositoryModule['findGroupStateSnapshotByRef']>(throwGroupRepositoryMissing),
        getAllGroupStateSnapshots: vi.fn<GroupStateSnapshotsRepositoryModule['getAllGroupStateSnapshots']>(throwGroupRepositoryMissing),
        writeSession: vi.fn<AuthModule['writeSession']>()
    };
});

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    (): Partial<MiddlewareModule> => ({
        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
    })
);

vi.mock(
    import('@shared-web/browser/state-read/state-event-http-api.ts'),
    (): Partial<StateEventHttpApiModule> => ({
        listStateClientEventPage: mocks.listStateClientEventPage,
        listStateClientEvents: mocks.listStateClientEvents,
        listStateGroupEventPage: mocks.listStateGroupEventPage,
        listStateGroupEvents: mocks.listStateGroupEvents
    })
);

vi.mock(import('@shared-web/browser/auth/session-http-api.ts'), (): Partial<AuthApiModule> => ({
    loginToApi: mocks.loginToApi,
    logoutFromApi: mocks.logoutFromApi,
    registerWithApi: mocks.registerWithApi
}));

vi.mock(
    import('@shared-web/browser/rooms/room-group-state-workflows.ts'),
    (): Partial<RoomGroupStateWorkflowsModule> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup
    })
);
vi.mock(import('@shared-web/browser/state-read/refresh-state-snapshots.ts'), (): Partial<RefreshStateSnapshotsModule> => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots
}));
vi.mock(import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'), (): Partial<RoomMutationWorkflowsModule> => ({
    updateStateGroupMetadata: mocks.updateStateGroupMetadata
}));

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<StateCacheLifecycleModule> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn()
        }
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: mocks.clearSession,
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: mocks.writeSession
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<GroupStateSnapshotsRepositoryModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
    })
);

describe('Rallar RTC recovery', () => {
    beforeEach(async () => {
        (await import('@shared-web/browser/connection/browser-transport-runtime.ts'))
            .browserTransportRuntime.shutdown('test-reset');
        vi.clearAllMocks();
        vi.useRealTimers();
        mockClientRepositoryMissing();
        mockGroupRepositoryMissing();
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.initialiseApiMiddleware.mockResolvedValue(mocks.ctx);
        mocks.clearSession.mockImplementation(() => undefined);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.logoutFromApi.mockResolvedValue({ loggedOut: true });
        mocks.createAndJoinStateGroup.mockRejectedValue(new Error('create not mocked'));
        mocks.joinStateGroup.mockRejectedValue(new Error('join not mocked'));
        mocks.leaveStateGroup.mockRejectedValue(new Error('leave not mocked'));
        mocks.updateStateGroupMetadata.mockRejectedValue(
            new Error('metadata update not mocked')
        );
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue([]);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
            (peerId) =>
                Either.ofLeft({
                    kind: 'connect-failed',
                    peerId,
                    error: new Error('connect not mocked'),
                    startedSetup: false
                })
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                status: 'connect-failed',
                peerId,
                laneId,
                error: new Error('connect not mocked')
            })
        );
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() => mocks.webRtcConnectionService);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
        mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
        mocks.rtcRxStreamer.onInboxMessageDo.mockReturnValue(mocks.rtcRxStreamer);
        mocks.rtcRxStreamer.removeInboxMessageCallback.mockReturnValue(true);
        mocks.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
            mocks.webSocketQueueBox
        );
        mocks.webSocketQueueBox.removeAnyInboxMessageCallback.mockReturnValue(true);
        mocks.webSocketQueueBox.readHealth.mockReturnValue({
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
        mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
            mocks.webSocketClient.close(code, reason);
        });
        mocks.webSocketClient.onWebsocketCallbacksDo.mockReturnValue(
            mocks.webSocketClient
        );
        mocks.webSocketClient.removeWebsocketCallbackById.mockReturnValue(true);
        mocks.registerWithApi.mockResolvedValue({
            clientId: 'client-new',
            username: 'new-user',
            displayName: null,
            registeredAtEpochMs: 1_000
        });
        mocks.listStateClientEvents.mockRejectedValue(
            new Error('client events not mocked')
        );
        mocks.listStateClientEventPage.mockRejectedValue(
            new Error('client event page not mocked')
        );
        mocks.listStateGroupEvents.mockRejectedValue(
            new Error('group events not mocked')
        );
        mocks.listStateGroupEventPage.mockRejectedValue(
            new Error('group event page not mocked')
        );
    });

    it('restarts ICE for an active RTC peer when supported', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        let restartCount = 0;
        const restartIce = () => {
            restartCount += 1;
        };
        const peer = createBrowserRtcPeerTestDouble({
            channels: [],
            peerId: 'peer-1',
            status: {
                state: 'Open',
                pc: Object.assign(new SimulatedNativeRtcPeerConnection(), {
                    connectionState: 'connected',
                    restartIce
                }),
                reconnectAttempts: 0,
                reconnectTimer: undefined,
                disconnectTimer: undefined
            }
        });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();
        const result = await facade.rtc.restartIce('peer-1');

        expect(restartCount).toBe(1);
        expect(result).toMatchObject({
            peerId: 'peer-1',
            action: 'restart-ice',
            status: 'restarted'
        });
    });

    it('reconnects an RTC peer and waits for the requested lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime'
        });
        const facade = createRallarFacade();

        await facade.connect();
        const result = await facade.rtc.reconnectPeer('peer-1', {
            laneId: 'realtime',
            timeoutMs: 250
        });

        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledWith('peer-1');
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 250
                })
            );
        expect(result).toMatchObject({
            peerId: 'peer-1',
            action: 'reconnect',
            status: 'started'
        });
    });

    it('marks RTC routeability from the requested lane readiness', async () => {
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
            state: 'Closed',
            readyState: 'closed'
        });
        const peer = createBrowserRtcPeerTestDouble({
            peerId: 'peer-1',
            status: {
                state: 'Open',
                pc: Object.assign(new SimulatedNativeRtcPeerConnection(), {
                    connectionState: 'connected'
                }),
                reconnectAttempts: 0,
                reconnectTimer: undefined,
                disconnectTimer: undefined
            },
            channels: [
                ['reliable', { readHealth: vi.fn(() => reliableHealth) }],
                ['realtime', { readHealth: vi.fn(() => realtimeHealth) }]
            ]
        });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockImplementation(
            (laneId) => laneId === 'realtime' ? [] : ['peer-1']
        );
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        expect(facade.rtc.peer('peer-1')).toMatchObject({
            hasNoReconnectableLanes: false,
            isRoutable: true,
            readyLaneIds: ['reliable']
        });
        expect(facade.rtc.peer('peer-1', { laneId: 'realtime' })).toMatchObject({
            hasNoReconnectableLanes: false,
            isRoutable: false,
            readyLaneIds: ['reliable']
        });
    });

    it('notifies public RTC status and lifecycle subscribers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const health = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-realtime',
            state: 'Open',
            readyState: 'open'
        });
        let laneCallbacks: QRtcClientCallbacks | undefined;
        const onRtcCallbacksDo = vi.fn(
            (_id: string, callbacks: QRtcClientCallbacks): QRtcDataChannel => {
                laneCallbacks = callbacks;
                return peer.channel;
            }
        );
        const removalEvents: string[] = [];
        const removeRtcCallbackById = (id: string) => {
            removalEvents.push(`lane:${id}`);
            return true;
        };
        const realtimeChannel = {
            readHealth: vi.fn(() => health),
            onRtcCallbacksDo,
            removeRtcCallbackById
        };
        const peer = createBrowserRtcPeerTestDouble({
            peerId: 'peer-1',
            status: {
                state: 'Open',
                pc: Object.assign(new SimulatedNativeRtcPeerConnection(), {
                    connectionState: 'connected',
                    iceConnectionState: 'connected',
                    signalingState: 'stable'
                }),
                reconnectAttempts: 0,
                reconnectTimer: undefined,
                disconnectTimer: undefined
            },
            channels: [['realtime', realtimeChannel]]
        });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockImplementation(
            (id) => {
                removalEvents.push(`peer:${id}`);
                return true;
            }
        );
        const facade = createRallarFacade();
        const statuses: RallarRtcStatus[] = [];
        const lifecycles: RallarRtcLifecycleEvent[] = [];

        const unsubscribeStatus = facade.rtc.onStatus(
            (status) => {
                statuses.push(status);
            },
            { laneId: 'realtime' }
        );
        const unsubscribeLifecycle = facade.rtc.onLifecycle(
            (event) => {
                lifecycles.push(event);
            },
            { laneId: 'realtime' }
        );

        expect(statuses).toEqual([
            expect.objectContaining({
                laneId: 'realtime',
                peers: []
            })
        ]);
        expect(lifecycles).toEqual([
            expect.objectContaining({
                kind: 'snapshot',
                status: expect.objectContaining({
                    laneId: 'realtime'
                })
            })
        ]);

        await facade.connect();

        expect(onRtcCallbacksDo).toHaveBeenCalledWith(
            'rallar:rtc:status',
            expect.objectContaining({
                onOpen: expect.any(Function),
                onClose: expect.any(Function),
                onError: expect.any(Function)
            })
        );
        expect(lifecycles).toContainEqual(
            expect.objectContaining({
                kind: 'connected',
                status: expect.objectContaining({
                    readyPeerIds: ['peer-1']
                })
            })
        );

        await laneCallbacks?.onOpen?.();

        expect(statuses.at(-1)).toMatchObject({
            laneId: 'realtime',
            readyPeerIds: ['peer-1'],
            peers: [
                {
                    peerId: 'peer-1',
                    readyLaneIds: ['realtime']
                }
            ]
        });
        expect(lifecycles.at(-1)).toMatchObject({
            kind: 'lane-open',
            peerId: 'peer-1',
            laneId: 'realtime',
            peer: {
                peerId: 'peer-1'
            },
            lane: {
                laneId: 'realtime',
                isOpen: true
            }
        });

        unsubscribeStatus();
        expect(removalEvents).toEqual([]);

        unsubscribeLifecycle();
        expect(removalEvents).toEqual([
            'peer:rallar:rtc:status',
            'lane:rallar:rtc:status'
        ]);
    });

    it('emits RTC peer lifecycle removal after service deletion completes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const onRtcCallbacksDo = vi.fn((): QRtcDataChannel => peer.channel);
        const realtimeChannel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-realtime',
                    state: 'Open',
                    readyState: 'open'
                })
            ),
            onRtcCallbacksDo,
            removeRtcCallbackById: vi.fn(() => true)
        };
        const peer = createBrowserRtcPeerTestDouble({
            peerId: 'peer-1',
            status: {
                state: 'Open',
                pc: Object.assign(new SimulatedNativeRtcPeerConnection(), {
                    connectionState: 'connected'
                }),
                reconnectAttempts: 0,
                reconnectTimer: undefined,
                disconnectTimer: undefined
            },
            channels: [['realtime', realtimeChannel]]
        });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();
        const lifecycles: RallarRtcLifecycleEvent[] = [];

        facade.rtc.onLifecycle(
            (event) => {
                lifecycles.push(event);
            },
            {
                laneId: 'realtime',
                emitCurrent: false
            }
        );
        await facade.connect();

        const lifecycleCallback = mocks.webRtcConnectionService
            .onRtcPeerLifecycleDo.mock.calls
            .find(([id]) => id === 'rallar:rtc:status')?.[1];
        expect(lifecycleCallback).toBeDefined();

        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);

        lifecycleCallback?.onDeleted(peer);
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(lifecycles.at(-1)).toMatchObject({
            kind: 'peer-deleted',
            peerId: 'peer-1',
            status: {
                knownPeerIds: [],
                readyPeerIds: [],
                peers: []
            }
        });
    });

    it('emits RTC peer timeout lifecycle events from the connection service', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const peer = createBrowserRtcPeerTestDouble({
            channels: [],
            peerId: 'peer-1',
            status: {
                state: 'Connecting',
                pc: Object.assign(new SimulatedNativeRtcPeerConnection(), {
                    connectionState: 'connecting'
                }),
                reconnectAttempts: 0,
                reconnectTimer: undefined,
                disconnectTimer: undefined
            }
        });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();
        const lifecycles: RallarRtcLifecycleEvent[] = [];

        facade.rtc.onLifecycle(
            (event) => {
                lifecycles.push(event);
            },
            {
                emitCurrent: false
            }
        );
        await facade.connect();

        const lifecycleCallback = mocks.webRtcConnectionService
            .onRtcPeerLifecycleDo.mock.calls
            .find(([id]) => id === 'rallar:rtc:status')?.[1];
        expect(lifecycleCallback).toBeDefined();

        lifecycleCallback?.onConnectTimeout?.(
            peer,
            {
                peerId: 'peer-1',
                timeoutMs: 50,
                startedAtEpochMs: 1,
                timedOutAtEpochMs: 51,
                reason: 'peer-establishment-timeout'
            }
        );

        expect(lifecycles.at(-1)).toMatchObject({
            kind: 'peer-timeout',
            peerId: 'peer-1',
            peer: {
                peerId: 'peer-1',
                connection: {
                    connectionState: 'connecting'
                }
            }
        });
    });

    it('emits RTC peer established lifecycle events from the connection service', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const peer = createBrowserRtcPeerTestDouble({
            channels: [],
            peerId: 'peer-1',
            status: {
                state: 'Open',
                pc: Object.assign(new SimulatedNativeRtcPeerConnection(), {
                    connectionState: 'connected'
                }),
                reconnectAttempts: 0,
                reconnectTimer: undefined,
                disconnectTimer: undefined
            }
        });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();
        const lifecycles: RallarRtcLifecycleEvent[] = [];

        facade.rtc.onLifecycle(
            (event) => {
                lifecycles.push(event);
            },
            {
                emitCurrent: false
            }
        );
        await facade.connect();

        const lifecycleCallback = mocks.webRtcConnectionService
            .onRtcPeerLifecycleDo.mock.calls
            .find(([id]) => id === 'rallar:rtc:status')?.[1];
        expect(lifecycleCallback).toBeDefined();

        lifecycleCallback?.onEstablished?.(
            peer,
            {
                phase: 'established',
                peerId: 'peer-1',
                startedAtEpochMs: 1,
                establishedAtEpochMs: 51
            }
        );

        expect(lifecycles.at(-1)).toMatchObject({
            kind: 'peer-established',
            peerId: 'peer-1',
            peer: {
                peerId: 'peer-1',
                connection: {
                    connectionState: 'connected'
                }
            }
        });
    });
});

function createChannelHealth(
    input: Readonly<{
        peerId: string;
        label: string;
        state: string;
        readyState: RTCDataChannelState;
    }>
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

function mockClientRepositoryMissing(): void {
    mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
    mocks.getAllClientStateSnapshots.mockReturnValue([]);
}

function mockGroupRepositoryMissing(): void {
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
}
