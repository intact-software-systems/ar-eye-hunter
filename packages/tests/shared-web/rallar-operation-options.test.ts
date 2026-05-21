import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import {
    newALBroadcastMessage,
    newALEventRoute,
    newALMulticastMessage,
    newALRoute,
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
                stopLocalMedia: vi.fn(),
            },
            webRtcGroupManager: {},
            webRtcConnectionService,
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
        loginToApi: vi.fn((_request?: unknown, _options?: unknown) =>
            Promise.resolve(session)
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
    loginToApi: mocks.loginToApi,
    logoutFromApi: mocks.logoutFromApi,
    registerWithApi: mocks.registerWithApi,
}));

vi.mock('@shared-web/browser/api-workflows.ts', () => ({
    createAndJoinStateGroup: mocks.createAndJoinStateGroup,
    joinStateGroup: mocks.joinStateGroup,
    leaveStateGroup: mocks.leaveStateGroup,
    refreshStateSnapshots: mocks.refreshStateSnapshots,
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
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.createAndJoinStateGroup.mockRejectedValue(new Error('create not mocked'));
        mocks.joinStateGroup.mockRejectedValue(new Error('join not mocked'));
        mocks.leaveStateGroup.mockRejectedValue(new Error('leave not mocked'));
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
        });
        expect(eventListener.mock.calls[0]?.[1]).toMatchObject({
            transport: 'ws',
            typeId: AppTopics.clientStateEvent,
            topicId: AppTopics.clientStateEvent,
        });
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
        mockGroupSnapshot(createGroupSnapshot('match-1', ['session-1', 'peer-1']));
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
            url: 'ws://localhost/ws',
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
            dataChannelLanes: lanes,
        });
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

    it('closes WS through the queue-box service when logging out after connect', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();

        await facade.connect();
        await facade.auth.logout();

        expect(mocks.ctx.middleware.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
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

    it('returns RTC send status with the message when multicast enqueue reports no entries', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockResolvedValueOnce({
            status: 'no-route',
            entries: [],
            reason: 'Skipping RTC outbound dispatch without planned transport messages',
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));

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
                    overlayId: 'room-1',
                },
            },
        });
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
    }> = {},
): GroupEvent {
    return {
        applicationId: scope.applicationId ?? 'app-1',
        workspaceId: scope.workspaceId ?? 'workspace-1',
        groupId,
        eventId,
        eventType,
        occurredAtEpochMs: 1,
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
        occurredAtEpochMs: 1,
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
