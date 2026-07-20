import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    createActiveGroupMemberFixture,
    createActiveGroupPresenceSessionFixture,
    createGroupSnapshotFixture,
} from './authoritative-group-fixtures.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import {
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
                _generationId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('create not mocked')),
        ),
        joinStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _generationId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('join not mocked')),
        ),
        leaveStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _generationId?: unknown,
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
        updateStateGroupDetails: vi.fn(
            (
                _roomId?: unknown,
                _request?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room update not mocked')),
        ),
        archiveStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _request?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room archive not mocked')),
        ),
        deleteStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _request?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room delete not mocked')),
        ),
        createStateGroupInvite: vi.fn(
            (
                _roomId?: unknown,
                _targetPrincipalId?: unknown,
                _request?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room invite not mocked')),
        ),
        acceptStateGroupInvite: vi.fn(
            (
                _roomId?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _generationId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room invite accept not mocked')),
        ),
        removeStateGroupMember: vi.fn(
            (
                _roomId?: unknown,
                _targetPrincipalId?: unknown,
                _request?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room member remove not mocked')),
        ),
        banStateGroupMember: vi.fn(
            (
                _roomId?: unknown,
                _targetPrincipalId?: unknown,
                _request?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room member ban not mocked')),
        ),
        unbanStateGroupMember: vi.fn(
            (
                _roomId?: unknown,
                _targetPrincipalId?: unknown,
                _request?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room member unban not mocked')),
        ),
        setStateGroupMemberRole: vi.fn(
            (
                _roomId?: unknown,
                _targetPrincipalId?: unknown,
                _request?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room member role not mocked')),
        ),
        transferStateGroupOwnership: vi.fn(
            (
                _roomId?: unknown,
                _request?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('room owner transfer not mocked')),
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
    acceptStateGroupInvite: mocks.acceptStateGroupInvite,
    archiveStateGroup: mocks.archiveStateGroup,
    banStateGroupMember: mocks.banStateGroupMember,
    createAndJoinStateGroup: mocks.createAndJoinStateGroup,
    createStateGroupInvite: mocks.createStateGroupInvite,
    deleteStateGroup: mocks.deleteStateGroup,
    joinStateGroup: mocks.joinStateGroup,
    leaveStateGroup: mocks.leaveStateGroup,
    refreshStateSnapshots: mocks.refreshStateSnapshots,
    removeStateGroupMember: mocks.removeStateGroupMember,
    setStateGroupMemberRole: mocks.setStateGroupMemberRole,
    transferStateGroupOwnership: mocks.transferStateGroupOwnership,
    unbanStateGroupMember: mocks.unbanStateGroupMember,
    updateStateGroupDetails: mocks.updateStateGroupDetails,
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

describe('Rallar workflow options compatibility', () => {
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
        mocks.updateStateGroupDetails.mockRejectedValue(
            new Error('room update not mocked'),
        );
        mocks.archiveStateGroup.mockRejectedValue(
            new Error('room archive not mocked'),
        );
        mocks.deleteStateGroup.mockRejectedValue(
            new Error('room delete not mocked'),
        );
        mocks.createStateGroupInvite.mockRejectedValue(
            new Error('room invite not mocked'),
        );
        mocks.acceptStateGroupInvite.mockRejectedValue(
            new Error('room invite accept not mocked'),
        );
        mocks.removeStateGroupMember.mockRejectedValue(
            new Error('room member remove not mocked'),
        );
        mocks.banStateGroupMember.mockRejectedValue(
            new Error('room member ban not mocked'),
        );
        mocks.unbanStateGroupMember.mockRejectedValue(
            new Error('room member unban not mocked'),
        );
        mocks.setStateGroupMemberRole.mockRejectedValue(
            new Error('room member role not mocked'),
        );
        mocks.transferStateGroupOwnership.mockRejectedValue(
            new Error('room owner transfer not mocked'),
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

        const policies = requireRecord(
            mocks.joinStateGroup.mock.calls[0]?.[5],
            'join workflow policies',
        );
        const command = requireRecord(
            policies.command,
            'join workflow command policies',
        );
        const shouldRetry = command.shouldRetry;
        if (typeof shouldRetry !== 'function') {
            throw new TypeError('Expected join workflow retry policy');
        }
        expect(command.maxAttempts).toBe(3);
        expect(
            shouldRetry(
                Object.assign(new Error('server busy'), { status: 503 }),
                1,
            ),
        ).toBe(true);
        expect(
            shouldRetry(
                Object.assign(new Error('rate limited'), { status: 429 }),
                1,
            ),
        ).toBe(true);
        expect(
            shouldRetry(
                Object.assign(new Error('bad request'), { status: 400 }),
                1,
            ),
        ).toBe(false);
        expect(
            shouldRetry(
                Object.assign(new Error('conflict'), { status: 409 }),
                1,
            ),
        ).toBe(false);
    });

    it('sets up configuration defaults and starts the facade with golden-path defaults', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const { readApiBaseUrl } = await import(
            '@shared-web/browser/api-client-config.ts'
        );
        const facade = createRallarFacade();

        const result = await facade.setup({
            apiBaseUrl: 'http://localhost:8080///',
            applicationId: 'game-app',
            workspaceId: 'arena-1',
            rtc: {
                maxPeerConnections: 10,
            },
            start: {
                timeoutMs: 123,
            },
        });

        expect(readApiBaseUrl()).toBe('http://localhost:8080');
        expect(facade.defaults()).toEqual({
            applicationId: 'game-app',
            workspaceId: 'arena-1',
            rtc: {
                maxPeerConnections: 10,
            },
        });
        expect(result.connected).toBe(true);
        expect(result.session?.sessionId).toBe('session-1');
        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            scope: {
                applicationId: 'game-app',
                workspaceId: 'arena-1',
            },
            timeoutMs: 123,
            maxPeerConnections: 10,
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'game-app',
                workspaceId: 'arena-1',
            },
            {
                command: {
                    timeoutMs: 123,
                },
            },
        );
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

        const policies = requireRecord(
            mocks.joinStateGroup.mock.calls[0]?.[5],
            'join workflow policies',
        );
        const command = requireRecord(
            policies.command,
            'join workflow command policies',
        );
        expect(command.maxAttempts).toBe(4);
    });

    it('joins rooms from object input using roomId or roomRef', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-ref',
        };
        const roomIdSnapshot = createGroupSnapshot('room-id', ['session-1']);
        const roomRefSnapshot = createGroupSnapshot('room-ref', ['session-1'], {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        mocks.joinStateGroup
            .mockResolvedValueOnce(roomIdSnapshot)
            .mockResolvedValueOnce(roomRefSnapshot);

        const facade = createRallarFacade();
        await facade.rooms.join({
            roomId: 'room-id',
            leaveCurrent: false,
        });
        await facade.rooms.join({
            roomRef,
            leaveCurrent: false,
        });

        expect(mocks.joinStateGroup.mock.calls[0]?.[0]).toBe('room-id');
        expect(mocks.joinStateGroup.mock.calls[1]?.[0]).toBe('room-ref');
        expect(mocks.joinStateGroup.mock.calls[1]?.[4]).toEqual({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
    });

    it('passes invite token and join code from room join input into the join workflow', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const snapshot = createGroupSnapshot('room-1', ['session-1']);
        mocks.joinStateGroup.mockResolvedValue(snapshot);

        await createRallarFacade().rooms.join({
            roomId: 'room-1',
            inviteToken: 'invite-1',
            joinCode: 'code-1',
        });

        expect(mocks.joinStateGroup.mock.calls[0]?.[6]).toEqual({
            inviteToken: 'invite-1',
            joinCode: 'code-1',
        });
    });

    it('enters a room and returns a room-bound session handle', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const snapshot = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        mockGroupSnapshot(snapshot);
        mocks.joinStateGroup.mockResolvedValue(snapshot);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue(['peer-1']);

        const room = await createRallarFacade().rooms.enter('room-1');
        const messageResult = await room
            .message<{ text: string }>('chat')
            .sendWs(
                { text: 'hello' },
                { resourceId: 'chat-message-1' },
            );
        const realtimeResult = await room
            .realtime<{ x: number }>('motion')
            .send({ x: 1 });

        expect(room.roomId).toBe('room-1');
        expect(room.roomRef).toEqual(snapshot.group);
        expect(room.snapshot()).toEqual(snapshot);
        expect(room.summary()?.roomId).toBe('room-1');
        expect(messageResult.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'chat-message-1',
        });
        expect(messageResult.message.payload.typeId).toBe('room.chat.v1');
        expect(messageResult.message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
        });
        expect(realtimeResult.laneId).toBe('motion');
        expect(realtimeResult.roomRef).toEqual(snapshot.group);
    });

    it('creates a room session for the current room without joining', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const snapshot = createGroupSnapshot('room-1', ['session-1']);
        mockGroupSnapshot(snapshot);
        mocks.joinStateGroup.mockResolvedValue(snapshot);
        const facade = createRallarFacade();
        await facade.rooms.join({ roomRef: snapshot.group, leaveCurrent: false });
        mocks.joinStateGroup.mockClear();

        const room = facade.rooms.session();

        expect(room.roomId).toBe('room-1');
        expect(room.roomRef).toEqual(snapshot.group);
        expect(mocks.joinStateGroup).not.toHaveBeenCalled();
    });

    it('rejects invalid room session message names before routing', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const snapshot = createGroupSnapshot('room-1', ['session-1']);
        mockGroupSnapshot(snapshot);

        const room = createRallarFacade().rooms.session(snapshot.group);

        expect(() => room.message('bad chat')).toThrow('$.topicId');
        expect(mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
    });

    it('rejects mismatched roomId and roomRef in join object input', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );

        await expect(createRallarFacade().rooms.join({
            roomId: 'room-a',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-b',
            },
        })).rejects.toThrow('roomId must match roomRef.groupId');

        expect(mocks.joinStateGroup).not.toHaveBeenCalled();
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

    it('creates and switches rooms by leaving the previous current room after create succeeds', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const oldRoom = createGroupSnapshot('old-room', ['session-1']);
        const newRoom = createGroupSnapshot('new-room', ['session-1']);
        const leftOldRoom = createGroupSnapshot('old-room', []);
        mockGroupSnapshot(oldRoom);
        mocks.createAndJoinStateGroup.mockResolvedValue(newRoom);
        mocks.leaveStateGroup.mockResolvedValue(leftOldRoom);

        const snapshot = await createRallarFacade().rooms.createAndSwitch({
            displayName: 'New Room',
        });

        expect(snapshot).toBe(newRoom);
        expect(mocks.createAndJoinStateGroup).toHaveBeenCalledWith(
            'New Room',
            'principal-1',
            'session-1',
            undefined,
            undefined,
            {},
            undefined,
        );
        expect(mocks.leaveStateGroup).toHaveBeenCalledWith(
            'old-room',
            'principal-1',
            'session-1',
            undefined,
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
            },
            {},
        );
        expect(mocks.hydrateStateCaches).toHaveBeenCalledWith(
            mocks.ctx.middleware.webRtcGroupManager,
            expect.objectContaining({
                clientId: 'principal-1',
                sessionId: 'session-1',
            }),
            [],
            [newRoom],
            expect.any(Object),
        );
        expect(mocks.hydrateStateCaches).toHaveBeenCalledWith(
            mocks.ctx.middleware.webRtcGroupManager,
            expect.objectContaining({
                clientId: 'principal-1',
                sessionId: 'session-1',
            }),
            [],
            [leftOldRoom],
            expect.any(Object),
        );
    });

    it('surfaces leave-old failure after create-and-switch while keeping new-room state coherent', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const oldRoom = createGroupSnapshot('old-room', ['session-1']);
        const newRoom = createGroupSnapshot('new-room', ['session-1']);
        const leaveError = new Error('leave failed');
        mockGroupSnapshots([oldRoom, newRoom]);
        mocks.createAndJoinStateGroup.mockResolvedValue(newRoom);
        mocks.leaveStateGroup.mockRejectedValueOnce(leaveError);
        const facade = createRallarFacade();

        await expect(facade.rooms.createAndSwitch({
            displayName: 'New Room',
        })).rejects.toMatchObject({
            name: 'RallarRoomSwitchPartialFailureError',
            operation: 'create-and-switch',
            joinedRoom: newRoom,
            previousRoomRef: oldRoom.group,
            leaveError,
        });

        expect(facade.rooms.current()).toBe(newRoom);
        expect(facade.rooms.state().currentRoomRef).toEqual(newRoom.group);
        expect(mocks.hydrateStateCaches).toHaveBeenCalledWith(
            mocks.ctx.middleware.webRtcGroupManager,
            expect.objectContaining({
                clientId: 'principal-1',
                sessionId: 'session-1',
            }),
            [],
            [newRoom],
            expect.any(Object),
        );
    });

    it('does not leave the current room when create-and-switch fails before creating', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const oldRoom = createGroupSnapshot('old-room', ['session-1']);
        mockGroupSnapshot(oldRoom);
        mocks.createAndJoinStateGroup.mockRejectedValueOnce(new Error('create failed'));

        await expect(createRallarFacade().rooms.createAndSwitch({
            displayName: 'New Room',
        })).rejects.toThrow('create failed');

        expect(mocks.leaveStateGroup).not.toHaveBeenCalled();
    });

    it('surfaces leave-old failure after join while keeping joined-room state coherent', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const oldRoom = createGroupSnapshot('old-room', ['session-1']);
        const newRoom = createGroupSnapshot('new-room', ['session-1']);
        const leaveError = new Error('leave failed');
        mockGroupSnapshots([oldRoom, newRoom]);
        mocks.joinStateGroup.mockResolvedValue(newRoom);
        mocks.leaveStateGroup.mockRejectedValueOnce(leaveError);
        const facade = createRallarFacade();

        await expect(facade.rooms.join('new-room')).rejects.toMatchObject({
            name: 'RallarRoomSwitchPartialFailureError',
            operation: 'join',
            joinedRoom: newRoom,
            previousRoomRef: oldRoom.group,
            leaveError,
        });

        expect(facade.rooms.current()).toBe(newRoom);
        expect(facade.rooms.state().currentRoomRef).toEqual(newRoom.group);
    });

    it('passes safe room create fields into the create workflow', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const scope = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        };
        const snapshot = createGroupSnapshot('custom-room', ['session-1']);
        mocks.createAndJoinStateGroup.mockResolvedValue(snapshot);

        await createRallarFacade().rooms.create({
            groupId: 'custom-room',
            displayName: 'Custom Room',
            description: 'Mission lobby',
            joinMode: 'open',
            maxMembers: 8,
            maxSessionsPerMember: 2,
            metadata: { map: 'fjord' },
            scope,
            timeoutMs: 55,
        });

        expect(mocks.createAndJoinStateGroup).toHaveBeenCalledWith(
            'Custom Room',
            'principal-1',
            'session-1',
            undefined,
            scope,
            {
                command: {
                    timeoutMs: 55,
                },
            },
            'custom-room',
            {
                description: 'Mission lobby',
                joinMode: 'open',
                maxMembers: 8,
                maxSessionsPerMember: 2,
                metadata: { map: 'fjord' },
            },
        );
    });

    it('runs safe room administration workflows with options and cache hydration', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
        };
        const snapshot = createGroupSnapshot('room-1', ['session-1']);
        const nextSnapshot = withSnapshotVersion(snapshot, 2);
        for (const workflow of [
            mocks.updateStateGroupDetails,
            mocks.archiveStateGroup,
            mocks.deleteStateGroup,
            mocks.createStateGroupInvite,
            mocks.acceptStateGroupInvite,
            mocks.removeStateGroupMember,
            mocks.banStateGroupMember,
            mocks.unbanStateGroupMember,
            mocks.setStateGroupMemberRole,
            mocks.transferStateGroupOwnership,
        ]) {
            workflow.mockResolvedValue(nextSnapshot);
        }
        const signal = new AbortController().signal;
        const options = {
            signal,
            timeoutMs: 75,
            maxAttempts: 2,
        };
        const facade = createRallarFacade();

        await facade.rooms.update({
            roomRef,
            displayName: 'Renamed Room',
            description: 'Updated',
            joinMode: 'open',
            maxMembers: 8,
            maxSessionsPerMember: 2,
            metadata: { map: 'fjord' },
            ...options,
        });
        await facade.rooms.archive(roomRef, options);
        await facade.rooms.delete(roomRef, options);
        await facade.rooms.invite(roomRef, 'member-1', {
            invitationExpiresAtEpochMs: 2_000,
            ...options,
        });
        await facade.rooms.acceptInvite(roomRef, options);
        await facade.rooms.removeMember(roomRef, 'member-1', options);
        await facade.rooms.banMember(roomRef, 'member-1', options);
        await facade.rooms.unbanMember(roomRef, 'member-1', options);
        await facade.rooms.setMemberRole(roomRef, 'member-1', 'admin', options);
        await facade.rooms.transferOwnership(roomRef, 'member-1', options);

        const scope = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        };
        const policies = {
            command: {
                signal,
                timeoutMs: 75,
                maxAttempts: 2,
                shouldRetry: expect.any(Function),
            },
        };
        expect(mocks.updateStateGroupDetails).toHaveBeenCalledWith(
            'room-1',
            {
                displayName: 'Renamed Room',
                description: 'Updated',
                joinMode: 'open',
                maxMembers: 8,
                maxSessionsPerMember: 2,
                metadata: { map: 'fjord' },
            },
            'principal-1',
            'session-1',
            scope,
            policies,
        );
        expect(mocks.archiveStateGroup).toHaveBeenCalledWith(
            'room-1',
            {},
            'principal-1',
            'session-1',
            scope,
            policies,
        );
        expect(mocks.deleteStateGroup).toHaveBeenCalledWith(
            'room-1',
            {},
            'principal-1',
            'session-1',
            scope,
            policies,
        );
        expect(mocks.createStateGroupInvite).toHaveBeenCalledWith(
            'room-1',
            'member-1',
            { invitationExpiresAtEpochMs: 2_000 },
            'principal-1',
            'session-1',
            scope,
            policies,
        );
        expect(mocks.acceptStateGroupInvite).toHaveBeenCalledWith(
            'room-1',
            'principal-1',
            'session-1',
            undefined,
            scope,
            policies,
        );
        expect(mocks.removeStateGroupMember).toHaveBeenCalledWith(
            'room-1',
            'member-1',
            {},
            'principal-1',
            'session-1',
            scope,
            policies,
        );
        expect(mocks.banStateGroupMember).toHaveBeenCalledWith(
            'room-1',
            'member-1',
            {},
            'principal-1',
            'session-1',
            scope,
            policies,
        );
        expect(mocks.unbanStateGroupMember).toHaveBeenCalledWith(
            'room-1',
            'member-1',
            {},
            'principal-1',
            'session-1',
            scope,
            policies,
        );
        expect(mocks.setStateGroupMemberRole).toHaveBeenCalledWith(
            'room-1',
            'member-1',
            { role: 'admin' },
            'principal-1',
            'session-1',
            scope,
            policies,
        );
        expect(mocks.transferStateGroupOwnership).toHaveBeenCalledWith(
            'room-1',
            { newOwnerPrincipalId: 'member-1' },
            'principal-1',
            'session-1',
            scope,
            policies,
        );
        expect(mocks.hydrateStateCaches).toHaveBeenCalledWith(
            mocks.ctx.middleware.webRtcGroupManager,
            expect.objectContaining({
                clientId: 'principal-1',
                sessionId: 'session-1',
            }),
            [],
            [nextSnapshot],
            expect.any(Object),
        );
    });

    it('rejects mismatched roomId and roomRef in room administration input before network calls', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );

        await expect(createRallarFacade().rooms.removeMember({
            roomId: 'room-a',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-b',
            },
        }, 'member-1')).rejects.toThrow('roomId must match roomRef.groupId');

        expect(mocks.removeStateGroupMember).not.toHaveBeenCalled();
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
            maxPeerConnections: 12,
        });

        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            dataChannelLanes: lanes,
            maxPeerConnections: 12,
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

    it('ignores primitive refresh input for state scope parsing', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );

        await createRallarFacade().rooms.refresh(123 as unknown as never);

        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(undefined, {});
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

});


function findLatestWsAnyMessageCallback(): {
    onMessage?: (message: unknown) => Promise<void>;
} | undefined {
    return mocks.ctx.middleware.webSocketQueueBox
        .onAnyInboxMessageDo.mock.calls
        .filter(([callbackId]) => callbackId === 'rallar:ws:any-message')
        .at(-1)?.[1] as { onMessage?: (message: unknown) => Promise<void> } | undefined;
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
    return createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds,
    });
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
    const activeSessions: GroupSnapshot['activeSessions'][number][] = [{
        ...snapshot.activeSessions[0],
        principalId: 'principal-1',
        sessionId: 'session-1',
    }];
    const members: GroupSnapshot['members'][number][] = [{
        ...snapshot.members[0],
        principalId: 'principal-1',
        role: 'owner',
    }];

    if (appointment) {
        activeSessions.push(createActiveGroupPresenceSessionFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            sessionId: appointment.sessionId,
        }));
        members.push(createActiveGroupMemberFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            role: 'member',
            actorPrincipalId: 'principal-1',
        }));
    }

    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            created: {
                ...snapshot.group.created,
                actor: { kind: 'principal', principalId: 'principal-1' },
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isUnknownRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
