import type * as ApiIntegrationModule from '@shared-web/browser/api-integration.ts';
import type * as ApiWorkflowsModule from '@shared-web/browser/api-workflows.ts';
import type * as AppContextModule from '@shared-web/browser/app-context.ts';
import type * as AuthApiModule from '@shared-web/browser/auth/session-http-api.ts';
import type * as DataCachesModule from '@shared-web/browser/data-caches.ts';
import type * as MiddlewareModule from '@shared-web/browser/middleware.ts';
import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type * as ClientStateSnapshotsRepositoryModule from '@shared/repository/client-state-snapshots-repository.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/WebRtcConnectionService.ts';
import type { WebSocketClientCallbacks } from '@shared/websocket/JsonWebSocketClient.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';
import { createDeferred, createMediaStream, createMediaTrack } from './browser-lifecycle-fixtures.ts';

const mocks = await vi.hoisted(async () => {
    // The shared double must be pulled in dynamically: vi.hoisted runs above the static import
    // transform, so a statically imported factory is still in its temporal dead zone here.
    const { createApiMiddlewareTestDouble } = await import(
        './api-middleware-test-double.ts'
    );
    const ctx = createApiMiddlewareTestDouble();
    const session = ctx.session;
    const readMissingClientStateSnapshotRepository = (): never => {
        throw new Error(
            'Repository not found: shared.repository.client-state-snapshots'
        );
    };
    const readMissingGroupStateSnapshotRepository = (): never => {
        throw new Error(
            'Repository not found: shared.repository.group-state-snapshots'
        );
    };

    return {
        ctx,
        readMissingClientStateSnapshotRepository,
        readMissingGroupStateSnapshotRepository,
        clearMiddleware: vi.fn<typeof AppContextModule.clearMiddleware>(),
        clearSession: vi.fn<typeof AuthModule.clearSession>(),
        createAndJoinStateGroup: vi.fn<typeof ApiWorkflowsModule.createAndJoinStateGroup>(() => Promise.reject(new Error('create not mocked'))),
        findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(
            readMissingClientStateSnapshotRepository
        ),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findFirstGroupStateSnapshotRefSessionIdIsIn>(
            readMissingGroupStateSnapshotRepository
        ),
        findGroupStateSnapshotByRef: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef>(readMissingGroupStateSnapshotRepository),
        getAllClientStateSnapshots: vi.fn<typeof ClientStateSnapshotsRepositoryModule.getAllClientStateSnapshots>(readMissingClientStateSnapshotRepository),
        getAllGroupStateSnapshots: vi.fn<typeof GroupStateSnapshotsRepositoryModule.getAllGroupStateSnapshots>(readMissingGroupStateSnapshotRepository),
        hydrateStateCaches: vi.fn<typeof DataCachesModule.hydrateStateCaches>(
            () => Promise.resolve()
        ),
        initMiddleware: vi.fn<typeof AppContextModule.initMiddleware>(() => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn<typeof AppContextModule.isMiddlewareReady>(
            () => false
        ),
        joinStateGroup: vi.fn<typeof ApiWorkflowsModule.joinStateGroup>(() => Promise.reject(new Error('join not mocked'))),
        leaveStateGroup: vi.fn<typeof ApiWorkflowsModule.leaveStateGroup>(() => Promise.reject(new Error('leave not mocked'))),
        listStateClientEventPage: vi.fn<typeof ApiIntegrationModule.listStateClientEventPage>(() => Promise.reject(new Error('client event page not mocked'))),
        listStateClientEvents: vi.fn<typeof ApiIntegrationModule.listStateClientEvents>(() => Promise.reject(new Error('client events not mocked'))),
        listStateGroupEventPage: vi.fn<typeof ApiIntegrationModule.listStateGroupEventPage>(() => Promise.reject(new Error('group event page not mocked'))),
        listStateGroupEvents: vi.fn<typeof ApiIntegrationModule.listStateGroupEvents>(() => Promise.reject(new Error('group events not mocked'))),
        loginToApi: vi.fn<typeof AuthApiModule.loginToApi>(() => Promise.resolve(session)),
        logoutFromApi: vi.fn<typeof AuthApiModule.logoutFromApi>(() => Promise.resolve({ loggedOut: true })),
        onStateCacheChange: vi.fn<typeof DataCachesModule.onStateCacheChange>(
            () => vi.fn()
        ),
        readSession: vi.fn<typeof AuthModule.readSession>(() => session),
        refreshStateSnapshots: vi.fn<typeof ApiWorkflowsModule.refreshStateSnapshots>(() => Promise.resolve({ clients: [], groups: [] })),
        registerWithApi: vi.fn<typeof AuthApiModule.registerWithApi>(
            () =>
                Promise.resolve({
                    clientId: 'client-new',
                    username: 'new-user',
                    displayName: null,
                    registeredAtEpochMs: 1_000
                })
        ),
        updateStateGroupMetadata: vi.fn<typeof ApiWorkflowsModule.updateStateGroupMetadata>(() => Promise.reject(new Error('metadata update not mocked'))),
        writeSession: vi.fn<typeof AuthModule.writeSession>()
    };
});

const qboxEngine = vi.mocked(mocks.ctx.middleware.qboxEngine);
const rtcRxStreamer = vi.mocked(mocks.ctx.middleware.rtcRxStreamer);
const webRtcConnectionService = vi.mocked(
    mocks.ctx.middleware.webRtcConnectionService
);
const webSocketQueueBox = vi.mocked(mocks.ctx.middleware.webSocketQueueBox);
const webSocketClient = vi.mocked(mocks.ctx.middleware.webSocketQueueBox.socket);

vi.mock(
    import('@shared-web/browser/middleware.ts'),
    (): Partial<typeof MiddlewareModule> => ({
        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initMiddleware(options)).middleware
    })
);

vi.mock(
    import('@shared-web/browser/api-integration.ts'),
    (): Partial<typeof ApiIntegrationModule> => ({
        listStateClientEventPage: mocks.listStateClientEventPage,
        listStateClientEvents: mocks.listStateClientEvents,
        listStateGroupEventPage: mocks.listStateGroupEventPage,
        listStateGroupEvents: mocks.listStateGroupEvents
    })
);

vi.mock(
    import('@shared-web/browser/auth/session-http-api.ts'),
    (): Partial<typeof AuthApiModule> => ({
        loginToApi: mocks.loginToApi,
        logoutFromApi: mocks.logoutFromApi,
        registerWithApi: mocks.registerWithApi
    })
);

vi.mock(
    import('@shared-web/browser/api-workflows.ts'),
    (): Partial<typeof ApiWorkflowsModule> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup,
        refreshStateSnapshots: mocks.refreshStateSnapshots,
        updateStateGroupMetadata: mocks.updateStateGroupMetadata
    })
);

vi.mock(
    import('@shared-web/browser/data-caches.ts'),
    (): Partial<typeof DataCachesModule> => ({
        hydrateStateCaches: mocks.hydrateStateCaches,
        onStateCacheChange: mocks.onStateCacheChange
    })
);

vi.mock(
    import('@shared/api/auth.ts'),
    (): Partial<typeof AuthModule> => ({
        clearSession: mocks.clearSession,
        isLoggedIn: vi.fn<typeof AuthModule.isLoggedIn>(() => true),
        readSession: mocks.readSession,
        writeSession: mocks.writeSession
    })
);

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<typeof ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<typeof GroupStateSnapshotsRepositoryModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
    })
);

describe('Rallar WS lifecycle', () => {
    beforeEach(async () => {
        (await import('@shared-web/browser/connection/browser-transport-runtime.ts'))
            .browserTransportRuntime.shutdown('test-reset');
        vi.clearAllMocks();
        vi.useRealTimers();
        mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
        mocks.getAllClientStateSnapshots.mockReturnValue([]);
        mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
        mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
        mocks.getAllGroupStateSnapshots.mockReturnValue([]);
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
        webRtcConnectionService.peerIdsWithNoReconnectableLanes.mockReturnValue([]);
        webRtcConnectionService.knownPeerIds.mockReturnValue([]);
        webRtcConnectionService.activePeerIds.mockReturnValue([]);
        webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
        webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
            (peerId) =>
                Either.ofLeft({
                    kind: 'connect-failed',
                    peerId,
                    error: new Error('connect not mocked')
                })
        );
        webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                status: 'connect-failed',
                peerId,
                laneId,
                error: new Error('connect not mocked')
            })
        );
        webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() => webRtcConnectionService);
        webRtcConnectionService.readPeer.mockReturnValue(undefined);
        webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(async (message) => ({
            status: 'enqueued',
            message,
            entries: []
        }));
        rtcRxStreamer.onInboxMessageDo.mockReturnValue(rtcRxStreamer);
        rtcRxStreamer.removeInboxMessageCallback.mockReturnValue(true);
        webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(async (message) => ({
            status: 'enqueued',
            message,
            entries: []
        }));
        webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(webSocketQueueBox);
        webSocketQueueBox.removeAnyInboxMessageCallback.mockReturnValue(true);
        webSocketQueueBox.readHealth.mockReturnValue({
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
        webSocketQueueBox.close.mockImplementation((code, reason) => {
            webSocketClient.close(code, reason);
        });
        webSocketClient.onWebsocketCallbacksDo.mockReturnValue(webSocketClient);
        webSocketClient.removeWebsocketCallbackById.mockReturnValue(true);
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

    it('exposes read-only WS diagnostics after connecting', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws?ticket=secret-ticket&other=value#fragment',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 2,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        const facade = createRallarFacade();

        await facade.connect();

        expect(facade.ws.status()).toEqual({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            connectState: 'connected',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 2,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
    });

    it('notifies public WS status and lifecycle subscribers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        let callbacks: WebSocketClientCallbacks | undefined;
        const removedCallbackIds: string[] = [];
        webSocketClient.onWebsocketCallbacksDo.mockImplementation((_id, next) => {
            callbacks = next;
            return webSocketClient;
        });
        webSocketClient.removeWebsocketCallbackById.mockImplementation((id) => {
            removedCallbackIds.push(id);
            return true;
        });
        webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws?ticket=secret-ticket',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        const facade = createRallarFacade();
        const statuses: unknown[] = [];
        const lifecycles: unknown[] = [];

        const unsubscribeStatus = facade.ws.onStatus((status) => {
            statuses.push(status);
        });
        const unsubscribeLifecycle = facade.ws.onLifecycle((event) => {
            lifecycles.push(event);
        });

        expect(statuses).toEqual([
            expect.objectContaining({
                readyState: 'missing',
                reconnectEnabled: false
            })
        ]);
        expect(lifecycles).toEqual([
            expect.objectContaining({
                kind: 'snapshot',
                status: expect.objectContaining({
                    readyState: 'missing'
                })
            })
        ]);

        await facade.connect();

        expect(webSocketClient.onWebsocketCallbacksDo)
            .toHaveBeenCalledWith(
                'rallar:ws:status',
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
                    url: 'ws://localhost/ws',
                    readyState: 'open',
                    reconnectEnabled: true
                })
            })
        );

        webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'closed',
            readyStateCode: 3,
            isOpen: false,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 1,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        callbacks?.onClose?.({
            type: 'close',
            code: 1006,
            reason: 'network-lost',
            wasClean: false
        } as CloseEvent);

        expect(statuses.at(-1)).toMatchObject({
            readyState: 'closed',
            reconnecting: true,
            reconnectEnabled: true
        });
        expect(lifecycles.at(-1)).toMatchObject({
            kind: 'close',
            code: 1006,
            reason: 'network-lost',
            wasClean: false,
            eventType: 'close',
            intentional: false,
            status: {
                readyState: 'closed'
            }
        });

        unsubscribeStatus();
        expect(removedCallbackIds).toEqual([]);

        unsubscribeLifecycle();
        expect(removedCallbackIds).toEqual(['rallar:ws:status']);
    });

    it('waits for WS open without implicitly connecting', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        await expect(facade.ws.waitForOpen({ timeoutMs: 1 })).resolves
            .toMatchObject({
                transport: 'ws',
                status: 'not-connected',
                wsStatus: {
                    readyState: 'missing',
                    isOpen: false
                }
            });
    });

    it('returns aborted for an already-aborted WS wait', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const controller = new AbortController();
        controller.abort();

        await expect(
            createRallarFacade().ws.waitForOpen({
                signal: controller.signal
            })
        ).resolves.toMatchObject({
            transport: 'ws',
            status: 'aborted'
        });
    });

    it('resolves WS wait immediately when the socket is already open', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.ws.waitForOpen()).resolves.toMatchObject({
            transport: 'ws',
            status: 'open',
            wsStatus: {
                readyState: 'open',
                isOpen: true
            }
        });
    });

    it('times out WS wait without calling connect again', async () => {
        vi.useFakeTimers();
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'connecting',
            readyStateCode: 0,
            isOpen: false,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 1,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        const middlewareInitializations: string[] = [];
        mocks.initMiddleware.mockImplementation(async () => {
            middlewareInitializations.push(mocks.ctx.session.sessionId);
            return mocks.ctx;
        });
        const facade = createRallarFacade();

        await facade.connect();
        mocks.initMiddleware.mockClear();
        const wait = facade.ws.waitForOpen({ timeoutMs: 25 });

        await vi.advanceTimersByTimeAsync(25);

        await expect(wait).resolves.toMatchObject({
            transport: 'ws',
            status: 'timeout',
            wsStatus: {
                readyState: 'connecting',
                reconnecting: true
            }
        });
        expect(middlewareInitializations).toEqual(['session-1']);
    });

    it('resolves WS wait when the socket opens after waiting starts', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        let callbacks: WebSocketClientCallbacks | undefined;
        webSocketClient.onWebsocketCallbacksDo.mockImplementation((_id, next) => {
            callbacks = next;
            return webSocketClient;
        });
        webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'connecting',
            readyStateCode: 0,
            isOpen: false,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 1,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        const facade = createRallarFacade();

        await facade.connect();
        const wait = facade.ws.waitForOpen({ timeoutMs: 1_000 });
        webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        callbacks?.onOpen?.({ type: 'open' } as Event);

        await expect(wait).resolves.toMatchObject({
            transport: 'ws',
            status: 'open',
            wsStatus: {
                readyState: 'open',
                isOpen: true
            }
        });
    });

    it('returns closed for terminal closed WS status', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'closed',
            readyStateCode: 3,
            isOpen: false,
            reconnecting: false,
            reconnectEnabled: false,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.ws.waitForOpen()).resolves.toMatchObject({
            transport: 'ws',
            status: 'closed',
            wsStatus: {
                readyState: 'closed',
                reconnecting: false,
                reconnectEnabled: false
            }
        });
    });

    it('returns aborted when WS wait is aborted while pending', async () => {
        vi.useFakeTimers();
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'connecting',
            readyStateCode: 0,
            isOpen: false,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 1,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        const facade = createRallarFacade();
        const controller = new AbortController();

        await facade.connect();
        const wait = facade.ws.waitForOpen({
            signal: controller.signal,
            timeoutMs: 1_000
        });
        controller.abort();
        await vi.runOnlyPendingTimersAsync();

        await expect(wait).resolves.toMatchObject({
            transport: 'ws',
            status: 'aborted'
        });
    });
});

function findLatestWsAnyMessageCallback(): OnMessageCallback | undefined {
    return webSocketQueueBox
        .onAnyInboxMessageDo.mock.calls
        .filter(([callbackId]) => callbackId === 'rallar:ws:any-message')
        .at(-1)?.[1];
}
function createChannelHealth(
    input: Readonly<{
        peerId: string;
        label: string;
        state: string;
        readyState: RTCDataChannelState;
    }>
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
        snapshots.find((snapshot) => snapshot.group.groupId === sessionId)?.group
    );
}

function withSnapshotVersion(
    snapshot: GroupSnapshot,
    snapshotVersion: number
): GroupSnapshot {
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            snapshotVersion
        }
    };
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
