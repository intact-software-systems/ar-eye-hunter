import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import {
    newALBroadcastMessage,
    newALEventRoute,
    newALMulticastMessage,
    newALRoute,
    newALUnicastMessage,
} from '@shared/al-contracts/al-contract.ts';

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
        ensurePeerConnectionStarted: vi.fn((_peerId: string) =>
            ({
                left: {
                    kind: 'connect-failed',
                    peerId: _peerId,
                    error: new Error('connect not mocked'),
                },
            })
        ),
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
                onRemoteStreamDo: vi.fn(),
                removeOnRemoteStreamCallbackById: vi.fn(),
                setLocalMediaStream: vi.fn(),
                setLocalAudioEnabled: vi.fn(),
                setLocalVideoEnabled: vi.fn(),
                setMediaPolicy: vi.fn(),
                stopLocalMedia: vi.fn(),
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
        clearSession: vi.fn(),
        clearMiddleware: vi.fn(),
        hydrateStateCaches: vi.fn(() => Promise.resolve()),
        initMiddleware: vi.fn((_options?: unknown) => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        createAndJoinStateGroup: vi.fn(
            (
                _displayName?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('create not mocked')),
        ),
        joinStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('join not mocked')),
        ),
        leaveStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('leave not mocked')),
        ),
        updateStateGroupMetadata: vi.fn(
            (
                _roomId?: unknown,
                _patch?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('metadata update not mocked')),
        ),
        loginToApi: vi.fn((_request?: unknown, _options?: unknown) =>
            Promise.resolve(session)
        ),
        listStateClientEvents: vi.fn((_principalId?: unknown, _scope?: unknown, _options?: unknown) =>
            Promise.reject(new Error('client events not mocked'))
        ),
        listStateClientEventPage: vi.fn((_principalId?: unknown, _scope?: unknown, _options?: unknown) =>
            Promise.reject(new Error('client event page not mocked'))
        ),
        listStateGroupEvents: vi.fn((_groupId?: unknown, _scope?: unknown, _options?: unknown) =>
            Promise.reject(new Error('group events not mocked'))
        ),
        listStateGroupEventPage: vi.fn((_groupId?: unknown, _scope?: unknown, _options?: unknown) =>
            Promise.reject(new Error('group event page not mocked'))
        ),
        logoutFromApi: vi.fn((_options?: unknown) =>
            Promise.resolve({ loggedOut: true })
        ),
        registerWithApi: vi.fn((_request?: unknown, _options?: unknown) =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                registeredAtEpochMs: 1_000,
            })
        ),
        onStateCacheChange: vi.fn(() => vi.fn()),
        readSession: vi.fn(() => session),
        refreshStateSnapshots: vi.fn((_scope?: unknown, _policies?: unknown) =>
            Promise.resolve({ clients: [], groups: [] })
        ),
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
        writeSession: vi.fn(),
    };
});

vi.mock('@shared-web/browser/app-context.ts', () => ({
    clearMiddleware: mocks.clearMiddleware,
    getMiddleware: vi.fn(() => mocks.ctx),
    initMiddleware: mocks.initMiddleware,
    isMiddlewareReady: mocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/api-integration.ts', () => ({
    listStateClientEventPage: mocks.listStateClientEventPage,
    listStateClientEvents: mocks.listStateClientEvents,
    listStateGroupEventPage: mocks.listStateGroupEventPage,
    listStateGroupEvents: mocks.listStateGroupEvents,
    loginToApi: mocks.loginToApi,
    logoutFromApi: mocks.logoutFromApi,
    registerWithApi: mocks.registerWithApi,
}));

vi.mock('@shared-web/browser/api-workflows.ts', () => ({
    createAndJoinStateGroup: mocks.createAndJoinStateGroup,
    joinStateGroup: mocks.joinStateGroup,
    leaveStateGroup: mocks.leaveStateGroup,
    refreshStateSnapshots: mocks.refreshStateSnapshots,
    updateStateGroupMetadata: mocks.updateStateGroupMetadata,
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: mocks.onStateCacheChange,
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: mocks.clearSession,
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: mocks.writeSession,
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

describe('Rallar operation options', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
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
            new Error('metadata update not mocked'),
        );
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue([]);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
            (peerId: string) =>
                ({
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
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() =>
            mocks.webRtcConnectionService
        );
        mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
        mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockResolvedValue({
            status: 'enqueued',
            entries: [],
        });
        mocks.ctx.middleware.rtcRxStreamer.onInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.rtcRxStreamer,
        );
        mocks.ctx.middleware.rtcRxStreamer.removeInboxMessageCallback
            .mockReturnValue(true);
        mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent.mockResolvedValue({
            status: 'enqueued',
            entries: [],
        });
        mocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.webSocketQueueBox,
        );
        mocks.ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback
            .mockReturnValue(true);
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
        mocks.ctx.middleware.webSocketQueueBox.close.mockImplementation(
            (code?: number, reason?: string) => {
                mocks.ctx.middleware.webSocketQueueBox.socket.close(code, reason);
            },
        );
        mocks.ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo
            .mockReturnValue(mocks.ctx.middleware.webSocketQueueBox.socket);
        mocks.ctx.middleware.webSocketQueueBox.socket.removeWebsocketCallbackById
            .mockReturnValue(true);
        mocks.registerWithApi.mockResolvedValue({
            clientId: 'client-new',
            username: 'new-user',
            registeredAtEpochMs: 1_000,
        });
        mocks.listStateClientEvents.mockRejectedValue(
            new Error('client events not mocked'),
        );
        mocks.listStateClientEventPage.mockRejectedValue(
            new Error('client event page not mocked'),
        );
        mocks.listStateGroupEvents.mockRejectedValue(
            new Error('group events not mocked'),
        );
        mocks.listStateGroupEventPage.mockRejectedValue(
            new Error('group event page not mocked'),
        );
    });

    it('returns empty state before cache repositories are configured', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const roomListener = vi.fn();
        const peopleListener = vi.fn();

        expect(facade.rooms.state().rooms).toEqual([]);
        expect(facade.rooms.state().members).toEqual([]);
        expect(facade.people.state().people).toEqual([]);
        expect(facade.people.state().clients).toEqual([]);
        expect(facade.people.get('principal-1')).toBeUndefined();

        facade.rooms.onChange(roomListener);
        facade.people.onChange(peopleListener);

        expect(roomListener).toHaveBeenCalledWith(
            expect.objectContaining({ rooms: [], members: [] }),
        );
        expect(peopleListener).toHaveBeenCalledWith(
            expect.objectContaining({ people: [], clients: [] }),
        );
    });

    it('delivers group state events through rooms.onEvent without treating them as state changes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const roomListener = vi.fn();
        const eventListener = vi.fn();

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        facade.rooms.onChange(roomListener, { emitCurrent: false });
        facade.rooms.onEvent(eventListener, {
            roomId: 'room-1',
            eventTypes: ['member-joined'],
        });
        await facade.connect();
        roomListener.mockClear();

        const wsCallback = findWsAnyMessageCallback();
        await wsCallback?.onMessage?.(
            toGroupStateEventMessage(
                createGroupEvent('room-1', 'group-event-1', 'member-joined'),
            ),
        );
        await wsCallback?.onMessage?.(
            toGroupStateEventMessage(
                createGroupEvent('room-1', 'group-event-1', 'member-joined'),
            ),
        );
        await wsCallback?.onMessage?.(
            toGroupStateEventMessage(
                createGroupEvent('room-2', 'group-event-2', 'member-joined'),
            ),
        );
        await wsCallback?.onMessage?.(
            toGroupStateEventMessage(
                createGroupEvent('room-1', 'group-event-3', 'member-left'),
            ),
        );
        await wsCallback?.onMessage?.(
            toGroupStateEventMessage(
                createGroupEvent('room-1', 'group-event-4', 'member-joined', {
                    workspaceId: 'workspace-2',
                }),
            ),
        );

        expect(roomListener).not.toHaveBeenCalled();
        expect(eventListener).toHaveBeenCalledOnce();
        expect(eventListener.mock.calls[0]?.[0]).toMatchObject({
            groupId: 'room-1',
            eventId: 'group-event-1',
            eventType: 'member-joined',
            snapshotVersion: 1,
        });
        expect(eventListener.mock.calls[0]?.[1]).toMatchObject({
            transport: 'ws',
            typeId: AppTopics.groupStateEvent,
            topicId: AppTopics.groupStateEvent,
        });
    });

    it('delivers client state events through people.onEvent with filtering and unsubscribe', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const eventListener = vi.fn();

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        const unsubscribe = facade.people.onEvent(eventListener, {
            principalId: 'alice',
            eventTypes: ['session-connected'],
        });
        await facade.connect();

        const wsCallback = findWsAnyMessageCallback();
        await wsCallback?.onMessage?.(
            toClientStateEventMessage(
                createClientEvent('alice', 'client-event-1', 'session-connected'),
            ),
        );
        await wsCallback?.onMessage?.(
            toClientStateEventMessage(
                createClientEvent('alice', 'client-event-1', 'session-connected'),
            ),
        );
        await wsCallback?.onMessage?.(
            toClientStateEventMessage(
                createClientEvent('bob', 'client-event-2', 'session-connected'),
            ),
        );
        await wsCallback?.onMessage?.(
            toClientStateEventMessage(
                createClientEvent('alice', 'client-event-3', 'principal-updated'),
            ),
        );
        await wsCallback?.onMessage?.(
            toClientStateEventMessage(
                createClientEvent('alice', 'client-event-4', 'session-connected', {
                    workspaceId: 'workspace-2',
                }),
            ),
        );
        unsubscribe();
        await wsCallback?.onMessage?.(
            toClientStateEventMessage(
                createClientEvent('alice', 'client-event-5', 'session-connected'),
            ),
        );

        expect(eventListener).toHaveBeenCalledOnce();
        expect(eventListener.mock.calls[0]?.[0]).toMatchObject({
            principalId: 'alice',
            eventId: 'client-event-1',
            eventType: 'session-connected',
            snapshotVersion: 1,
        });
        expect(eventListener.mock.calls[0]?.[1]).toMatchObject({
            transport: 'ws',
            typeId: AppTopics.clientStateEvent,
            topicId: AppTopics.clientStateEvent,
        });
    });

    it('does not replay live state events missed while disconnected', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const eventListener = vi.fn();

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        facade.rooms.onEvent(eventListener, {
            roomId: 'room-1',
        });
        await facade.connect();

        await findLatestWsAnyMessageCallback()?.onMessage?.(
            toGroupStateEventMessage(
                createGroupEvent('room-1', 'group-event-1', 'member-joined'),
            ),
        );
        expect(eventListener).toHaveBeenCalledTimes(1);

        await facade.disconnect();
        expect(
            mocks.ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback,
        ).toHaveBeenCalledWith('rallar:ws:any-message');

        await facade.connect();

        expect(eventListener).toHaveBeenCalledTimes(1);

        await findLatestWsAnyMessageCallback()?.onMessage?.(
            toGroupStateEventMessage(
                createGroupEvent('room-1', 'group-event-3', 'member-left'),
            ),
        );
        expect(eventListener).toHaveBeenCalledTimes(2);
    });

    it('uses refresh snapshots as convergence without replaying missed event callbacks', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const roomEventListener = vi.fn();
        const peopleEventListener = vi.fn();
        const groupSnapshot = createGroupSnapshot('room-1', ['session-1']);
        const clientSnapshot = createClientSnapshot('principal-1', 'session-1');

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        facade.rooms.onEvent(roomEventListener);
        facade.people.onEvent(peopleEventListener);
        mocks.refreshStateSnapshots.mockResolvedValue({
            clients: [clientSnapshot],
            groups: [groupSnapshot],
        });

        await facade.rooms.refresh();
        await facade.people.refresh();

        expect(roomEventListener).not.toHaveBeenCalled();
        expect(peopleEventListener).not.toHaveBeenCalled();
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledTimes(2);
        expect(mocks.hydrateStateCaches).toHaveBeenCalledWith(
            mocks.ctx.middleware.webRtcGroupManager,
            expect.objectContaining({
                clientId: 'principal-1',
                sessionId: 'session-1',
            }),
            [clientSnapshot],
            [groupSnapshot],
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                },
            },
        );
    });

    it('passes facade defaults into middleware startup scope', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        facade.setDefaults({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
        });

        await facade.start({ refreshRooms: true });

        expect(mocks.initMiddleware).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: {
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default',
                },
            }),
        );
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
            },
            expect.any(Object),
        );
    });

    it('filters cached room state to the configured facade scope', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const arRoom = createGroupSnapshot('arena-room', ['session-1'], {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
        });
        const staleRallarRoom = createGroupSnapshot('stale-room', ['session-1'], {
            applicationId: 'rallar-server',
            workspaceId: 'default',
        });

        facade.setDefaults({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
        });
        mocks.groupRepositoryMissing.mockImplementation((roomRef?: unknown) => {
            if (roomRef === undefined) {
                return [staleRallarRoom, arRoom];
            }

            if (typeof roomRef === 'string') {
                return arRoom.group;
            }

            if (typeof roomRef === 'object' && roomRef !== null) {
                const ref = roomRef as { applicationId?: string; groupId?: string };
                return ref.applicationId === 'ar-eye-hunter' &&
                        ref.groupId === 'arena-room'
                    ? arRoom
                    : undefined;
            }
        });

        expect(facade.rooms.state().rooms.map((room) => room.roomId)).toEqual([
            'arena-room',
        ]);
        expect(facade.rooms.state().currentRoomRef).toEqual(arRoom.group);
    });

    it('lists room and people events without connecting or hydrating state caches', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const groupEvent = createGroupEvent(
            'room-1',
            'group-event-1',
            'member-joined',
            {
                applicationId: 'room-app',
                workspaceId: 'room-workspace',
            },
        );
        const clientEvent = createClientEvent(
            'alice',
            'client-event-1',
            'session-connected',
            {
                applicationId: 'people-app',
                workspaceId: 'people-workspace',
            },
        );

        mocks.listStateGroupEvents.mockResolvedValue([groupEvent]);
        mocks.listStateClientEvents.mockResolvedValue([clientEvent]);

        await expect(
            facade.rooms.listEvents({
                roomRef: {
                    applicationId: 'room-app',
                    workspaceId: 'room-workspace',
                    groupId: 'room-1',
                },
                scope: {
                    applicationId: 'ignored-app',
                    workspaceId: 'ignored-workspace',
                },
                eventTypes: ['member-joined'],
                limit: 2,
            }),
        ).resolves.toEqual([groupEvent]);
        await expect(
            facade.people.listEvents('alice', {
                scope: {
                    applicationId: 'people-app',
                    workspaceId: 'people-workspace',
                },
                eventTypes: ['session-connected'],
                limit: 3,
            }),
        ).resolves.toEqual([clientEvent]);

        expect(mocks.initMiddleware).not.toHaveBeenCalled();
        expect(mocks.hydrateStateCaches).not.toHaveBeenCalled();
        expect(mocks.listStateGroupEvents).toHaveBeenCalledWith(
            'room-1',
            {
                applicationId: 'room-app',
                workspaceId: 'room-workspace',
            },
            {
                eventTypes: ['member-joined'],
                limit: 2,
                signal: expect.any(AbortSignal),
            },
        );
        expect(mocks.listStateClientEvents).toHaveBeenCalledWith(
            'alice',
            {
                applicationId: 'people-app',
                workspaceId: 'people-workspace',
            },
            {
                eventTypes: ['session-connected'],
                limit: 3,
                signal: expect.any(AbortSignal),
            },
        );
    });

    it('uses facade defaults for string room event history reads', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const groupEvent = createGroupEvent(
            'room-1',
            'group-event-1',
            'member-joined',
        );

        facade.setDefaults({
            applicationId: 'default-app',
            workspaceId: 'default-workspace',
        });
        mocks.listStateGroupEvents.mockResolvedValue([groupEvent]);

        await expect(facade.rooms.listEvents('room-1')).resolves.toEqual([
            groupEvent,
        ]);

        expect(mocks.initMiddleware).not.toHaveBeenCalled();
        expect(mocks.listStateGroupEvents).toHaveBeenCalledWith(
            'room-1',
            {
                applicationId: 'default-app',
                workspaceId: 'default-workspace',
            },
            {
                signal: expect.any(AbortSignal),
            },
        );
    });

    it('lists room and people event pages with cursor options', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const groupEvent = createGroupEvent(
            'room-1',
            'group-event-2',
            'member-left',
        );
        const clientEvent = createClientEvent(
            'alice',
            'client-event-2',
            'session-disconnected',
        );
        const after = {
            snapshotVersion: 1,
            occurredAtEpochMs: 1_000,
            eventId: 'event-1',
        };
        const groupPage = {
            events: [groupEvent],
            nextCursor: {
                snapshotVersion: 2,
                occurredAtEpochMs: 2_000,
                eventId: groupEvent.eventId,
            },
            hasMore: false,
        };
        const clientPage = {
            events: [clientEvent],
            nextCursor: {
                snapshotVersion: 3,
                occurredAtEpochMs: 3_000,
                eventId: clientEvent.eventId,
            },
            hasMore: true,
        };

        facade.setDefaults({
            applicationId: 'default-app',
            workspaceId: 'default-workspace',
        });
        mocks.listStateGroupEventPage.mockResolvedValue(groupPage);
        mocks.listStateClientEventPage.mockResolvedValue(clientPage);

        await expect(
            facade.rooms.listEventPage({
                roomId: 'room-1',
                eventTypes: ['member-left'],
                limit: 2,
                after,
            }),
        ).resolves.toEqual(groupPage);
        await expect(
            facade.people.listEventPage('alice', {
                eventTypes: ['session-disconnected'],
                limit: 3,
                after,
            }),
        ).resolves.toEqual(clientPage);

        expect(mocks.initMiddleware).not.toHaveBeenCalled();
        expect(mocks.hydrateStateCaches).not.toHaveBeenCalled();
        expect(mocks.listStateGroupEventPage).toHaveBeenCalledWith(
            'room-1',
            {
                applicationId: 'default-app',
                workspaceId: 'default-workspace',
            },
            {
                eventTypes: ['member-left'],
                limit: 2,
                after,
                signal: expect.any(AbortSignal),
            },
        );
        expect(mocks.listStateClientEventPage).toHaveBeenCalledWith(
            'alice',
            {
                applicationId: 'default-app',
                workspaceId: 'default-workspace',
            },
            {
                eventTypes: ['session-disconnected'],
                limit: 3,
                after,
                signal: expect.any(AbortSignal),
            },
        );
    });

    it('replays room and people events explicitly and deduplicates live overlap', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const liveRoomListener = vi.fn();
        const replayRoomListener = vi.fn();
        const peopleListener = vi.fn();
        const liveRoomEvent = createGroupEvent(
            'room-1',
            'group-event-1',
            'member-joined',
        );
        const replayRoomEvent = createGroupEvent(
            'room-1',
            'group-event-2',
            'member-left',
            { snapshotVersion: 2, occurredAtEpochMs: 2 },
        );
        const replayClientEvent = createClientEvent(
            'alice',
            'client-event-1',
            'session-connected',
        );
        const roomPage = {
            events: [liveRoomEvent, replayRoomEvent],
            nextCursor: {
                snapshotVersion: replayRoomEvent.snapshotVersion,
                occurredAtEpochMs: replayRoomEvent.occurredAtEpochMs,
                eventId: replayRoomEvent.eventId,
            },
            hasMore: false,
        };
        const clientPage = {
            events: [replayClientEvent],
            nextCursor: {
                snapshotVersion: replayClientEvent.snapshotVersion,
                occurredAtEpochMs: replayClientEvent.occurredAtEpochMs,
                eventId: replayClientEvent.eventId,
            },
            hasMore: false,
        };

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        facade.rooms.onEvent(liveRoomListener, { roomId: 'room-1' });
        facade.people.onEvent(peopleListener, { principalId: 'alice' });
        mocks.listStateGroupEventPage.mockResolvedValue(roomPage);
        mocks.listStateClientEventPage.mockResolvedValue(clientPage);
        await facade.connect();

        await findLatestWsAnyMessageCallback()?.onMessage?.(
            toGroupStateEventMessage(liveRoomEvent),
        );

        const roomReplayResult = await facade.rooms.replayEvents(
            {
                roomId: 'room-1',
                after: {
                    snapshotVersion: 1,
                    occurredAtEpochMs: 1,
                    eventId: liveRoomEvent.eventId,
                },
                limit: 2,
            },
            replayRoomListener,
        );
        const peopleReplayResult = await facade.people.replayEvents('alice');

        await findLatestWsAnyMessageCallback()?.onMessage?.(
            toGroupStateEventMessage(replayRoomEvent),
        );
        await findLatestWsAnyMessageCallback()?.onMessage?.(
            toClientStateEventMessage(replayClientEvent),
        );

        expect(liveRoomListener).toHaveBeenCalledOnce();
        expect(replayRoomListener).toHaveBeenCalledOnce();
        expect(replayRoomListener.mock.calls[0]?.[0]).toEqual(replayRoomEvent);
        expect(replayRoomListener.mock.calls[0]?.[1]).toMatchObject({
            transport: 'replay',
            typeId: AppTopics.groupStateEvent,
            topicId: AppTopics.groupStateEvent,
        });
        expect(roomReplayResult).toMatchObject({
            events: [replayRoomEvent],
            duplicateCount: 1,
            replayedCount: 1,
            pageCount: 1,
            hasMore: false,
        });
        expect(peopleListener).toHaveBeenCalledOnce();
        expect(peopleListener.mock.calls[0]?.[0]).toEqual(replayClientEvent);
        expect(peopleListener.mock.calls[0]?.[1]).toMatchObject({
            transport: 'replay',
            typeId: AppTopics.clientStateEvent,
            topicId: AppTopics.clientStateEvent,
        });
        expect(peopleReplayResult).toMatchObject({
            events: [replayClientEvent],
            duplicateCount: 0,
            replayedCount: 1,
            pageCount: 1,
            hasMore: false,
        });
        expect(mocks.listStateGroupEventPage).toHaveBeenCalledWith(
            'room-1',
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
            },
            expect.objectContaining({
                after: {
                    snapshotVersion: 1,
                    occurredAtEpochMs: 1,
                    eventId: liveRoomEvent.eventId,
                },
                limit: 2,
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it('replays multiple room event pages until maxPages or completion', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const listener = vi.fn();
        const eventA = createGroupEvent(
            'room-1',
            'group-event-1',
            'member-joined',
        );
        const eventB = createGroupEvent(
            'room-1',
            'group-event-2',
            'member-left',
            { snapshotVersion: 2, occurredAtEpochMs: 2 },
        );
        const cursorA = {
            snapshotVersion: eventA.snapshotVersion,
            occurredAtEpochMs: eventA.occurredAtEpochMs,
            eventId: eventA.eventId,
        };
        const cursorB = {
            snapshotVersion: eventB.snapshotVersion,
            occurredAtEpochMs: eventB.occurredAtEpochMs,
            eventId: eventB.eventId,
        };

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        facade.rooms.onEvent(listener, { roomId: 'room-1' });
        mocks.listStateGroupEventPage
            .mockResolvedValueOnce({
                events: [eventA],
                nextCursor: cursorA,
                hasMore: true,
            })
            .mockResolvedValueOnce({
                events: [eventB],
                nextCursor: cursorB,
                hasMore: false,
            });

        const result = await facade.rooms.replayEvents({
            roomId: 'room-1',
            limit: 1,
            maxPages: 2,
        });

        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls.map((call) => call[0])).toEqual([eventA, eventB]);
        expect(result).toMatchObject({
            events: [eventA, eventB],
            nextCursor: cursorB,
            hasMore: false,
            pageCount: 2,
            replayedCount: 2,
            duplicateCount: 0,
        });
        expect(mocks.listStateGroupEventPage).toHaveBeenNthCalledWith(
            1,
            'room-1',
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
            },
            expect.objectContaining({
                limit: 1,
                signal: expect.any(AbortSignal),
            }),
        );
        expect(mocks.listStateGroupEventPage).toHaveBeenNthCalledWith(
            2,
            'room-1',
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
            },
            expect.objectContaining({
                limit: 1,
                after: cursorA,
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it('uses facade defaults as the operation scope when no explicit scope is passed', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();

        facade.setDefaults({
            applicationId: 'default-app',
        });

        await facade.people.refresh();

        expect(facade.defaults()).toEqual({
            applicationId: 'default-app',
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            {},
        );
    });

    it('uses facade defaults to build RTC group refs from room id strings', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'game-app',
            workspaceId: 'arena-1',
        });

        const result = await facade.messages.rtc.send({
            roomId: 'match-1',
            typeId: 'game.input.v1',
            resourceId: 'input-1',
            payload: {
                x: 1,
            },
        });

        expect(result.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'game-app',
                workspaceId: 'arena-1',
                groupId: 'match-1',
            },
        });
        expect(result.message.targets).not.toHaveProperty('groupId');
    });

    it('uses facade room defaults for RTC and WS sends without per-call room ids', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'game-app',
            workspaceId: 'arena-1',
            room: {
                roomId: 'match-1',
            },
        });

        const rtcResult = await facade.messages.rtc.send({
            typeId: 'game.input.v1',
            resourceId: 'rtc-input-1',
            payload: {
                x: 1,
            },
        });
        const wsResult = await facade.messages.ws.send({
            typeId: 'game.event.v1',
            resourceId: 'ws-event-1',
            payload: {
                text: 'joined',
            },
        });

        expect(rtcResult.message.route).toMatchObject({
            contextId: 'match-1',
            resourceId: 'rtc-input-1',
        });
        expect(rtcResult.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'game-app',
                workspaceId: 'arena-1',
                groupId: 'match-1',
            },
        });
        expect(wsResult.message.route).toMatchObject({
            contextId: 'match-1',
            resourceId: 'ws-event-1',
        });
        expect(wsResult.message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
        });
    });

    it('uses facade operation and RTC lane defaults for connect and workflows', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const lanes = [
            {
                id: 'gameplay',
                label: 'gameplay-data',
                init: {
                    ordered: false,
                    maxRetransmits: 0,
                },
            },
        ];
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'default-app',
            rtc: {
                dataChannelLanes: lanes,
            },
            operations: {
                timeoutMs: 321,
            },
        });

        await facade.people.refresh();

        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            scope: {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            timeoutMs: 321,
            dataChannelLanes: lanes,
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            {
                command: {
                    timeoutMs: 321,
                },
            },
        );
    });

    it('starts by restoring a session, connecting, and refreshing requested state', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mockGroupSnapshot(createGroupSnapshot('match-1', ['session-1', 'peer-1'], {
            applicationId: 'default-app',
            workspaceId: 'default',
        }));
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'default-app',
            operations: {
                timeoutMs: 123,
            },
        });

        const result = await facade.start({
            refreshRooms: true,
            refreshPeople: true,
        });

        expect(result.session).toEqual(mocks.ctx.session);
        expect(result.connected).toBe(true);
        expect(result.middleware).toBe(mocks.ctx);
        expect(result.roomState?.rooms.map((room) => room.roomId)).toEqual([
            'match-1',
        ]);
        expect(result.peopleState?.clients).toEqual([]);
        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            scope: {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            timeoutMs: 123,
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            {
                command: {
                    timeoutMs: 123,
                },
            },
        );
    });

    it('does not connect on start when no session can be restored', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.readSession.mockReturnValue(undefined);
        const facade = createRallarFacade();

        const result = await facade.start();

        expect(result).toEqual({
            session: undefined,
            connected: false,
        });
        expect(mocks.initMiddleware).not.toHaveBeenCalled();
        expect(mocks.refreshStateSnapshots).not.toHaveBeenCalled();
    });

    it('groups subscriptions and cleans them up idempotently', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const first = vi.fn();
        const second = vi.fn();
        const late = vi.fn();

        const scope = facade.subscriptions();

        expect(scope.add(first)).toBe(scope);
        scope.add(undefined);
        scope.add(second);
        expect(scope.size()).toBe(2);

        scope.unsubscribe();
        scope.unsubscribe();

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(scope.size()).toBe(0);

        scope.add(late);

        expect(late).toHaveBeenCalledOnce();
        expect(scope.size()).toBe(0);
    });

    it('uses facade room and realtime defaults for realtime sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const sendResult = {
            status: 'sent',
            bufferedAmount: 0,
        };
        const gameplayChannel = {
            sendJson: vi.fn(() => sendResult),
        };
        mockGroupSnapshot(createGroupSnapshot('match-1', ['session-1', 'peer-1']));
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'gameplay',
            channel: gameplayChannel,
        });
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            room: {
                roomId: 'match-1',
            },
            realtime: {
                laneId: 'gameplay',
                openTimeoutMs: 750,
            },
        });

        const result = await facade.realtime.sendJson({
            data: {
                x: 1,
            },
        });

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'gameplay',
                expect.objectContaining({
                    timeoutMs: 750,
                }),
            );
        expect(gameplayChannel.sendJson).toHaveBeenCalledWith(
            {
                x: 1,
            },
            expect.any(Object),
        );
        expect(result).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'gameplay',
                result: sendResult,
            },
        ]);
    });

    it('uses facade RTC wait defaults when waiting for a lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable',
        });
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            rtc: {
                connectOnWait: true,
                waitTimeoutMs: 333,
            },
        });

        await facade.connect();
        const result = await facade.rtc.waitForOpen('peer-1');

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'reliable',
                expect.objectContaining({
                    timeoutMs: 333,
                }),
            );
        expect(result).toMatchObject({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable',
        });
    });

    it('sends RTC and WS payloads through a typed message channel', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'game-app',
            workspaceId: 'arena-1',
            room: {
                roomId: 'match-1',
            },
        });
        const channel = facade.messages.channel<{ text: string }>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        });

        const rtcResult = await channel.sendRtc(
            {
                text: 'rtc',
            },
            {
                resourceId: 'rtc-message-1',
            },
        );
        const wsResult = await channel.sendWs(
            {
                text: 'ws',
            },
            {
                resourceId: 'ws-message-1',
            },
        );

        expect(rtcResult.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'match-1',
            resourceId: 'rtc-message-1',
        });
        expect(rtcResult.message.payload.typeId).toBe('chat.message.v1');
        expect(JSON.parse(rtcResult.message.payload.resource)).toEqual({
            text: 'rtc',
        });
        expect(wsResult.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'match-1',
            resourceId: 'ws-message-1',
        });
        expect(wsResult.message.payload.typeId).toBe('chat.message.v1');
        expect(JSON.parse(wsResult.message.payload.resource)).toEqual({
            text: 'ws',
        });
    });

    it('falls back to WS through typed channel send when RTC has no route', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();
        const channel = facade.messages.channel<{ text: string }>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        });

        const result = await channel.send(
            {
                text: 'fallback',
            },
            {
                strategy: 'rtc-with-ws-fallback',
                roomId: 'room-1',
                resourceId: 'fallback-1',
            },
        );

        expect(result.transport).toBe('ws');
        expect(result.status).toBe('enqueued');
        expect(mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
        expect(mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .toHaveBeenCalledOnce();
    });

    it('uses WS only for typed channel send when strategy is ws', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const channel = facade.messages.channel<{ text: string }>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        });

        const result = await channel.send(
            {
                text: 'ws only',
            },
            {
                strategy: 'ws',
                scope: 'all',
                resourceId: 'ws-only-1',
            },
        );

        expect(result.transport).toBe('ws');
        expect(mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
        expect(mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .toHaveBeenCalledOnce();
    });

    it('delivers decoded payloads through typed message channel subscriptions', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();
        const channel = facade.messages.channel<{ text: string }>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        });
        const onRtc = vi.fn();
        const onWs = vi.fn();

        channel.onRtc(onRtc);
        channel.onWs(onWs);
        await facade.connect();

        const rtcCallback = mocks.ctx.middleware.rtcRxStreamer
            .onInboxMessageDo.mock.calls.find(([typeId]) =>
                typeId === 'chat.message.v1'
            )?.[1];
        const wsCallback = mocks.ctx.middleware.webSocketQueueBox
            .onAnyInboxMessageDo.mock.calls.find(([callbackId]) =>
                callbackId === 'rallar:ws:any-message'
            )?.[1];

        await rtcCallback?.onMessage?.(
            newALMulticastMessage(
                'peer-1',
                newALRoute('room.chat', 'match-1', 'rtc-message-1'),
                {
                    applicationId: 'game-app',
                    workspaceId: 'arena-1',
                    groupId: 'match-1',
                },
                'chat.message.v1',
                {
                    text: 'rtc',
                },
            ),
        );
        await wsCallback?.onMessage?.(
            newALBroadcastMessage(
                'peer-1',
                newALRoute('room.chat', 'match-1', 'ws-message-1'),
                'room',
                'chat.message.v1',
                {
                    text: 'ws',
                },
            ),
        );

        expect(onRtc).toHaveBeenCalledWith(
            {
                text: 'rtc',
            },
            expect.objectContaining({
                payload: {
                    text: 'rtc',
                },
                transport: 'rtc',
            }),
        );
        expect(onWs).toHaveBeenCalledWith(
            {
                text: 'ws',
            },
            expect.objectContaining({
                payload: {
                    text: 'ws',
                },
                transport: 'ws',
            }),
        );
    });

    it('sends and listens through a typed realtime JSON lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        type RawCallback = {
            onMessage: (data: unknown, event: MessageEvent) => Promise<void>;
        };
        const rawCallbacks = new Map<string, RawCallback>();
        const sendResult = {
            status: 'sent',
            bufferedAmount: 0,
        };
        const gameplayChannel = {
            sendJson: vi.fn(() => sendResult),
            onRawMessageDo: vi.fn((id: string, callback: RawCallback) => {
                rawCallbacks.set(id, callback);
                return gameplayChannel;
            }),
            removeOnRawMessageCallbackById: vi.fn(),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['gameplay', gameplayChannel]]),
        };
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'gameplay',
            channel: gameplayChannel,
        });
        const facade = createRallarFacade();
        const gameplay = facade.realtime.json<{ x: number }>({
            laneId: 'gameplay',
            peerIds: ['peer-1'],
            openTimeoutMs: 750,
            key: 'player-1',
            maxAgeMs: 250,
        });
        const onMessage = vi.fn();

        gameplay.on(onMessage);
        await facade.connect();
        const sendResults = await gameplay.send({
            x: 1,
        });
        await rawCallbacks.get('rallar:realtime:gameplay')?.onMessage?.(
            JSON.stringify({
                x: 2,
            }),
            {
                data: JSON.stringify({
                    x: 2,
                }),
            } as MessageEvent,
        );

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'gameplay',
                expect.objectContaining({
                    timeoutMs: 750,
                }),
            );
        expect(gameplayChannel.sendJson).toHaveBeenCalledWith(
            {
                x: 1,
            },
            expect.objectContaining({
                key: 'player-1',
                maxAgeMs: 250,
            }),
        );
        expect(sendResults).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'gameplay',
                result: sendResult,
            },
        ]);
        expect(onMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                peerId: 'peer-1',
                laneId: 'gameplay',
                data: {
                    x: 2,
                },
            }),
        );
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

    it('restarts ICE for an active RTC peer when supported', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const pc = {
            connectionState: 'connected',
            restartIce: vi.fn(),
        };
        const peer = {
            peerId: 'peer-1',
            connection: {
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
            channels: new Map(),
        };
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();
        const result = await facade.rtc.restartIce('peer-1');

        expect(pc.restartIce).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            peerId: 'peer-1',
            action: 'restart-ice',
            status: 'restarted',
        });
    });

    it('reconnects an RTC peer and waits for the requested lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime',
        });
        const facade = createRallarFacade();

        await facade.connect();
        const result = await facade.rtc.reconnectPeer('peer-1', {
            laneId: 'realtime',
            timeoutMs: 250,
        });

        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledWith('peer-1');
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 250,
                }),
            );
        expect(result).toMatchObject({
            peerId: 'peer-1',
            action: 'reconnect',
            status: 'started',
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
            readyState: 'open',
        });
        const realtimeHealth = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-realtime',
            state: 'Closed',
            readyState: 'closed',
        });
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    state: 'Open',
                    pc: {
                        connectionState: 'connected',
                    },
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
                ['realtime', { readHealth: vi.fn(() => realtimeHealth) }],
            ]),
        };
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockImplementation(
            (laneId?: string) => laneId === 'realtime' ? [] : ['peer-1'],
        );
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        expect(facade.rtc.peer('peer-1')).toMatchObject({
            hasNoReconnectableLanes: false,
            isRoutable: true,
            readyLaneIds: ['reliable'],
        });
        expect(facade.rtc.peer('peer-1', { laneId: 'realtime' })).toMatchObject({
            hasNoReconnectableLanes: false,
            isRoutable: false,
            readyLaneIds: ['reliable'],
        });
    });

    it('notifies public RTC status and lifecycle subscribers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        type RtcLifecycleCallbacks = {
            onOpen?: () => Promise<void>;
            onClose?: () => Promise<void>;
            onError?: () => Promise<void>;
        };
        const health = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-realtime',
            state: 'Open',
            readyState: 'open',
        });
        let laneCallbacks: RtcLifecycleCallbacks | undefined;
        const realtimeChannel = {
            readHealth: vi.fn(() => health),
            onRtcCallbacksDo: vi.fn((
                _id: string,
                callbacks: RtcLifecycleCallbacks,
            ) => {
                laneCallbacks = callbacks;
                return realtimeChannel;
            }),
            removeRtcCallbackById: vi.fn(() => true),
        };
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
                    reconnectAttempts: 0,
                    reconnectTimer: undefined,
                    disconnectTimer: undefined,
                    makingOffer: false,
                    ignoreOffer: false,
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                },
            },
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();
        const statuses: unknown[] = [];
        const lifecycles: unknown[] = [];

        const unsubscribeStatus = facade.rtc.onStatus(
            (status) => statuses.push(status),
            { laneId: 'realtime' },
        );
        const unsubscribeLifecycle = facade.rtc.onLifecycle(
            (event) => lifecycles.push(event),
            { laneId: 'realtime' },
        );

        expect(statuses).toEqual([
            expect.objectContaining({
                laneId: 'realtime',
                peers: [],
            }),
        ]);
        expect(lifecycles).toEqual([
            expect.objectContaining({
                kind: 'snapshot',
                status: expect.objectContaining({
                    laneId: 'realtime',
                }),
            }),
        ]);

        await facade.connect();

        expect(realtimeChannel.onRtcCallbacksDo).toHaveBeenCalledWith(
            'rallar:rtc:status',
            expect.objectContaining({
                onOpen: expect.any(Function),
                onClose: expect.any(Function),
                onError: expect.any(Function),
            }),
        );
        expect(lifecycles).toContainEqual(
            expect.objectContaining({
                kind: 'connected',
                status: expect.objectContaining({
                    readyPeerIds: ['peer-1'],
                }),
            }),
        );

        await laneCallbacks?.onOpen?.();

        expect(statuses.at(-1)).toMatchObject({
            laneId: 'realtime',
            readyPeerIds: ['peer-1'],
            peers: [
                {
                    peerId: 'peer-1',
                    readyLaneIds: ['realtime'],
                },
            ],
        });
        expect(lifecycles.at(-1)).toMatchObject({
            kind: 'lane-open',
            peerId: 'peer-1',
            laneId: 'realtime',
            peer: {
                peerId: 'peer-1',
            },
            lane: {
                laneId: 'realtime',
                isOpen: true,
            },
        });

        unsubscribeStatus();
        expect(realtimeChannel.removeRtcCallbackById).not.toHaveBeenCalled();

        unsubscribeLifecycle();
        expect(mocks.webRtcConnectionService.removeRtcPeerLifecycleById)
            .toHaveBeenCalledWith('rallar:rtc:status');
        expect(realtimeChannel.removeRtcCallbackById)
            .toHaveBeenCalledWith('rallar:rtc:status');
    });

    it('emits RTC peer lifecycle removal after service deletion completes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const realtimeChannel = {
            readHealth: vi.fn(() =>
                createChannelHealth({
                    peerId: 'peer-1',
                    label: 'rtc-realtime',
                    state: 'Open',
                    readyState: 'open',
                })
            ),
            onRtcCallbacksDo: vi.fn(() => realtimeChannel),
            removeRtcCallbackById: vi.fn(() => true),
        };
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    state: 'Open',
                    pc: {
                        connectionState: 'connected',
                    },
                    reconnectAttempts: 0,
                    reconnectTimer: undefined,
                    disconnectTimer: undefined,
                    makingOffer: false,
                    ignoreOffer: false,
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                },
            },
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();
        const lifecycles: unknown[] = [];

        facade.rtc.onLifecycle(
            (event) => lifecycles.push(event),
            {
                laneId: 'realtime',
                emitCurrent: false,
            },
        );
        await facade.connect();

        const lifecycleCallback = mocks.webRtcConnectionService
            .onRtcPeerLifecycleDo.mock.calls
            .find(([id]) => id === 'rallar:rtc:status')?.[1] as
            | { onDeleted(peer: typeof peer): void }
            | undefined;
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
                peers: [],
            },
        });
    });

    it('emits RTC peer timeout lifecycle events from the connection service', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    state: 'Connecting',
                    pc: {
                        connectionState: 'connecting',
                    },
                    reconnectAttempts: 0,
                    reconnectTimer: undefined,
                    disconnectTimer: undefined,
                    makingOffer: false,
                    ignoreOffer: false,
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                },
            },
            channels: new Map(),
        };
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();
        const lifecycles: unknown[] = [];

        facade.rtc.onLifecycle(
            (event) => lifecycles.push(event),
            {
                emitCurrent: false,
            },
        );
        await facade.connect();

        const lifecycleCallback = mocks.webRtcConnectionService
            .onRtcPeerLifecycleDo.mock.calls
            .find(([id]) => id === 'rallar:rtc:status')?.[1] as
            | {
            onConnectTimeout?(
                peer: typeof peer,
                event: unknown,
            ): void;
        }
            | undefined;
        expect(lifecycleCallback).toBeDefined();

        lifecycleCallback?.onConnectTimeout?.(
            peer,
            {
                peerId: 'peer-1',
                timeoutMs: 50,
                startedAtEpochMs: 1,
                timedOutAtEpochMs: 51,
                reason: 'peer-establishment-timeout',
            },
        );

        expect(lifecycles.at(-1)).toMatchObject({
            kind: 'peer-timeout',
            peerId: 'peer-1',
            peer: {
                peerId: 'peer-1',
                connection: {
                    connectionState: 'connecting',
                },
            },
        });
    });

    it('exposes read-only WS diagnostics after connecting', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws?ticket=secret-ticket&other=value#fragment',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 2,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
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
            reconnectExhausted: false,
        });
    });

    it('notifies public WS status and lifecycle subscribers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        type WsLifecycleCallbacks = {
            onOpen?: (event: Event) => void;
            onClose?: (event: CloseEvent) => void;
            onError?: (event: Event) => void;
        };
        let callbacks: WsLifecycleCallbacks | undefined;
        mocks.ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo
            .mockImplementation((_id: string, next: WsLifecycleCallbacks) => {
                callbacks = next;
                return mocks.ctx.middleware.webSocketQueueBox.socket;
            });
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws?ticket=secret-ticket',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
        });
        const facade = createRallarFacade();
        const statuses: unknown[] = [];
        const lifecycles: unknown[] = [];

        const unsubscribeStatus = facade.ws.onStatus(
            (status) => statuses.push(status),
        );
        const unsubscribeLifecycle = facade.ws.onLifecycle(
            (event) => lifecycles.push(event),
        );

        expect(statuses).toEqual([
            expect.objectContaining({
                readyState: 'missing',
                reconnectEnabled: false,
            }),
        ]);
        expect(lifecycles).toEqual([
            expect.objectContaining({
                kind: 'snapshot',
                status: expect.objectContaining({
                    readyState: 'missing',
                }),
            }),
        ]);

        await facade.connect();

        expect(mocks.ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo)
            .toHaveBeenCalledWith(
                'rallar:ws:status',
                expect.objectContaining({
                    onOpen: expect.any(Function),
                    onClose: expect.any(Function),
                    onError: expect.any(Function),
                }),
            );
        expect(lifecycles).toContainEqual(
            expect.objectContaining({
                kind: 'connected',
                status: expect.objectContaining({
                    url: 'ws://localhost/ws',
                    readyState: 'open',
                    reconnectEnabled: true,
                }),
            }),
        );

        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'closed',
            readyStateCode: 3,
            isOpen: false,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 1,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
        });
        callbacks?.onClose?.({
            type: 'close',
            code: 1006,
            reason: 'network-lost',
            wasClean: false,
        } as CloseEvent);

        expect(statuses.at(-1)).toMatchObject({
            readyState: 'closed',
            reconnecting: true,
            reconnectEnabled: true,
        });
        expect(lifecycles.at(-1)).toMatchObject({
            kind: 'close',
            code: 1006,
            reason: 'network-lost',
            wasClean: false,
            eventType: 'close',
            intentional: false,
            status: {
                readyState: 'closed',
            },
        });

        unsubscribeStatus();
        expect(mocks.ctx.middleware.webSocketQueueBox.socket
            .removeWebsocketCallbackById)
            .not.toHaveBeenCalled();

        unsubscribeLifecycle();
        expect(mocks.ctx.middleware.webSocketQueueBox.socket
            .removeWebsocketCallbackById)
            .toHaveBeenCalledWith('rallar:ws:status');
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
                    isOpen: false,
                },
            });
        expect(mocks.initMiddleware).not.toHaveBeenCalled();
    });

    it('returns aborted for an already-aborted WS wait', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const controller = new AbortController();
        controller.abort();

        await expect(
            createRallarFacade().ws.waitForOpen({
                signal: controller.signal,
            }),
        ).resolves.toMatchObject({
            transport: 'ws',
            status: 'aborted',
        });
        expect(mocks.initMiddleware).not.toHaveBeenCalled();
    });

    it('resolves WS wait immediately when the socket is already open', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
        });
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.ws.waitForOpen()).resolves.toMatchObject({
            transport: 'ws',
            status: 'open',
            wsStatus: {
                readyState: 'open',
                isOpen: true,
            },
        });
    });

    it('times out WS wait without calling connect again', async () => {
        vi.useFakeTimers();
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'connecting',
            readyStateCode: 0,
            isOpen: false,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 1,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
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
                reconnecting: true,
            },
        });
        expect(mocks.initMiddleware).not.toHaveBeenCalled();
    });

    it('resolves WS wait when the socket opens after waiting starts', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        type WsLifecycleCallbacks = {
            onOpen?: (event: Event) => void;
        };
        let callbacks: WsLifecycleCallbacks | undefined;
        mocks.ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo
            .mockImplementation((_id: string, next: WsLifecycleCallbacks) => {
                callbacks = next;
                return mocks.ctx.middleware.webSocketQueueBox.socket;
            });
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'connecting',
            readyStateCode: 0,
            isOpen: false,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 1,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
        });
        const facade = createRallarFacade();

        await facade.connect();
        const wait = facade.ws.waitForOpen({ timeoutMs: 1_000 });
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'open',
            readyStateCode: 1,
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
        });
        callbacks?.onOpen?.({ type: 'open' } as Event);

        await expect(wait).resolves.toMatchObject({
            transport: 'ws',
            status: 'open',
            wsStatus: {
                readyState: 'open',
                isOpen: true,
            },
        });
    });

    it('returns closed for terminal closed WS status', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'closed',
            readyStateCode: 3,
            isOpen: false,
            reconnecting: false,
            reconnectEnabled: false,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
        });
        const facade = createRallarFacade();

        await facade.connect();

        await expect(facade.ws.waitForOpen()).resolves.toMatchObject({
            transport: 'ws',
            status: 'closed',
            wsStatus: {
                readyState: 'closed',
                reconnecting: false,
                reconnectEnabled: false,
            },
        });
    });

    it('returns aborted when WS wait is aborted while pending', async () => {
        vi.useFakeTimers();
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: 'session-1',
            url: 'ws://localhost/ws',
            readyState: 'connecting',
            readyStateCode: 0,
            isOpen: false,
            reconnecting: true,
            reconnectEnabled: true,
            reconnectAttempts: 1,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
        });
        const facade = createRallarFacade();
        const controller = new AbortController();

        await facade.connect();
        const wait = facade.ws.waitForOpen({
            signal: controller.signal,
            timeoutMs: 1_000,
        });
        controller.abort();
        await vi.runOnlyPendingTimersAsync();

        await expect(wait).resolves.toMatchObject({
            transport: 'ws',
            status: 'aborted',
        });
    });

    it('passes signal and timeout options into connect and room refresh workflows', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;
        const scope = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        };

        await createRallarFacade().rooms.refresh({
            scope,
            signal,
            timeoutMs: 123,
        });

        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            scope,
            signal,
            timeoutMs: 123,
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(scope, {
            command: {
                signal,
                timeoutMs: 123,
            },
        });
    });

    it('passes retry options and retry classification into room workflows', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const snapshot = createGroupSnapshot('room-1', ['session-1']);
        mocks.joinStateGroup.mockResolvedValue(snapshot);

        await createRallarFacade().rooms.join('room-1', {
            maxAttempts: 3,
        });

        const policies = mocks.joinStateGroup.mock.calls[0]?.[4] as {
            command?: {
                maxAttempts?: number;
                shouldRetry?: (error: unknown, attempt: number) => boolean;
            };
        };
        expect(policies.command?.maxAttempts).toBe(3);
        expect(
            policies.command?.shouldRetry?.(
                Object.assign(new Error('server busy'), { status: 503 }),
                1,
            ),
        ).toBe(true);
        expect(
            policies.command?.shouldRetry?.(
                Object.assign(new Error('rate limited'), { status: 429 }),
                1,
            ),
        ).toBe(true);
        expect(
            policies.command?.shouldRetry?.(
                Object.assign(new Error('bad request'), { status: 400 }),
                1,
            ),
        ).toBe(false);
        expect(
            policies.command?.shouldRetry?.(
                Object.assign(new Error('conflict'), { status: 409 }),
                1,
            ),
        ).toBe(false);
    });

    it('uses default retry attempts for room workflows', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const snapshot = createGroupSnapshot('room-1', ['session-1']);
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            operations: {
                maxAttempts: 4,
            },
        });
        mocks.joinStateGroup.mockResolvedValue(snapshot);

        await facade.rooms.join('room-1');

        const policies = mocks.joinStateGroup.mock.calls[0]?.[4] as {
            command?: {
                maxAttempts?: number;
            };
        };
        expect(policies.command?.maxAttempts).toBe(4);
    });

    it('hydrates state caches from room mutation responses without waiting for WS echo', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const snapshot = createGroupSnapshot('created-room', ['session-1']);
        mocks.createAndJoinStateGroup.mockResolvedValue(snapshot);

        await createRallarFacade().rooms.create('Created Room');

        expect(mocks.hydrateStateCaches).toHaveBeenCalledWith(
            mocks.ctx.middleware.webRtcGroupManager,
            expect.objectContaining({
                clientId: 'principal-1',
                sessionId: 'session-1',
            }),
            [],
            [snapshot],
            expect.any(Object),
        );
    });

    it('passes custom data-channel lanes into middleware connect', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const lanes = [
            {
                id: 'realtime',
                label: 'custom-realtime',
                init: {
                    ordered: false,
                    maxRetransmits: 0,
                },
                binaryType: 'arraybuffer' as const,
                flowControl: {
                    highWatermarkBytes: 4096,
                    lowWatermarkBytes: 1024,
                    overflow: 'drop-old' as const,
                    maxQueueItems: 4,
                },
            },
        ];

        await createRallarFacade().connect({
            dataChannelLanes: lanes,
        });

        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            dataChannelLanes: lanes,
        });
    });

    it('disconnects stale middleware before connecting with a replaced auth session', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const nextSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2',
        };
        const nextCtx = {
            ...mocks.ctx,
            session: nextSession,
        } as ApiMiddleware;
        const facade = createRallarFacade();

        await facade.connect();
        mocks.readSession.mockReturnValue(nextSession);
        mocks.initMiddleware.mockResolvedValue(nextCtx);

        await facade.connect();

        expect(mocks.clearMiddleware).toHaveBeenCalledOnce();
        expect(mocks.initMiddleware).toHaveBeenCalledTimes(2);
    });

    it('keeps the legacy scope shorthand for refresh operations', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const scope = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        };

        await createRallarFacade().people.refresh(scope);

        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(scope, {});
    });

    it('passes signal and timeout options into auth login', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;

        await createRallarFacade().auth.login(
            {
                username: 'principal-1',
                password: 'password-1',
            },
            {
                signal,
                timeoutMs: 123,
            },
        );

        expect(mocks.loginToApi.mock.calls[0]?.[0]).toEqual({
            username: 'principal-1',
            password: 'password-1',
        });
        const loginOptions = mocks.loginToApi.mock.calls[0]?.[1] as
            | { signal?: AbortSignal }
            | undefined;
        expect(loginOptions?.signal).toBeInstanceOf(AbortSignal);
    });

    it('emits the current auth state to auth change subscribers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const listener = vi.fn();

        const unsubscribe = createRallarFacade().auth.onChange(listener);

        expect(listener).toHaveBeenCalledWith({
            authenticated: true,
            reason: 'current',
            session: mocks.ctx.session,
        });

        unsubscribe();
    });

    it('locally logs out and tears down active transports when the session expires', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const expiringSession = {
            ...mocks.ctx.session,
            expiresAtEpochMs: 1_500,
        };
        mocks.initMiddleware.mockResolvedValue({
            ...mocks.ctx,
            session: expiringSession,
        } as ApiMiddleware);
        mocks.readSession.mockImplementation(() =>
            Date.now() >= expiringSession.expiresAtEpochMs
                ? undefined
                : expiringSession
        );
        const facade = createRallarFacade();
        const authListener = vi.fn();
        facade.auth.onChange(authListener, { emitCurrent: false });

        await facade.connect();
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(mocks.ctx.middleware.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.ctx.middleware.heartbeat.stop).toHaveBeenCalledOnce();
        expect(mocks.ctx.middleware.rtcRxStreamer.stopAllHeartbeats)
            .toHaveBeenCalledOnce();
        expect(mocks.logoutFromApi).not.toHaveBeenCalled();
        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(authListener).toHaveBeenCalledWith({
            authenticated: false,
            reason: 'expired',
            session: undefined,
        });
        expect(facade.isConnected()).toBe(false);
    });

    it('does not expire a replacement session when an old expiry timer fires', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const oldSession = {
            ...mocks.ctx.session,
            expiresAtEpochMs: 1_500,
        };
        const nextSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2',
            expiresAtEpochMs: 10_000,
        };
        let currentSession = oldSession;
        mocks.initMiddleware.mockResolvedValue({
            ...mocks.ctx,
            session: oldSession,
        } as ApiMiddleware);
        mocks.readSession.mockImplementation(() => currentSession);
        const facade = createRallarFacade();

        await facade.connect();
        currentSession = nextSession;
        mocks.clearSession.mockClear();
        mocks.ctx.middleware.webSocketQueueBox.close.mockClear();
        await vi.advanceTimersByTimeAsync(500);

        expect(mocks.clearSession).not.toHaveBeenCalled();
        expect(mocks.ctx.middleware.webSocketQueueBox.close).not.toHaveBeenCalled();
    });

    it('locally logs out on API 401 without calling the logout endpoint', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const authListener = vi.fn();
        facade.auth.onChange(authListener, { emitCurrent: false });
        await facade.connect();
        mocks.refreshStateSnapshots.mockRejectedValue(
            Object.assign(new Error('Unauthorized'), { status: 401 }),
        );

        await expect(facade.rooms.refresh()).rejects.toThrow('Unauthorized');

        expect(mocks.ctx.middleware.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.logoutFromApi).not.toHaveBeenCalled();
        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(authListener).toHaveBeenCalledWith({
            authenticated: false,
            reason: 'unauthorized',
            session: undefined,
        });
    });

    it('emits unauthorized auth state once when nested room operations see the same 401', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const authListener = vi.fn();
        const oldRoom = createGroupSnapshot('old-room', ['session-1']);
        const newRoom = createGroupSnapshot('new-room', ['session-1']);

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        mocks.joinStateGroup.mockResolvedValueOnce(oldRoom);
        await facade.rooms.join('old-room');
        mockGroupSnapshot(oldRoom);

        facade.auth.onChange(authListener, { emitCurrent: false });
        mocks.joinStateGroup.mockResolvedValueOnce(newRoom);
        mocks.leaveStateGroup.mockRejectedValueOnce(
            Object.assign(new Error('Unauthorized'), { status: 401 }),
        );

        await expect(facade.rooms.join('new-room')).rejects.toThrow('Unauthorized');

        expect(authListener).toHaveBeenCalledTimes(1);
        expect(authListener).toHaveBeenCalledWith({
            authenticated: false,
            reason: 'unauthorized',
            session: undefined,
        });
        expect(mocks.clearSession).toHaveBeenCalledOnce();
    });

    it('does not locally log out on API 403 authorization errors', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        await facade.connect();
        mocks.ctx.middleware.webSocketQueueBox.close.mockClear();
        mocks.refreshStateSnapshots.mockRejectedValue(
            Object.assign(new Error('Forbidden'), { status: 403 }),
        );

        await expect(facade.rooms.refresh()).rejects.toThrow('Forbidden');

        expect(mocks.ctx.middleware.webSocketQueueBox.close).not.toHaveBeenCalled();
        expect(mocks.logoutFromApi).not.toHaveBeenCalled();
        expect(mocks.clearSession).not.toHaveBeenCalled();
    });

    it('passes an explicit admin session into auth registration', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;
        const adminSession = {
            ...mocks.ctx.session,
            clientId: 'admin',
            accessToken: 'admin-token',
            username: 'admin',
        };

        await createRallarFacade().auth.register(
            {
                username: 'new-user',
                password: 'password-1',
                displayName: 'New User',
            },
            {
                adminSession,
                signal,
                timeoutMs: 123,
            },
        );

        expect(mocks.registerWithApi.mock.calls[0]?.[0]).toEqual({
            username: 'new-user',
            password: 'password-1',
            displayName: 'New User',
        });
        const registerOptions = mocks.registerWithApi.mock.calls[0]?.[1] as
            | { signal?: AbortSignal; authSession?: unknown }
            | undefined;
        expect(registerOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(registerOptions?.authSession).toBe(adminSession);
    });

    it('can register and then log in with the new user', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );

        await createRallarFacade().auth.registerAndLogin({
            username: 'new-user',
            password: 'password-1',
        });

        expect(mocks.registerWithApi).toHaveBeenCalledOnce();
        expect(mocks.loginToApi).toHaveBeenCalledWith(
            {
                username: 'new-user',
                password: 'password-1',
            },
            expect.any(Object),
        );
        expect(mocks.writeSession).toHaveBeenCalledWith(mocks.ctx.session);
    });

    it('revokes the backend session when logging out', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;

        await createRallarFacade().auth.logout({ signal, timeoutMs: 123 });

        expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        const logoutOptions = mocks.logoutFromApi.mock.calls[0]?.[0] as
            | { signal?: AbortSignal }
            | undefined;
        expect(logoutOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(mocks.clearSession).toHaveBeenCalledOnce();
    });

    it('clears local auth before revoking manual logout and uses the captured session', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );

        await createRallarFacade().auth.logout();

        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        expect(mocks.clearSession.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.logoutFromApi.mock.invocationCallOrder[0]);
        expect(mocks.logoutFromApi.mock.calls[0]?.[0]).toMatchObject({
            authSession: mocks.ctx.session,
        });
    });

    it('does not reconnect with a stale session while manual logout is in progress', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        let releaseLogout: (() => void) | undefined;
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementation(
            () =>
                new Promise((resolve) => {
                    releaseLogout = () => resolve({ loggedOut: true });
                }),
        );
        const facade = createRallarFacade();

        await facade.connect();
        const logoutPromise = facade.auth.logout();
        await vi.waitFor(() => {
            expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        });

        const startPromise = facade.start();
        await Promise.resolve();
        expect(mocks.initMiddleware).toHaveBeenCalledTimes(1);
        releaseLogout?.();
        const startResult = await startPromise;
        await logoutPromise;

        expect(startResult).toEqual({
            session: undefined,
            connected: false,
        });
    });

    it('closes WS through the queue-box service when logging out after connect', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();

        await facade.connect();
        await facade.auth.logout();

        expect(mocks.ctx.middleware.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.ctx.middleware.heartbeat.stop).toHaveBeenCalledOnce();
        expect(mocks.ctx.middleware.rtcRxStreamer.stopAllHeartbeats)
            .toHaveBeenCalledOnce();
        expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        expect(mocks.clearSession).toHaveBeenCalledOnce();
    });

    it('disconnects every known RTC peer, including stale lane peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([
            'peer-ready',
            'peer-stale',
        ]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([
            'peer-ready',
            'peer-stale',
        ]);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue(['peer-ready']);
        mocks.webRtcConnectionService.readyPeerIdsForLane
            .mockReturnValue(['peer-ready']);
        const facade = createRallarFacade();
        const wsLifecycle: unknown[] = [];
        facade.ws.onLifecycle(
            (event) => wsLifecycle.push(event),
            {
                emitCurrent: false,
            },
        );

        await facade.connect();
        await facade.disconnect();

        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledWith('peer-ready');
        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledWith('peer-stale');
        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledTimes(2);
        expect(mocks.ctx.middleware.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.ctx.middleware.webSocketQueueBox.socket.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.clearMiddleware).toHaveBeenCalledOnce();
        expect(wsLifecycle.at(-1)).toMatchObject({
            kind: 'disconnected',
            code: 1000,
            reason: 'rallar-disconnect',
            intentional: true,
            status: {
                connectState: 'idle',
                readyState: 'missing',
                reconnectEnabled: false,
            },
        });
    });

    it('applies timeout options when waiting on an in-flight connect', async () => {
        vi.useFakeTimers();
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const deferred = createDeferred<ApiMiddleware>();
        mocks.initMiddleware.mockReturnValueOnce(deferred.promise);
        const facade = createRallarFacade();

        const primaryConnect = facade.connect();
        const timedConnect = facade.connect({ timeoutMs: 10 });
        const expectation = expect(timedConnect).rejects.toThrow(
            'Command timed out after 10 ms',
        );

        await vi.advanceTimersByTimeAsync(10);
        await expectation;

        deferred.resolve(mocks.ctx);
        await primaryConnect;
    });

    it('does not leave the current room when joining the next room fails', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.groupRepositoryMissing.mockImplementation((value?: unknown) => {
            if (value === 'session-1') {
                return 'old-room';
            }

            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        });
        mocks.joinStateGroup.mockRejectedValueOnce(new Error('join failed'));

        await expect(createRallarFacade().rooms.join('new-room')).rejects.toThrow(
            'join failed',
        );

        expect(mocks.leaveStateGroup).not.toHaveBeenCalled();
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
                    readyState,
                })
            ),
            waitUntilOpen: vi.fn(async () => {
                readyState = 'open';
                state = 'Open';
                return true;
            }),
        };
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                    makingOffer: false,
                    ignoreOffer: false,
                },
            },
            channels: new Map([['reliable', channel]]),
        };
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
                    isOpen: true,
                },
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
                laneId: 'reliable',
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
                    connect: true,
                },
            ),
        ).resolves.toMatchObject({
            transport: 'rtc',
            status: 'aborted',
            peerId: 'peer-1',
            laneId: 'realtime',
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
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                    makingOffer: false,
                    ignoreOffer: false,
                },
            },
            channels: new Map(),
        };
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
                laneId: 'realtime',
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
                    readyState: 'closed',
                })
            ),
            waitUntilOpen: vi.fn(),
        };
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                    makingOffer: false,
                    ignoreOffer: false,
                },
            },
            channels: new Map([['realtime', channel]]),
        };
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
                    isReconnectable: true,
                },
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
                    readyState: 'connecting',
                })
            ),
            waitUntilOpen: vi.fn(() => deferred.promise),
        };
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                    makingOffer: false,
                    ignoreOffer: false,
                },
            },
            channels: new Map([['realtime', channel]]),
        };
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
                timeoutMs: 1_000,
            },
        );
        controller.abort();

        await expect(wait).resolves.toMatchObject({
            transport: 'rtc',
            status: 'aborted',
            peerId: 'peer-1',
            laneId: 'realtime',
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
                    timeoutMs: 25,
                },
            ),
        ).resolves.toMatchObject({
            transport: 'rtc',
            status: 'failed',
            peerId: 'peer-1',
            laneId: 'realtime',
            reason: 'signaling failed',
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 25,
                }),
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
                    readyState: 'open',
                })
            ),
        };
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                    makingOffer: false,
                    ignoreOffer: false,
                },
            },
            channels: new Map([['realtime', channel]]),
        };
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime',
            peer,
            channel,
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
                    timeoutMs: 50,
                },
            ),
        ).resolves.toMatchObject({
            transport: 'rtc',
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime',
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 50,
                }),
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
                'peer-slow',
            ]),
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId: string, laneId: string) => {
                if (peerId === 'peer-ready') {
                    return {
                        status: 'open',
                        peerId,
                        laneId,
                    };
                }

                return {
                    status: 'timeout',
                    peerId,
                    laneId,
                    error: new Error('lane did not open'),
                };
            },
        );
        const facade = createRallarFacade();

        await facade.connect();

        const result = await facade.rtc.waitForRoomLane(
            'room-1',
            'realtime',
            {
                connect: true,
                timeoutMs: 1_000,
            },
        );

        expect(result).toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'partial',
            ready: [
                {
                    peerId: 'peer-ready',
                    laneId: 'realtime',
                    status: 'open',
                },
            ],
            notReady: [
                {
                    peerId: 'peer-slow',
                    laneId: 'realtime',
                    status: 'timeout',
                },
            ],
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledTimes(2);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenNthCalledWith(
                1,
                'peer-ready',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 1_000,
                }),
            );
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenNthCalledWith(
                2,
                'peer-slow',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 1_000,
                }),
            );
    });

    it('reports room RTC transport status without opening lanes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mockGroupSnapshot(
            createGroupSnapshot('room-1', [
                'session-1',
                'peer-ready',
                'peer-slow',
            ]),
        );
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([
            'peer-ready',
            'peer-slow',
        ]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([
            'peer-ready',
            'peer-slow',
        ]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-ready',
        ]);

        const facade = createRallarFacade();
        await facade.connect();

        const status = facade.rtc.roomStatus('room-1', {
            laneId: 'realtime',
            minReadyPeers: 1,
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
                laneId: 'realtime',
            },
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
                'peer-slow',
            ]),
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId: string, laneId: string) => ({
                status: peerId === 'peer-ready' ? 'open' : 'timeout',
                peerId,
                laneId,
                error: peerId === 'peer-ready' ? undefined : new Error('timeout'),
            }),
        );
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-ready',
        ]);

        const facade = createRallarFacade();
        await facade.connect();

        const result = await facade.rtc.openRoom('room-1', {
            mode: 'warm',
            laneId: 'realtime',
            timeoutMs: 250,
            minReadyPeers: 1,
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
            laneId: 'realtime',
        });
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);

        const facade = createRallarFacade();
        await facade.connect();

        const result = await facade.rtc.waitForRoom('room-1', {
            laneId: 'realtime',
            timeoutMs: 250,
        });

        expect(result.rtc.state).toBe('open');
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 250,
                }),
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
                    timeoutMs: 1_000,
                },
            ),
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'empty',
            ready: [],
            notReady: [],
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
                'peer-b',
            ]),
        );
        const facade = createRallarFacade();

        await expect(
            facade.rtc.waitForRoomLane(
                'room-1',
                'realtime',
                {
                    connect: true,
                    timeoutMs: 1_000,
                },
            ),
        ).resolves.toMatchObject({
            transport: 'rtc',
            roomId: 'room-1',
            laneId: 'realtime',
            status: 'not-connected',
            ready: [],
            notReady: [
                {
                    peerId: 'peer-a',
                    status: 'not-connected',
                },
                {
                    peerId: 'peer-b',
                    status: 'not-connected',
                },
            ],
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .not.toHaveBeenCalled();
    });

    it('sends realtime JSON over the requested peer lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const sendResult = {
            status: 'sent',
            bufferedAmount: 0,
        };
        const realtimeChannel = {
            sendJson: vi.fn(() => sendResult),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime',
            peer,
            channel: realtimeChannel,
        });

        const result = await createRallarFacade().realtime.sendJson({
            peerIds: ['peer-1'],
            data: {
                x: 1,
            },
            key: 'player-1',
        });

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 5_000,
                }),
            );
        expect(realtimeChannel.sendJson).toHaveBeenCalledWith(
            {
                x: 1,
            },
            expect.objectContaining({
                key: 'player-1',
            }),
        );
        expect(result).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'realtime',
                result: sendResult,
            },
        ]);
    });

    it('does not send realtime JSON before the requested lane opens', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const realtimeChannel = {
            sendJson: vi.fn(),
        };
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'timeout',
            peerId: 'peer-1',
            laneId: 'realtime',
            channel: realtimeChannel,
            error: new Error('lane did not open'),
        });

        await expect(
            createRallarFacade().realtime.sendJson({
                peerIds: ['peer-1'],
                data: {
                    x: 1,
                },
                openTimeoutMs: 25,
            }),
        ).resolves.toEqual([
            {
                peerId: 'peer-1',
                laneId: 'realtime',
                result: {
                    status: 'closed',
                    reason: 'Realtime lane not connected',
                    bufferedAmount: 0,
                },
            },
        ]);

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 25,
                }),
            );
        expect(realtimeChannel.sendJson).not.toHaveBeenCalled();
    });

    it('sends realtime binary over the requested peer lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const bytes = new Uint8Array([1, 2, 3]);
        const sendResult = {
            status: 'sent',
            bufferedAmount: 0,
        };
        const realtimeChannel = {
            sendBinary: vi.fn(() => sendResult),
        };
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'realtime',
            channel: realtimeChannel,
        });

        const result = await createRallarFacade().realtime.sendBinary({
            peerIds: ['peer-1'],
            data: bytes,
            openTimeoutMs: 75,
        });

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 75,
                }),
            );
        expect(realtimeChannel.sendBinary).toHaveBeenCalledWith(
            bytes,
            expect.objectContaining({}),
        );
        expect(result).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'realtime',
                result: sendResult,
            },
        ]);
    });

    it('returns a closed realtime send result when the peer has no requested lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValueOnce({
            status: 'no-lane',
            peerId: 'peer-1',
            laneId: 'missing',
            error: new Error('missing lane'),
        });

        await expect(
            createRallarFacade().realtime.sendJson({
                peerIds: ['peer-1'],
                laneId: 'missing',
                data: {
                    x: 1,
                },
            }),
        ).resolves.toEqual([
            {
                peerId: 'peer-1',
                laneId: 'missing',
                result: {
                    status: 'closed',
                    reason: 'Realtime lane not connected',
                    bufferedAmount: 0,
                },
            },
        ]);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'missing',
                expect.objectContaining({
                    timeoutMs: 5_000,
                }),
            );
    });

    it('sends targeted channel JSON to explicit one-to-many peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const sent = {
            status: 'sent',
            bufferedAmount: 0,
        };
        const realtimeChannel = {
            sendJson: vi.fn(() => sent),
        };
        mocks.webRtcConnectionService.ensurePeerLaneOpen
            .mockResolvedValueOnce({
                status: 'open',
                peerId: 'peer-a',
                laneId: 'realtime',
                channel: realtimeChannel,
            })
            .mockResolvedValueOnce({
                status: 'timeout',
                peerId: 'peer-b',
                laneId: 'realtime',
                error: new Error('slow peer'),
            });

        const channel = createRallarFacade().channels.targeted<{ x: number }>({
            peerIds: ['session-1', 'peer-a', 'peer-b', 'peer-a'],
            laneId: 'realtime',
            openTimeoutMs: 25,
        });
        const result = await channel.send({
            x: 1,
        });

        expect(result).toMatchObject({
            transport: 'rtc',
            status: 'partial',
            laneId: 'realtime',
            peerIds: ['peer-a', 'peer-b'],
            results: [
                {
                    peerId: 'peer-a',
                    result: sent,
                },
                {
                    peerId: 'peer-b',
                    result: {
                        status: 'closed',
                        reason: 'Realtime lane not connected',
                    },
                },
            ],
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenNthCalledWith(
                1,
                'peer-a',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 25,
                }),
            );
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenNthCalledWith(
                2,
                'peer-b',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 25,
                }),
            );
        expect(realtimeChannel.sendJson).toHaveBeenCalledWith(
            {
                x: 1,
            },
            expect.objectContaining({}),
        );
    });

    it('re-resolves live room targeted channel membership on each send', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const sent = {
            status: 'sent',
            bufferedAmount: 0,
        };
        const realtimeChannel = {
            sendJson: vi.fn(() => sent),
        };
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId: string, laneId: string) => ({
                status: 'open',
                peerId,
                laneId,
                channel: realtimeChannel,
            }),
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-a']));
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        const channel = facade.channels.room<{ x: number }>({
            roomId: 'room-1',
            laneId: 'realtime',
        });

        const first = await channel.send({
            x: 1,
        });
        mockGroupSnapshot(
            createGroupSnapshot('room-1', ['session-1', 'peer-a', 'peer-b']),
        );
        const second = await channel.send({
            x: 2,
        });

        expect(first.peerIds).toEqual(['peer-a']);
        expect(second.peerIds).toEqual(['peer-a', 'peer-b']);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-b',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 5_000,
                }),
            );
    });

    it('appoints the current SPA session as room director', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const snapshot = createDirectorGroupSnapshot();
        mockGroupSnapshot(snapshot);
        mocks.updateStateGroupMetadata.mockImplementation(
            async (_roomId: string, patch: Record<string, unknown>) => {
                const updated = {
                    ...snapshot,
                    group: {
                        ...snapshot.group,
                        metadata: {
                            ...snapshot.group.metadata,
                            ...patch,
                        },
                    },
                };
                mockGroupSnapshot(updated);
                return updated;
            },
        );

        const status = await createRallarFacade().director.appoint('room-1', {
            heartbeatTtlMs: 1_000,
        });

        expect(mocks.updateStateGroupMetadata).toHaveBeenCalledWith(
            'room-1',
            expect.objectContaining({
                rallarDirector: expect.objectContaining({
                    mode: 'appointed-spa',
                    sessionId: 'session-1',
                    principalId: 'principal-1',
                    epoch: 1,
                    heartbeatTtlMs: 1_000,
                }),
            }),
            'principal-1',
            'session-1',
            expect.objectContaining({
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
            }),
            expect.any(Object),
        );
        expect(status).toMatchObject({
            role: 'director',
            state: 'fresh',
            isDirector: true,
            isFresh: true,
            active: true,
        });
    });

    it('sends director intents with WS unicast fallback when RTC is not ready', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'director-session',
            principalId: 'director-principal',
            epoch: 2,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 5_000,
        }));
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'timeout',
            peerId: 'director-session',
            laneId: 'director',
            error: new Error('not ready'),
        });
        const facade = createRallarFacade();
        const relay = facade.director.createRelay<{ move: string }, { ok: true }>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
        });

        const result = await relay.sendIntent({ move: 'left' });
        relay.stop();

        expect(result.status).toBe('sent');
        expect(result.rtc).toMatchObject({
            status: 'failed',
            peerIds: ['director-session'],
        });
        expect(mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .toHaveBeenCalledWith(
                expect.objectContaining({
                    targets: {
                        mode: 'unicast',
                        toPeerId: 'director-session',
                    },
                    payload: expect.objectContaining({
                        typeId: 'game.intent',
                        resource: expect.stringContaining('"move":"left"'),
                    }),
                }),
            );
    });

    it('blocks director intents when the appointment is stale', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'director-session',
            principalId: 'director-principal',
            epoch: 2,
            appointedAtEpochMs: 1,
            heartbeatTtlMs: 5,
        }));
        const relay = createRallarFacade().director.createRelay<{ move: string }, { ok: true }>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
        });

        const result = await relay.sendIntent({ move: 'left' });
        relay.stop();

        expect(result).toMatchObject({
            status: 'stale-director',
        });
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen).not.toHaveBeenCalled();
    });

    it('starts a targeted data call and reports per-participant readiness', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const reliableHealth = createChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-data-channel',
            state: 'Open',
            readyState: 'open',
        });
        const reliableChannel = {
            readHealth: vi.fn(() => reliableHealth),
            sendJson: vi.fn(() => ({
                status: 'sent',
                bufferedAmount: 0,
            })),
        };
        const peer = {
            peerId: 'peer-1',
            connection: {
                status: {
                    state: 'Open',
                    pc: {
                        connectionState: 'connected',
                    },
                    reconnectAttempts: 0,
                    reconnectTimer: undefined,
                    disconnectTimer: undefined,
                    makingOffer: false,
                    ignoreOffer: false,
                    iceCandidateQueue: [],
                    remoteStreams: new Map(),
                },
            },
            channels: new Map([['reliable', reliableChannel]]),
        };
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable',
            peer,
            channel: reliableChannel,
        });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-1',
        ]);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);

        const call = await createRallarFacade().calls.start({
            peerId: 'peer-1',
            data: {
                lanes: ['reliable'],
                openTimeoutMs: 250,
            },
        });
        const status = call.status();
        const callChannel = call.channel<{ text: string }>();
        const sendResult = await callChannel.send({
            text: 'hello',
        });

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'reliable',
                expect.objectContaining({
                    timeoutMs: 250,
                }),
            );
        expect(status).toMatchObject({
            state: 'open',
            peerIds: ['peer-1'],
            laneIds: ['reliable'],
            participants: [
                {
                    peerId: 'peer-1',
                    state: 'open',
                    readyLaneIds: ['reliable'],
                },
            ],
        });
        expect(sendResult).toMatchObject({
            status: 'sent',
            peerIds: ['peer-1'],
            laneId: 'reliable',
        });
    });

    it('sends call invitations as WS unicast signals to target peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();

        const result = await facade.calls.invite({
            peerIds: ['session-1', 'peer-a', 'peer-b', 'peer-a'],
            data: {
                lanes: ['reliable', 'control'],
            },
            media: {
                audio: true,
                video: false,
            },
            message: 'join?',
        });

        expect(result.peerIds).toEqual(['peer-a', 'peer-b']);
        expect(result.signals.map((signal) => signal.peerId)).toEqual([
            'peer-a',
            'peer-b',
        ]);
        expect(mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .toHaveBeenCalledTimes(2);

        const firstMessage = mocks.ctx.middleware.webSocketQueueBox
            .enqueueOutboxIfAbsent.mock.calls[0]?.[0];
        expect(firstMessage).toMatchObject({
            route: {
                topicId: 'app.rallar.calls',
                contextId: result.callId,
            },
            targets: {
                mode: 'unicast',
                toPeerId: 'peer-a',
            },
            payload: {
                typeId: 'app.rallar.calls.invite.v1',
            },
        });
        expect(JSON.parse(firstMessage.payload.resource)).toMatchObject({
            kind: 'invite',
            callId: result.callId,
            fromPeerId: 'session-1',
            toPeerIds: ['peer-a', 'peer-b'],
            data: {
                laneIds: ['reliable', 'control'],
            },
            media: {
                audio: true,
                video: false,
            },
            message: 'join?',
        });
    });

    it('accepts and declines incoming call invites through call signal helpers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-caller',
            laneId: 'reliable',
        });
        const facade = createRallarFacade();
        const invites: unknown[] = [];
        const signals: unknown[] = [];

        facade.calls.onInvite((invite) => invites.push(invite));
        facade.calls.onSignal((signal) => signals.push(signal));
        await facade.connect();

        const incoming = newALUnicastMessage(
            'peer-caller',
            newALRoute('app.rallar.calls', 'call-1', 'invite-1'),
            'session-1',
            'app.rallar.calls.invite.v1',
            {
                kind: 'invite',
                callId: 'call-1',
                fromPeerId: 'peer-caller',
                toPeerIds: ['session-1'],
                data: {
                    laneIds: ['reliable'],
                },
                media: {
                    audio: true,
                },
                message: 'voice?',
                occurredAtEpochMs: 1,
            },
        );

        await findLatestWsAnyMessageCallback()?.onMessage?.(incoming);

        expect(invites).toHaveLength(1);
        expect(signals).toHaveLength(1);
        expect(invites[0]).toMatchObject({
            kind: 'invite',
            callId: 'call-1',
            fromPeerId: 'peer-caller',
            dataLaneIds: ['reliable'],
            media: {
                audio: true,
            },
            message: 'voice?',
        });

        const invite = invites[0] as {
            accept(): Promise<{ id: string }>;
            decline(reason?: string): Promise<readonly unknown[]>;
        };
        const call = await invite.accept();
        const declined = await invite.decline('busy');

        expect(call.id).toBe('call-1');
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-caller',
                'reliable',
                expect.objectContaining({}),
            );
        expect(declined).toHaveLength(1);

        const sentSignals = mocks.ctx.middleware.webSocketQueueBox
            .enqueueOutboxIfAbsent.mock.calls
            .map((callArgs) => callArgs[0]);
        expect(sentSignals.map((message) => message.payload.typeId)).toEqual([
            'app.rallar.calls.accept.v1',
            'app.rallar.calls.decline.v1',
        ]);
        expect(sentSignals.map((message) => message.targets)).toEqual([
            {
                mode: 'unicast',
                toPeerId: 'peer-caller',
            },
            {
                mode: 'unicast',
                toPeerId: 'peer-caller',
            },
        ]);
        expect(JSON.parse(sentSignals[1].payload.resource)).toMatchObject({
            kind: 'declined',
            reason: 'busy',
            callId: 'call-1',
            fromPeerId: 'session-1',
            toPeerIds: ['peer-caller'],
        });
    });

    it('starts a media-only call without opening data lanes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const stream = {
            id: 'local-stream-1',
        } as MediaStream;

        const call = await createRallarFacade().calls.start({
            peerIds: ['peer-1'],
            media: {
                stream,
                audio: true,
                video: false,
            },
        });
        const ended = await call.end();

        expect(mocks.ctx.middleware.rtcRxStreamer.setLocalMediaStream)
            .toHaveBeenCalledWith(stream);
        expect(mocks.ctx.middleware.rtcRxStreamer.setLocalAudioEnabled)
            .toHaveBeenCalledWith(true);
        expect(mocks.ctx.middleware.rtcRxStreamer.setLocalVideoEnabled)
            .toHaveBeenCalledWith(false);
        expect(mocks.webRtcConnectionService.ensurePeerConnectionStarted)
            .toHaveBeenCalledWith('peer-1');
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .not.toHaveBeenCalled();
        expect(mocks.ctx.middleware.rtcRxStreamer.stopLocalMedia)
            .toHaveBeenCalledWith('all');
        expect(ended).toMatchObject({
            state: 'ended',
            media: {
                audioEnabled: false,
                videoEnabled: false,
            },
        });
    });

    it('starts microphone and camera sources separately and attaches a composed stream', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const audioTrack = createMediaTrack('audio-track-1', 'audio');
        const videoTrack = createMediaTrack('video-track-1', 'video');
        const microphoneStream = createMediaStream('microphone-stream', [
            audioTrack,
        ]);
        const cameraStream = createMediaStream('camera-stream', [videoTrack]);
        const facade = createRallarFacade();

        const microphone = await facade.media.microphone.start({
            stream: microphoneStream,
        });
        const camera = await facade.media.camera.start({
            stream: cameraStream,
        });
        const cameraDisabled = await camera.setEnabled(false);
        const lastAttachedStream = mocks.ctx.middleware.rtcRxStreamer
            .setLocalMediaStream.mock.calls.at(-1)?.[0] as MediaStream;

        expect(microphone.status()).toMatchObject({
            kind: 'microphone',
            state: 'open',
            streamId: 'microphone-stream',
            audioTrackIds: ['audio-track-1'],
        });
        expect(cameraDisabled).toMatchObject({
            kind: 'camera',
            enabledTrackIds: [],
            videoTrackIds: ['video-track-1'],
        });
        expect(videoTrack.enabled).toBe(false);
        expect(lastAttachedStream.getTracks().map((track) => track.id))
            .toEqual(['audio-track-1', 'video-track-1']);
        expect(mocks.ctx.middleware.rtcRxStreamer.setLocalAudioEnabled)
            .toHaveBeenLastCalledWith(true);
        expect(mocks.ctx.middleware.rtcRxStreamer.setLocalVideoEnabled)
            .toHaveBeenLastCalledWith(false);
    });

    it('exposes call source handles for screen sharing without opening data lanes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const screenTrack = createMediaTrack('screen-track-1', 'video');
        const screenStream = createMediaStream('screen-stream', [screenTrack]);
        const facade = createRallarFacade();

        const call = await facade.calls.start({
            peerIds: ['peer-1'],
            media: {},
        });
        const screen = await call.sources.screen.start({
            stream: screenStream,
        });
        const statusWithScreen = call.status();
        const stopped = await screen.stop();

        expect(mocks.webRtcConnectionService.ensurePeerConnectionStarted)
            .toHaveBeenCalledWith('peer-1');
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .not.toHaveBeenCalled();
        expect(statusWithScreen.media.sources).toEqual([
            expect.objectContaining({
                kind: 'screen',
                state: 'open',
                streamId: 'screen-stream',
                videoTrackIds: ['screen-track-1'],
            }),
        ]);
        expect(stopped).toMatchObject({
            kind: 'screen',
            state: 'ended',
        });
        expect(screenTrack.stop).toHaveBeenCalledOnce();
        expect(mocks.ctx.middleware.rtcRxStreamer.stopLocalMedia)
            .toHaveBeenCalledWith('all');
    });

    it('returns RTC send status with the message when multicast enqueue reports no entries', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockResolvedValueOnce({
            status: 'no-route',
            entries: [],
            reason: 'Skipping RTC outbound dispatch without planned transport messages',
        });
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        mockGroupSnapshot(room);

        const result = await createRallarFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-quiet',
            payload: {
                text: 'quiet outcome',
            },
        });

        expect(mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent)
            .toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            transport: 'rtc',
            status: 'no-route',
            reason: 'Skipping RTC outbound dispatch without planned transport messages',
            entries: [],
            message: {
                id: {
                    senderId: 'session-1',
                },
                route: {
                    topicId: 'chat.message.v1',
                    resourceId: 'msg-quiet',
                    contextId: 'room-1',
                },
                targets: {
                    mode: 'multicast',
                    groupRef: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'room-1',
                    },
                },
                forwarding: {
                    overlayId: toScopedOverlayId(room.group),
                },
            },
        });
    });

    it('wakes the queue-box engine when RTC send queues durable outbox work', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockResolvedValueOnce({
            status: 'enqueued',
            entries: [],
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));

        await createRallarFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-queued-rtc',
            payload: {
                text: 'queued rtc',
            },
        });

        expect(mocks.ctx.middleware.qboxEngine.wake).toHaveBeenCalledOnce();
    });

    it('adds cached room snapshotVersion as minSnapshotVersion on RTC room sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mockGroupSnapshot(withSnapshotVersion(
            createGroupSnapshot('room-1', ['session-1', 'peer-1']),
            7,
        ));

        const result = await createRallarFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-rtc',
            payload: {
                text: 'versioned rtc',
            },
        });

        expect(result.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            minSnapshotVersion: 7,
        });
        expect(result.message.targets).not.toHaveProperty('groupId');
    });

    it('uses roomRef scope for cached snapshotVersion on RTC room sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const workspaceA = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-a'],
                {
                    workspaceId: 'workspace-a',
                },
            ),
            7,
        );
        const workspaceB = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-b'],
                {
                    workspaceId: 'workspace-b',
                },
            ),
            11,
        );
        mockGroupSnapshots([workspaceA, workspaceB]);

        const result = await createRallarFacade().messages.rtc.send({
            roomId: 'shared-room',
            roomRef: workspaceB.group,
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-rtc-scoped',
            payload: {
                text: 'versioned scoped rtc',
            },
        });

        expect(result.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId: 'shared-room',
            },
            minSnapshotVersion: 11,
        });
        expect(result.message.targets).not.toHaveProperty('groupId');
    });

    it('returns WS send status with the message when WS enqueue completes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
            .mockResolvedValueOnce({
                status: 'sent-immediate',
                entries: [],
            });

        const result = await createRallarFacade().messages.ws.send({
            scope: 'all',
            typeId: 'chat.message.v1',
            resourceId: 'msg-ws',
            payload: {
                text: 'ws outcome',
            },
        });

        expect(mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .toHaveBeenCalledOnce();
        expect(mocks.ctx.middleware.qboxEngine.wake).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            transport: 'ws',
            status: 'sent-immediate',
            entries: [],
            message: {
                id: {
                    senderId: 'session-1',
                },
                route: {
                    topicId: 'chat.message.v1',
                    resourceId: 'msg-ws',
                    contextId: 'all',
                },
                targets: {
                    mode: 'broadcast',
                    scope: 'all',
                },
            },
        });
    });

    it('wakes the queue-box engine when WS send queues durable outbox work', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
            .mockResolvedValueOnce({
                status: 'enqueued',
                entries: [],
            });

        await createRallarFacade().messages.ws.send({
            scope: 'all',
            typeId: 'chat.message.v1',
            resourceId: 'msg-queued-ws',
            payload: {
                text: 'queued ws',
            },
        });

        expect(mocks.ctx.middleware.qboxEngine.wake).toHaveBeenCalledOnce();
    });

    it('adds cached room snapshotVersion as minSnapshotVersion on WS room sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mockGroupSnapshot(withSnapshotVersion(
            createGroupSnapshot('room-1', ['session-1', 'peer-1']),
            11,
        ));

        const result = await createRallarFacade().messages.ws.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-ws',
            payload: {
                text: 'versioned ws',
            },
        });

        expect(result.message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            minSnapshotVersion: 11,
        });
    });

    it('uses roomRef scope for cached snapshotVersion and target groupRef on WS room sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const workspaceA = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-a'],
                {
                    workspaceId: 'workspace-a',
                },
            ),
            5,
        );
        const workspaceB = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-b'],
                {
                    workspaceId: 'workspace-b',
                },
            ),
            13,
        );
        mockGroupSnapshots([workspaceA, workspaceB]);

        const result = await createRallarFacade().messages.ws.send({
            roomId: 'shared-room',
            roomRef: workspaceB.group,
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-ws-scoped',
            payload: {
                text: 'versioned scoped ws',
            },
        });

        expect(result.message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId: 'shared-room',
            },
            minSnapshotVersion: 13,
        });
    });

    it('uses roomRef scope for room RTC lane waits', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const workspaceA = createGroupSnapshot(
            'shared-room',
            ['session-1', 'peer-a'],
            {
                workspaceId: 'workspace-a',
            },
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            ['session-1', 'peer-b'],
            {
                workspaceId: 'workspace-b',
            },
        );
        mockGroupSnapshots([workspaceA, workspaceB]);
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-b',
            laneId: 'realtime',
        });
        const facade = createRallarFacade();

        await facade.connect();
        const result = await facade.rtc.waitForRoomLane(
            workspaceB.group,
            'realtime',
            {
                connect: true,
                timeoutMs: 1_000,
            },
        );

        expect(result.ready.map((ready) => ready.peerId)).toEqual(['peer-b']);
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-b',
                'realtime',
                expect.objectContaining({
                    timeoutMs: 1_000,
                }),
            );
    });

    it('registers realtime JSON listeners on connected peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        type RawCallback = {
            onMessage: (data: unknown, event: MessageEvent) => Promise<void>;
        };
        const rawCallbacks = new Map<string, RawCallback>();
        const realtimeChannel = {
            onRawMessageDo: vi.fn((id: string, callback: RawCallback) => {
                rawCallbacks.set(id, callback);
                return realtimeChannel;
            }),
            removeOnRawMessageCallbackById: vi.fn(),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const handler = vi.fn();
        const facade = createRallarFacade();

        facade.realtime.onJson('realtime', handler);
        await facade.connect();

        expect(realtimeChannel.onRawMessageDo).toHaveBeenCalledWith(
            'rallar:realtime:realtime',
            expect.objectContaining({
                onMessage: expect.any(Function),
            }),
        );

        const callback = rawCallbacks.get('rallar:realtime:realtime');
        await callback?.onMessage?.(
            JSON.stringify({
                x: 1,
            }),
            {
                data: JSON.stringify({
                    x: 1,
                }),
            } as MessageEvent,
        );

        expect(handler).toHaveBeenCalledWith(
            expect.objectContaining({
                peerId: 'peer-1',
                laneId: 'realtime',
                data: {
                    x: 1,
                },
            }),
        );
    });

    it('registers realtime binary listeners and normalizes typed arrays to ArrayBuffer', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        type RawCallback = {
            onMessage: (data: unknown, event: MessageEvent) => Promise<void>;
        };
        const rawCallbacks = new Map<string, RawCallback>();
        const realtimeChannel = {
            onRawMessageDo: vi.fn((id: string, callback: RawCallback) => {
                rawCallbacks.set(id, callback);
                return realtimeChannel;
            }),
            removeOnRawMessageCallbackById: vi.fn(),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const handler = vi.fn();
        const facade = createRallarFacade();

        facade.realtime.onBinary('realtime', handler);
        await facade.connect();

        const callback = rawCallbacks.get('rallar:realtime:realtime');
        await callback?.onMessage?.(
            new Uint8Array([1, 2, 3]),
            {
                data: new Uint8Array([1, 2, 3]),
            } as MessageEvent,
        );

        expect(handler).toHaveBeenCalledOnce();
        const message = handler.mock.calls[0]?.[0];
        expect(message).toMatchObject({
            peerId: 'peer-1',
            laneId: 'realtime',
        });
        expect(Array.from(new Uint8Array(message.data))).toEqual([1, 2, 3]);
    });

    it('exposes realtime lane health for active peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const health = {
            peerId: 'peer-1',
            label: 'rtc-realtime',
            state: 'Open',
            readyState: 'open',
            bufferedAmount: 12,
            queuedItemCount: 1,
            counters: {
                sent: 2,
                dropped: 1,
            },
        };
        const realtimeChannel = {
            readHealth: vi.fn(() => health),
        };
        const peer = {
            peerId: 'peer-1',
            channels: new Map([['realtime', realtimeChannel]]),
        };
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);
        const facade = createRallarFacade();

        await facade.connect();

        expect(facade.realtime.health({ laneIds: ['realtime'] })).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'realtime',
                channel: health,
            },
        ]);
    });
});

function findWsAnyMessageCallback(): {
    onMessage?: (message: unknown) => Promise<void>;
} | undefined {
    return mocks.ctx.middleware.webSocketQueueBox
        .onAnyInboxMessageDo.mock.calls.find(([callbackId]) =>
            callbackId === 'rallar:ws:any-message'
        )?.[1] as { onMessage?: (message: unknown) => Promise<void> } | undefined;
}

function findLatestWsAnyMessageCallback(): {
    onMessage?: (message: unknown) => Promise<void>;
} | undefined {
    return mocks.ctx.middleware.webSocketQueueBox
        .onAnyInboxMessageDo.mock.calls
        .filter(([callbackId]) => callbackId === 'rallar:ws:any-message')
        .at(-1)?.[1] as { onMessage?: (message: unknown) => Promise<void> } | undefined;
}

function toGroupStateEventMessage(event: GroupEvent) {
    return newALBroadcastMessage(
        'server-1',
        newALEventRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
        'all',
        AppTopics.groupStateEvent,
        event,
    );
}

function toClientStateEventMessage(event: ClientEvent) {
    return newALBroadcastMessage(
        'server-1',
        newALEventRoute(
            AppTopics.clientStateEvent,
            event.principalId,
            event.eventId,
        ),
        'all',
        AppTopics.clientStateEvent,
        event,
    );
}

function createGroupEvent(
    groupId: string,
    eventId: string,
    eventType: GroupEvent['eventType'],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
        snapshotVersion?: number;
        occurredAtEpochMs?: number;
    }> = {},
): GroupEvent {
    return {
        applicationId: scope.applicationId ?? 'app-1',
        workspaceId: scope.workspaceId ?? 'workspace-1',
        groupId,
        eventId,
        eventType,
        snapshotVersion: scope.snapshotVersion ?? 1,
        occurredAtEpochMs: scope.occurredAtEpochMs ?? 1,
        actor: {
            principalId: 'alice',
            sessionId: 'session-1',
        },
        requestId: `request-${eventId}`,
    };
}

function createClientEvent(
    principalId: string,
    eventId: string,
    eventType: ClientEvent['eventType'],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
        snapshotVersion?: number;
        occurredAtEpochMs?: number;
    }> = {},
): ClientEvent {
    return {
        applicationId: scope.applicationId ?? 'app-1',
        workspaceId: scope.workspaceId ?? 'workspace-1',
        principalId,
        eventId,
        eventType,
        clientInstanceId: `${principalId}-instance`,
        sessionId: `${principalId}-session`,
        snapshotVersion: scope.snapshotVersion ?? 1,
        occurredAtEpochMs: scope.occurredAtEpochMs ?? 1,
        actor: {
            principalId,
            sessionId: `${principalId}-session`,
        },
        requestId: `request-${eventId}`,
    };
}

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

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.groupRepositoryMissing.mockImplementation((key?: unknown) => {
        if (key === undefined) {
            return [...snapshots];
        }

        if (isGroupRefLike(key)) {
            return snapshots.find((snapshot) =>
                snapshot.group.groupId === key.groupId &&
                snapshot.group.applicationId === key.applicationId &&
                (snapshot.group.workspaceId ?? '') === (key.workspaceId ?? '')
            );
        }

        return snapshots.find((snapshot) => key === snapshot.group.groupId);
    });
}

function isGroupRefLike(value: unknown): value is GroupSnapshot['group'] {
    return typeof value === 'object' &&
        value !== null &&
        typeof (value as { groupId?: unknown }).groupId === 'string' &&
        typeof (value as { applicationId?: unknown }).applicationId === 'string';
}

function withSnapshotVersion(
    snapshot: GroupSnapshot,
    snapshotVersion: number,
): GroupSnapshot {
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            snapshotVersion,
        },
    };
}

function createClientSnapshot(
    principalId: string,
    sessionId: string,
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {},
): ClientSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return {
        principal: {
            applicationId,
            workspaceId,
            principalId,
            username: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: {
                atEpochMs: 1,
                byPrincipalId: principalId,
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: principalId,
            },
        },
        instances: [],
        activeSessions: [{
            applicationId,
            workspaceId,
            principalId,
            clientInstanceId: `${principalId}-instance`,
            sessionId,
            status: 'active',
            presenceState: 'online',
            transport: 'ws',
            authenticatedAtEpochMs: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        }],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: 1,
    };
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {},
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 1,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
        },
        members: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

function createDirectorGroupSnapshot(
    appointment?: Readonly<{
        sessionId: string;
        principalId: string;
        epoch: number;
        appointedAtEpochMs: number;
        heartbeatTtlMs: number;
    }>,
): GroupSnapshot {
    const snapshot = createGroupSnapshot('room-1', ['session-1']);
    const activeSessions = [
        {
            ...snapshot.activeSessions[0],
            principalId: 'principal-1',
            sessionId: 'session-1',
        },
    ];
    const members = [
        {
            ...snapshot.members[0],
            principalId: 'principal-1',
            role: 'owner' as const,
        },
    ];

    if (appointment) {
        activeSessions.push({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            sessionId: appointment.sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        });
        members.push({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'principal-1',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'principal-1',
            },
        });
    }

    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            created: {
                ...snapshot.group.created,
                byPrincipalId: 'principal-1',
            },
            metadata: appointment
                ? {
                    rallarDirector: {
                        version: 1,
                        mode: 'appointed-spa',
                        ...appointment,
                    },
                }
                : {},
        },
        members,
        activeSessions,
        memberCount: members.length,
        onlineMemberCount: activeSessions.length,
    };
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

function createMediaTrack(
    id: string,
    kind: 'audio' | 'video',
): MediaStreamTrack {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const track = {
        id,
        kind,
        enabled: true,
        readyState: 'live',
        addEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject,
        ) => {
            if (type === 'ended') {
                listeners.add(listener);
            }
        }),
        removeEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject,
        ) => {
            if (type === 'ended') {
                listeners.delete(listener);
            }
        }),
        stop: vi.fn(() => {
            track.readyState = 'ended';
            const event = { type: 'ended' } as Event;
            for (const listener of listeners) {
                if (typeof listener === 'function') {
                    listener(event);
                } else {
                    listener.handleEvent(event);
                }
            }
        }),
    };

    return track as unknown as MediaStreamTrack;
}

function createMediaStream(
    id: string,
    tracks: readonly MediaStreamTrack[],
): MediaStream {
    return {
        id,
        active: tracks.some((track) => track.readyState !== 'ended'),
        getTracks: vi.fn(() => [...tracks]),
        getAudioTracks: vi.fn(() =>
            tracks.filter((track) => track.kind === 'audio')
        ),
        getVideoTracks: vi.fn(() =>
            tracks.filter((track) => track.kind === 'video')
        ),
    } as unknown as MediaStream;
}
