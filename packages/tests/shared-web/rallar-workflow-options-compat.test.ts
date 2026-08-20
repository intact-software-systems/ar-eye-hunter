import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/WebRtcConnectionService.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';

type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type ApiIntegrationModule = typeof import('@shared-web/browser/api-integration.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type ApiWorkflowsModule = typeof import('@shared-web/browser/api-workflows.ts');
type RoomGroupStateWorkflowsModule =
    typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');
type RoomGroupStateMutationWorkflowsModule =
    typeof import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts');
type RoomMembershipGroupStateWorkflowsModule =
    typeof import('@shared-web/browser/rooms/room-membership-group-state-workflows.ts');
type DataCachesModule = typeof import('@shared-web/browser/data-caches.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule =
    typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule =
    typeof import('@shared/repository/group-state-snapshots-repository.ts');

const CLIENT_REPOSITORY_MISSING_MESSAGE =
    'Repository not found: shared.repository.client-state-snapshots';
const GROUP_REPOSITORY_MISSING_MESSAGE =
    'Repository not found: shared.repository.group-state-snapshots';

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
        createAndJoinStateGroup: vi.fn<
            RoomGroupStateWorkflowsModule['createAndJoinStateGroup']
        >(() => Promise.reject(new Error('create not mocked'))),
        joinStateGroup: vi.fn<RoomGroupStateWorkflowsModule['joinStateGroup']>(() =>
            Promise.reject(new Error('join not mocked'))
        ),
        leaveStateGroup: vi.fn<RoomGroupStateWorkflowsModule['leaveStateGroup']>(() =>
            Promise.reject(new Error('leave not mocked'))
        ),
        updateStateGroupMetadata: vi.fn<
            RoomGroupStateMutationWorkflowsModule['updateStateGroupMetadata']
        >(() => Promise.reject(new Error('metadata update not mocked'))),
        updateStateGroupDetails: vi.fn<
            RoomGroupStateMutationWorkflowsModule['updateStateGroupDetails']
        >(() => Promise.reject(new Error('room update not mocked'))),
        archiveStateGroup: vi.fn<
            RoomGroupStateMutationWorkflowsModule['archiveStateGroup']
        >(() => Promise.reject(new Error('room archive not mocked'))),
        deleteStateGroup: vi.fn<
            RoomGroupStateMutationWorkflowsModule['deleteStateGroup']
        >(() => Promise.reject(new Error('room delete not mocked'))),
        createStateGroupInvite: vi.fn<
            RoomMembershipGroupStateWorkflowsModule['createStateGroupInvite']
        >(() => Promise.reject(new Error('room invite not mocked'))),
        acceptStateGroupInvite: vi.fn<
            RoomMembershipGroupStateWorkflowsModule['acceptStateGroupInvite']
        >(() => Promise.reject(new Error('room invite accept not mocked'))),
        removeStateGroupMember: vi.fn<
            RoomMembershipGroupStateWorkflowsModule['removeStateGroupMember']
        >(() => Promise.reject(new Error('room member remove not mocked'))),
        banStateGroupMember: vi.fn<
            RoomMembershipGroupStateWorkflowsModule['banStateGroupMember']
        >(() => Promise.reject(new Error('room member ban not mocked'))),
        unbanStateGroupMember: vi.fn<
            RoomMembershipGroupStateWorkflowsModule['unbanStateGroupMember']
        >(() => Promise.reject(new Error('room member unban not mocked'))),
        setStateGroupMemberRole: vi.fn<
            RoomMembershipGroupStateWorkflowsModule['setStateGroupMemberRole']
        >(() => Promise.reject(new Error('room member role not mocked'))),
        transferStateGroupOwnership: vi.fn<
            RoomMembershipGroupStateWorkflowsModule['transferStateGroupOwnership']
        >(() => Promise.reject(new Error('room owner transfer not mocked'))),
        loginToApi: vi.fn<AuthApiModule['loginToApi']>(() => Promise.resolve(ctx.session)),
        listStateClientEvents: vi.fn<ApiIntegrationModule['listStateClientEvents']>(() =>
            Promise.reject(new Error('client events not mocked'))
        ),
        listStateClientEventPage: vi.fn<
            ApiIntegrationModule['listStateClientEventPage']
        >(() => Promise.reject(new Error('client event page not mocked'))),
        listStateGroupEvents: vi.fn<ApiIntegrationModule['listStateGroupEvents']>(() =>
            Promise.reject(new Error('group events not mocked'))
        ),
        listStateGroupEventPage: vi.fn<ApiIntegrationModule['listStateGroupEventPage']>(
            () => Promise.reject(new Error('group event page not mocked')),
        ),
        logoutFromApi: vi.fn<AuthApiModule['logoutFromApi']>(() =>
            Promise.resolve({ loggedOut: true })
        ),
        registerWithApi: vi.fn<AuthApiModule['registerWithApi']>(() =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000,
            })
        ),
        onStateCacheChange: vi.fn<DataCachesModule['onStateCacheChange']>(() => vi.fn()),
        readSession: vi.fn<AuthModule['readSession']>(() => ctx.session),
        refreshStateSnapshots: vi.fn<ApiWorkflowsModule['refreshStateSnapshots']>(() =>
            Promise.resolve({ clients: [], groups: [] })
        ),
        findClientStateSnapshotByPrincipalId: vi.fn<
            ClientStateSnapshotsRepositoryModule['findClientStateSnapshotByPrincipalId']
        >(throwClientRepositoryMissing),
        getAllClientStateSnapshots: vi.fn<
            ClientStateSnapshotsRepositoryModule['getAllClientStateSnapshots']
        >(throwClientRepositoryMissing),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<
            GroupStateSnapshotsRepositoryModule[
                'findFirstGroupStateSnapshotRefSessionIdIsIn'
            ]
        >(throwGroupRepositoryMissing),
        findGroupStateSnapshotByRef: vi.fn<
            GroupStateSnapshotsRepositoryModule['findGroupStateSnapshotByRef']
        >(throwGroupRepositoryMissing),
        getAllGroupStateSnapshots: vi.fn<
            GroupStateSnapshotsRepositoryModule['getAllGroupStateSnapshots']
        >(throwGroupRepositoryMissing),
        writeSession: vi.fn<AuthModule['writeSession']>(),
    };
});

vi.mock(
    import('@shared-web/browser/app-context.ts'),
    (): Partial<AppContextModule> => ({
        clearMiddleware: mocks.clearMiddleware,
        getMiddleware: vi.fn(() => mocks.ctx),
        initMiddleware: mocks.initMiddleware,
        isMiddlewareReady: mocks.isMiddlewareReady,
    }),
);

vi.mock(
    import('@shared-web/browser/api-integration.ts'),
    (): Partial<ApiIntegrationModule> => ({
        listStateClientEventPage: mocks.listStateClientEventPage,
        listStateClientEvents: mocks.listStateClientEvents,
        listStateGroupEventPage: mocks.listStateGroupEventPage,
        listStateGroupEvents: mocks.listStateGroupEvents,
    }),
);

vi.mock(import('@shared-web/browser/auth/session-http-api.ts'), (): Partial<AuthApiModule> => ({
    loginToApi: mocks.loginToApi,
    logoutFromApi: mocks.logoutFromApi,
    registerWithApi: mocks.registerWithApi,
}));

vi.mock(
    import('@shared-web/browser/api-workflows.ts'),
    (): Partial<ApiWorkflowsModule> => ({
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
    }),
);

vi.mock(
    import('@shared-web/browser/rooms/room-group-state-workflows.ts'),
    (): Partial<RoomGroupStateWorkflowsModule> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup,
    }),
);

vi.mock(
    import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'),
    (): Partial<RoomGroupStateMutationWorkflowsModule> => ({
        archiveStateGroup: mocks.archiveStateGroup,
        deleteStateGroup: mocks.deleteStateGroup,
        updateStateGroupDetails: mocks.updateStateGroupDetails,
        updateStateGroupMetadata: mocks.updateStateGroupMetadata,
    }),
);

vi.mock(
    import('@shared-web/browser/rooms/room-membership-group-state-workflows.ts'),
    (): Partial<RoomMembershipGroupStateWorkflowsModule> => ({
        acceptStateGroupInvite: mocks.acceptStateGroupInvite,
        banStateGroupMember: mocks.banStateGroupMember,
        createStateGroupInvite: mocks.createStateGroupInvite,
        removeStateGroupMember: mocks.removeStateGroupMember,
        setStateGroupMemberRole: mocks.setStateGroupMemberRole,
        transferStateGroupOwnership: mocks.transferStateGroupOwnership,
        unbanStateGroupMember: mocks.unbanStateGroupMember,
    }),
);

vi.mock(
    import('@shared-web/browser/data-caches.ts'),
    (): Partial<DataCachesModule> => ({
        hydrateStateCaches: mocks.hydrateStateCaches,
        onStateCacheChange: mocks.onStateCacheChange,
    }),
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: mocks.clearSession,
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: mocks.writeSession,
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots,
    }),
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<GroupStateSnapshotsRepositoryModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn:
            mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots,
    }),
);

describe('Rallar workflow options compatibility', () => {
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
            (peerId) =>
                Either.ofLeft({
                    kind: 'connect-failed',
                    peerId,
                    error: new Error('connect not mocked'),
                }),
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
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
        mocks.rtcRxStreamer.onInboxMessageDo.mockReturnValue(mocks.rtcRxStreamer);
        mocks.rtcRxStreamer.removeInboxMessageCallback.mockReturnValue(true);
        mocks.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
            mocks.webSocketQueueBox,
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
            reconnectExhausted: false,
        });
        mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
            mocks.webSocketClient.close(code, reason);
        });
        mocks.webSocketClient.onWebsocketCallbacksDo.mockReturnValue(
            mocks.webSocketClient,
        );
        mocks.webSocketClient.removeWebsocketCallbackById.mockReturnValue(true);
        mocks.registerWithApi.mockResolvedValue({
            clientId: 'client-new',
            username: 'new-user',
            displayName: null,
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
                new ApiHttpError('POST', '/api/state/mutation', 503, 'server busy'),
                1,
            ),
        ).toBe(true);
        expect(
            shouldRetry(
                new ApiHttpError('POST', '/api/state/mutation', 429, 'rate limited'),
                1,
            ),
        ).toBe(true);
        expect(
            shouldRetry(
                new ApiHttpError('POST', '/api/state/mutation', 400, 'bad request'),
                1,
            ),
        ).toBe(false);
        expect(
            shouldRetry(
                new ApiHttpError('POST', '/api/state/mutation', 409, 'conflict'),
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
        expect(mocks.webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
    });

    it('rejects mismatched roomId and roomRef in join object input', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );

        await expect(
            createRallarFacade().rooms.join({
                roomId: 'room-a',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-b',
                },
            }),
        ).rejects.toThrow('roomId must match roomRef.groupId');

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

        await expect(
            createRallarFacade().rooms.createAndSwitch({
                displayName: 'New Room',
            }),
        ).rejects.toThrow('create failed');

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
        for (
            const workflow of [
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
            ]
        ) {
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

        await expect(
            createRallarFacade().rooms.removeMember({
                roomId: 'room-a',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-b',
                },
            }, 'member-1'),
        ).rejects.toThrow('roomId must match roomRef.groupId');

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
        const nextCtx: ApiMiddleware = {
            ...mocks.ctx,
            session: nextSession,
        };
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
        mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation(
            (sessionId) => {
                if (sessionId === 'session-1') {
                    return {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'old-room',
                    };
                }

                throw new Error(GROUP_REPOSITORY_MISSING_MESSAGE);
            },
        );
        mocks.joinStateGroup.mockRejectedValueOnce(new Error('join failed'));

        await expect(createRallarFacade().rooms.join('new-room')).rejects.toThrow(
            'join failed',
        );

        expect(mocks.leaveStateGroup).not.toHaveBeenCalled();
    });
});

function mockClientRepositoryMissing(): void {
    const throwMissing = (): never => {
        throw new Error(CLIENT_REPOSITORY_MISSING_MESSAGE);
    };
    mocks.findClientStateSnapshotByPrincipalId.mockImplementation(throwMissing);
    mocks.getAllClientStateSnapshots.mockImplementation(throwMissing);
}
function mockGroupRepositoryMissing(): void {
    const throwMissing = (): never => {
        throw new Error(GROUP_REPOSITORY_MISSING_MESSAGE);
    };
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation(throwMissing);
    mocks.findGroupStateSnapshotByRef.mockImplementation(throwMissing);
    mocks.getAllGroupStateSnapshots.mockImplementation(throwMissing);
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
                (activeSession) => activeSession.sessionId === sessionId,
            )
        )?.group
    );
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
