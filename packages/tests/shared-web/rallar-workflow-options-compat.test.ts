import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
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
        expect(mocks.joinStateGroup.mock.calls[1]?.[3]).toEqual({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
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
