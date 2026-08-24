import type { StateCacheChangeListener } from '@shared-web/browser/data-caches.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto } from '@shared/services/WebRtcConnectionService.ts';
import type { QRtcDataChannel, RtcDataChannelHealth } from '@shared/webrtc/QRtcDataChannel.ts';
import type { QRtcPeerConnection } from '@shared/webrtc/QRtcPeerConnection.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type MiddlewareModule = typeof import('@shared-web/browser/middleware.ts');
type ApiIntegrationModule = typeof import('@shared-web/browser/api-integration.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type ApiWorkflowsModule = typeof import('@shared-web/browser/api-workflows.ts');
type DataCachesModule = typeof import('@shared-web/browser/data-caches.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

const CLIENT_REPOSITORY_MISSING_MESSAGE = 'Repository not found: shared.repository.client-state-snapshots';
const GROUP_REPOSITORY_MISSING_MESSAGE = 'Repository not found: shared.repository.group-state-snapshots';

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        './api-middleware-test-double.ts'
    );
    const ctx = createApiMiddlewareTestDouble();
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
        clearMiddleware: vi.fn<AppContextModule['clearMiddleware']>(),
        hydrateStateCaches: vi.fn<DataCachesModule['hydrateStateCaches']>(() => Promise.resolve()),
        initMiddleware: vi.fn<AppContextModule['initMiddleware']>(() => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn<AppContextModule['isMiddlewareReady']>(() => false),
        createAndJoinStateGroup: vi.fn<ApiWorkflowsModule['createAndJoinStateGroup']>(
            () => Promise.reject(new Error('create not mocked'))
        ),
        joinStateGroup: vi.fn<ApiWorkflowsModule['joinStateGroup']>(() => Promise.reject(new Error('join not mocked'))),
        leaveStateGroup: vi.fn<ApiWorkflowsModule['leaveStateGroup']>(() => Promise.reject(new Error('leave not mocked'))),
        updateStateGroupMetadata: vi.fn<ApiWorkflowsModule['updateStateGroupMetadata']>(
            () => Promise.reject(new Error('metadata update not mocked'))
        ),
        loginToApi: vi.fn<AuthApiModule['loginToApi']>(() => Promise.resolve(ctx.session)),
        listStateClientEvents: vi.fn<ApiIntegrationModule['listStateClientEvents']>(() => Promise.reject(new Error('client events not mocked'))),
        listStateClientEventPage: vi.fn<ApiIntegrationModule['listStateClientEventPage']>(() => Promise.reject(new Error('client event page not mocked'))),
        listStateGroupEvents: vi.fn<ApiIntegrationModule['listStateGroupEvents']>(() => Promise.reject(new Error('group events not mocked'))),
        listStateGroupEventPage: vi.fn<ApiIntegrationModule['listStateGroupEventPage']>(
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
        onStateCacheChange: vi.fn<DataCachesModule['onStateCacheChange']>(() => vi.fn()),
        readSession: vi.fn<AuthModule['readSession']>(() => ctx.session),
        refreshStateSnapshots: vi.fn<ApiWorkflowsModule['refreshStateSnapshots']>(() => Promise.resolve({ clients: [], groups: [] })),
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
    import('@shared-web/browser/middleware.ts'),
    (): Partial<MiddlewareModule> => ({
        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initMiddleware(options)).middleware
    })
);

vi.mock(
    import('@shared-web/browser/api-integration.ts'),
    (): Partial<ApiIntegrationModule> => ({
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
    import('@shared-web/browser/api-workflows.ts'),
    (): Partial<ApiWorkflowsModule> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup,
        refreshStateSnapshots: mocks.refreshStateSnapshots,
        updateStateGroupMetadata: mocks.updateStateGroupMetadata
    })
);

vi.mock(
    import('@shared-web/browser/data-caches.ts'),
    (): Partial<DataCachesModule> => ({
        hydrateStateCaches: mocks.hydrateStateCaches,
        onStateCacheChange: mocks.onStateCacheChange
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

describe('Rallar RTC wait', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        mockClientRepositoryMissing();
        mockGroupRepositoryMissing();
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.clearSession.mockImplementation(() => undefined);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.logoutFromApi.mockResolvedValue({ loggedOut: true });
        mocks.createAndJoinStateGroup.mockRejectedValue(new Error('create not mocked'));
        mocks.joinStateGroup.mockRejectedValue(new Error('join not mocked'));
        mocks.leaveStateGroup.mockRejectedValue(new Error('leave not mocked'));
        mocks.updateStateGroupMetadata.mockRejectedValue(
            new Error('metadata update not mocked')
        );
        mocks.onStateCacheChange.mockImplementation(() => vi.fn());
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
                    error: new Error('connect not mocked')
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

    it('waits for the default RTC lane to open', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        let readyState: RTCDataChannelState = 'connecting';
        let state = 'Opening';
        const channel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-data-channel',
                    state,
                    readyState
                })
            ),
            waitUntilOpen: vi.fn(async () => {
                readyState = 'open';
                state = 'Open';
                return true;
            })
        };
        const peer = createPeerTestDouble('peer-1', [['reliable', channel]]);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.rtc.waitForOpen('peer-1', { timeoutMs: 25 }))
            .resolves.toMatchObject({
                transport: 'rtc',
                status: 'open',
                peerId: 'peer-1',
                laneId: 'reliable',
                lane: {
                    isOpen: true
                }
            });
        expect(channel.waitUntilOpen).toHaveBeenCalledWith(25);
    });

    it('does not connect an RTC peer when wait is observe-only', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockClear();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();

        await expect(facade.rtc.waitForOpen('peer-1', { timeoutMs: 1 }))
            .resolves.toMatchObject({
                transport: 'rtc',
                status: 'no-peer',
                peerId: 'peer-1',
                laneId: 'reliable'
            });
        expect(mocks.webRtcConnectionService.ensurePeerConnectionStarted)
            .not.toHaveBeenCalled();
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .not.toHaveBeenCalled();
    });

    it('returns aborted for an already-aborted RTC lane wait', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const controller = new AbortController();
        controller.abort();
        const facade = createRallarFacade();

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockClear();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();

        await expect(
            facade.rtc.waitForLane(
                'peer-1',
                'realtime',
                {
                    signal: controller.signal,
                    connect: true
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            status: 'aborted',
            peerId: 'peer-1',
            laneId: 'realtime'
        });
        expect(mocks.webRtcConnectionService.ensurePeerConnectionStarted)
            .not.toHaveBeenCalled();
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .not.toHaveBeenCalled();
    });

    it('returns no-lane when an RTC peer lacks the requested lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const peer = createPeerTestDouble('peer-1', []);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.rtc.waitForLane('peer-1', 'realtime'))
            .resolves.toMatchObject({
                transport: 'rtc',
                status: 'no-lane',
                peerId: 'peer-1',
                laneId: 'realtime'
            });
    });

    it('returns closed when an RTC lane is already closed', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const channel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-realtime',
                    state: 'Closed',
                    readyState: 'closed'
                })
            ),
            waitUntilOpen: vi.fn()
        };
        const peer = createPeerTestDouble('peer-1', [['realtime', channel]]);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.rtc.waitForLane('peer-1', 'realtime'))
            .resolves.toMatchObject({
                transport: 'rtc',
                status: 'closed',
                peerId: 'peer-1',
                laneId: 'realtime',
                lane: {
                    isReconnectable: true
                }
            });
        expect(channel.waitUntilOpen).not.toHaveBeenCalled();
    });

    it('returns aborted when RTC lane wait is aborted while pending', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const deferred = createDeferred<boolean>();
        const channel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-realtime',
                    state: 'Opening',
                    readyState: 'connecting'
                })
            ),
            waitUntilOpen: vi.fn(() => deferred.promise)
        };
        const peer = createPeerTestDouble('peer-1', [['realtime', channel]]);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();
        const controller = new AbortController();

        await facade.connect();
        const wait = facade.rtc.waitForLane(
            'peer-1',
            'realtime',
            {
                signal: controller.signal,
                timeoutMs: 1_000
            }
        );
        controller.abort();

        await expect(wait).resolves.toMatchObject({
            transport: 'rtc',
            status: 'aborted',
            peerId: 'peer-1',
            laneId: 'realtime'
        });
        expect(channel.waitUntilOpen).toHaveBeenCalledWith(1_000);
        deferred.resolve(false);
    });

    it('returns failed when opt-in RTC peer connection throws', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen
            .mockRejectedValueOnce(new Error('signaling failed'));
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForLane(
                'peer-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 25
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            status: 'failed',
            peerId: 'peer-1',
            laneId: 'realtime',
            reason: 'signaling failed'
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 25
                })
            );
    });

    it('can opt into connecting an RTC peer before waiting for a lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const channel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-realtime',
                    state: 'Open',
                    readyState: 'open'
                })
            )
        };
        const peer = createPeerTestDouble('peer-1', [['realtime', channel]]);
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime',
            peer,
            channel: toTestDouble<QRtcDataChannel>(channel)
        });
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForLane(
                'peer-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 50
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime'
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 50
                })
            );
    });

    it('waits for a room RTC lane and separates ready peers from not-ready peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-ready',
                'peer-slow'
            ])
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => {
                if (peerId === 'peer-ready') {
                    return {
                        status: 'open',
                        peerId,
                        laneId
                    };
                }

                return {
                    status: 'timeout',
                    peerId,
                    laneId,
                    error: new Error('lane did not open')
                };
            }
        );
        const facade = createRallarFacade();

        await facade.connect();

        const result = await facade.rtc.waitForRoomLane(
            'room-1',
            'realtime',
            {
                connect: true,
                timeoutMs: 1_000
            }
        );

        expect(result).toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'partial',
            readyPeerIds: ['peer-ready'],
            notReadyPeerIds: ['peer-slow'],
            missingPeerIds: [],
            extraPeerIds: [],
            observedCount: 1,
            expectedCount: 2,
            ready: [
                {
                    peerId: 'peer-ready',
                    laneId: 'realtime',
                    status: 'open'
                }
            ],
            notReady: [
                {
                    peerId: 'peer-slow',
                    laneId: 'realtime',
                    status: 'timeout'
                }
            ]
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledTimes(2);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenNthCalledWith(
                1,
                'peer-ready',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 1_000
                })
            );
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenNthCalledWith(
                2,
                'peer-slow',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 1_000
                })
            );
    });

    it('waits for local room presence with min one for solo rooms', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rooms.waitForPresence('room-1', {
                expect: { min: 1 },
                timeoutMs: 10
            })
        ).resolves.toMatchObject({
            status: 'ready',
            roomId: 'room-1',
            activeSessionIds: ['session-1'],
            observedCount: 1,
            expectedCount: 1,
            timedOut: false
        });
    });

    it('resolves room presence waits when later cache updates satisfy expectations', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        let onCacheChange: StateCacheChangeListener | undefined;
        mocks.onStateCacheChange.mockImplementation((listener) => {
            onCacheChange = listener;
            return vi.fn();
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();

        await facade.connect();
        const wait = facade.rooms.waitForPresence('room-1', {
            expect: { exact: 2 },
            timeoutMs: 1_000
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-a']));
        await onCacheChange?.({ clients: [], groups: [] });

        await expect(wait).resolves.toMatchObject({
            status: 'ready',
            roomId: 'room-1',
            activeSessionIds: ['session-1', 'peer-a'],
            observedCount: 2,
            expectedCount: 2,
            timedOut: false
        });
    });

    it('rechecks room presence after subscribing to avoid missing a ready cache update', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        mocks.onStateCacheChange.mockImplementation(() => {
            mockGroupSnapshot(createGroupSnapshot('room-1', [
                'session-1',
                'peer-a'
            ]));
            return vi.fn();
        });
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rooms.waitForPresence('room-1', {
                expect: { exact: 2 },
                timeoutMs: 1
            })
        ).resolves.toMatchObject({
            status: 'ready',
            roomId: 'room-1',
            activeSessionIds: ['session-1', 'peer-a'],
            observedCount: 2,
            expectedCount: 2,
            timedOut: false
        });
    });

    it('returns timeout when exact expected room RTC peers do not all open', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-ready',
                'peer-slow'
            ])
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                status: peerId === 'peer-ready' ? 'open' : 'timeout',
                peerId,
                laneId
            })
        );
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForRoomLane('room-1', 'realtime', {
                connect: true,
                expect: { exact: 2 },
                timeoutMs: 1_000
            })
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'timeout',
            readyPeerIds: ['peer-ready'],
            notReadyPeerIds: ['peer-slow'],
            observedCount: 1,
            expectedCount: 2
        });
    });

    it('maps exhausted RTC lane attempts to failed with a stable reason', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-a']));
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'exhausted',
            peerId: 'peer-a',
            laneId: 'realtime',
            error: new Error('rtc-connect-attempt-budget-exhausted')
        });
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForRoomLane('room-1', 'realtime', {
                connect: true,
                timeoutMs: 1_000
            })
        ).resolves.toMatchObject({
            status: 'failed',
            notReady: [
                {
                    peerId: 'peer-a',
                    status: 'failed',
                    reason: 'rtc-connect-attempt-budget-exhausted'
                }
            ]
        });
    });

    it('reports over-capacity for strict expected room RTC peer ids', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-a',
                'peer-b'
            ])
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                status: 'open',
                peerId,
                laneId
            })
        );
        const facade = createRallarFacade();

        await facade.connect();

        await expect(
            facade.rtc.waitForRoomLane('room-1', 'realtime', {
                connect: true,
                expect: {
                    sessionIds: ['peer-a'],
                    allowExtras: false
                },
                timeoutMs: 1_000
            })
        ).resolves.toMatchObject({
            status: 'over-capacity',
            readyPeerIds: ['peer-a', 'peer-b'],
            missingPeerIds: [],
            extraPeerIds: ['peer-b'],
            observedCount: 2,
            expectedCount: 1
        });
    });

    it('returns empty for a room RTC lane when the current session is not in the room', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'peer-ready',
                'peer-slow'
            ])
        );
        const facade = createRallarFacade();

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();

        await expect(
            facade.rtc.waitForRoomLane(
                'room-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 1_000
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'empty',
            readyPeerIds: [],
            notReadyPeerIds: [],
            observedCount: 0,
            ready: [],
            notReady: []
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .not.toHaveBeenCalled();
    });

    it('reports room RTC transport status without opening lanes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-ready',
                'peer-slow'
            ])
        );
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([
            'peer-ready',
            'peer-slow'
        ]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([
            'peer-ready',
            'peer-slow'
        ]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-ready'
        ]);

        const facade = createRallarFacade();
        await facade.connect();

        const status = facade.rtc.roomStatus('room-1', {
            laneId: 'realtime',
            minReadyPeers: 1
        });

        expect(status).toMatchObject({
            roomId: 'room-1',
            rtc: {
                mode: 'lazy',
                state: 'partial',
                desiredPeerIds: ['peer-ready', 'peer-slow'],
                knownPeerIds: ['peer-ready', 'peer-slow'],
                activePeerIds: ['peer-ready', 'peer-slow'],
                readyPeerIds: ['peer-ready'],
                laneId: 'realtime'
            }
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .not.toHaveBeenCalled();
    });

    it('opens a room RTC transport when mode is warm', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-ready',
                'peer-slow'
            ])
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                status: peerId === 'peer-ready' ? 'open' : 'timeout',
                peerId,
                laneId,
                error: peerId === 'peer-ready' ? undefined : new Error('timeout')
            })
        );
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-ready'
        ]);

        const facade = createRallarFacade();
        await facade.connect();

        const result = await facade.rtc.openRoom('room-1', {
            mode: 'warm',
            laneId: 'realtime',
            timeoutMs: 250,
            minReadyPeers: 1
        });

        expect(result.rtc.state).toBe('partial');
        expect(result.rtc.readyPeerIds).toEqual(['peer-ready']);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledTimes(2);
    });

    it('waits for room RTC transport readiness with connect by default', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime'
        });
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);

        const facade = createRallarFacade();
        await facade.connect();

        const result = await facade.rtc.waitForRoom('room-1', {
            laneId: 'realtime',
            timeoutMs: 250
        });

        expect(result.rtc.state).toBe('open');
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 250
                })
            );
    });

    it('returns empty for a room RTC lane when the room has no remote peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();

        await facade.connect();
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockClear();

        await expect(
            facade.rtc.waitForRoomLane(
                'room-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 1_000
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'empty',
            readyPeerIds: [],
            notReadyPeerIds: [],
            observedCount: 0,
            ready: [],
            notReady: []
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .not.toHaveBeenCalled();
    });

    it('returns not-connected room RTC lane results before Rallar is connected', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-a',
                'peer-b'
            ])
        );
        const facade = createRallarFacade();

        await expect(
            facade.rtc.waitForRoomLane(
                'room-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 1_000
                }
            )
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'not-connected',
            ready: [],
            notReady: [
                {
                    peerId: 'peer-a',
                    status: 'not-connected'
                },
                {
                    peerId: 'peer-b',
                    status: 'not-connected'
                }
            ]
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .not.toHaveBeenCalled();
    });

    it('uses roomRef scope for room RTC lane waits', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const workspaceA = createGroupSnapshot(
            'shared-room',
            ['session-1', 'peer-a'],
            {
                workspaceId: 'workspace-a'
            }
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            ['session-1', 'peer-b'],
            {
                workspaceId: 'workspace-b'
            }
        );
        mockGroupSnapshots([workspaceA, workspaceB]);
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-b',
            laneId: 'realtime'
        });
        const facade = createRallarFacade();

        await facade.connect();
        const result = await facade.rtc.waitForRoomLane(
            workspaceB.group,
            'realtime',
            {
                connect: true,
                timeoutMs: 1_000
            }
        );

        expect(result.ready.map((ready) => ready.peerId)).toEqual(['peer-b']);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-b',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 1_000
                })
            );
    });
});

function toTestDouble<TValue>(members: Partial<TValue>): TValue {
    return members as TValue;
}
function createPeerTestDouble(
    peerId: string,
    channels: readonly (readonly [string, Partial<QRtcDataChannel>])[]
): QRtcPeerDto {
    return toTestDouble<QRtcPeerDto>({
        peerId,
        connection: toTestDouble<QRtcPeerConnection>({
            status: toTestDouble<QRtcPeerConnection['status']>({
                iceCandidateQueue: [],
                remoteStreams: new Map(),
                makingOffer: false,
                ignoreOffer: false
            })
        }),
        channels: new Map(
            channels.map(([laneId, channel]) => [laneId, toTestDouble<QRtcDataChannel>(channel)] as const)
        )
    });
}

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

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.getAllGroupStateSnapshots.mockImplementation(() => [...snapshots]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) =>
        snapshots.find((snapshot) =>
            snapshot.group.groupId === ref.groupId &&
            snapshot.group.applicationId === ref.applicationId &&
            (snapshot.group.workspaceId ?? '') === (ref.workspaceId ?? '')
        )
    );
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshots.find((snapshot) =>
            snapshot.activeSessions.some(
                (activeSession) => activeSession.sessionId === sessionId
            )
        )?.group
    );
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {}
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds
    });
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return { promise, resolve, reject };
}
