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
        appointStateGroupDirector: vi.fn(
            (
                _roomId: string,
                _request: { heartbeatTtlMs?: number },
                _principalId: string,
                _sessionId: string,
                _scope?: unknown,
                _policies?: unknown,
            ): Promise<GroupSnapshot> =>
                Promise.reject(new Error('director appointment not mocked')),
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
    appointStateGroupDirector: mocks.appointStateGroupDirector,
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

describe('Rallar director relay compatibility', () => {
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
        mocks.appointStateGroupDirector.mockRejectedValue(
            new Error('director appointment not mocked'),
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

    it('appoints the current SPA session as room director', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const snapshot = createDirectorGroupSnapshot();
        mockGroupSnapshot(snapshot);
        mocks.appointStateGroupDirector.mockImplementation(
            async (
                _roomId: string,
                request: { heartbeatTtlMs?: number },
            ) => {
                const appointment = {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'session-1',
                    principalId: 'principal-1',
                    epoch: 1,
                    appointedAtEpochMs: Date.now(),
                    heartbeatTtlMs: request.heartbeatTtlMs ?? 5_000,
                };
                const updated = {
                    ...snapshot,
                    group: {
                        ...snapshot.group,
                        metadata: {
                            ...snapshot.group.metadata,
                            rallarDirector: appointment,
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

        expect(mocks.appointStateGroupDirector).toHaveBeenCalledWith(
            'room-1',
            expect.objectContaining({
                heartbeatTtlMs: 1_000,
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

    it('lets the room owner appoint their new session after logout and rejoin', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const created = createDirectorGroupSnapshot();
        const rejoinSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2',
        };
        const rejoined: GroupSnapshot = {
            ...created,
            activeSessions: [
                {
                    ...created.activeSessions[0],
                    sessionId: rejoinSession.sessionId,
                    principalId: rejoinSession.clientId,
                    generationId: 'generation-session-2',
                    generationVersion: 2,
                    connectedAtEpochMs: 2,
                    lastHeartbeatAtEpochMs: 2,
                    expiresAtEpochMs: 61_000,
                },
            ],
            onlineMemberCount: 1,
        };
        mockGroupSnapshot(created);
        mocks.createAndJoinStateGroup.mockResolvedValueOnce(created);
        mocks.joinStateGroup.mockImplementationOnce(async () => {
            mockGroupSnapshot(rejoined);
            return rejoined;
        });
        mocks.appointStateGroupDirector.mockImplementationOnce(
            async (
                _roomId: string,
                request: { heartbeatTtlMs?: number },
                principalId: string,
                sessionId: string,
            ) => {
                const appointment = {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId,
                    principalId,
                    epoch: 1,
                    appointedAtEpochMs: Date.now(),
                    heartbeatTtlMs: request.heartbeatTtlMs ?? 5_000,
                };
                const updated = {
                    ...rejoined,
                    group: {
                        ...rejoined.group,
                        metadata: {
                            ...rejoined.group.metadata,
                            rallarDirector: appointment,
                        },
                    },
                };
                mockGroupSnapshot(updated);
                expect(principalId).toBe(rejoinSession.clientId);
                expect(sessionId).toBe(rejoinSession.sessionId);
                return updated;
            },
        );

        const facade = createRallarFacade();
        await facade.rooms.createAndSwitch('Owner arena');
        await facade.auth.logout();
        mocks.readSession.mockReturnValue(rejoinSession);
        mocks.initMiddleware.mockResolvedValue({
            ...mocks.ctx,
            session: rejoinSession,
        } as ApiMiddleware);
        await facade.rooms.enter('room-1');

        const status = await facade.director.appoint('room-1', {
            heartbeatTtlMs: 1_000,
        });

        expect(status).toMatchObject({
            role: 'director',
            state: 'fresh',
            isDirector: true,
            isFresh: true,
            appointment: {
                sessionId: 'session-2',
                principalId: 'principal-1',
                epoch: 1,
                heartbeatTtlMs: 1_000,
            },
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
            topicId: 'app.game.director',
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
            topicId: 'app.game.director',
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

    it('can disable periodic director snapshots while keeping explicit sync snapshots', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: 1,
            heartbeatTtlMs: 60_000,
        }));
        const relay = createRallarFacade().director.createRelay<
            { move: string },
            { ok: true },
            { revision: number }
        >({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 60_000,
            snapshotTypeId: 'game.snapshot',
            snapshotIntervalMs: false,
            readSnapshot: () => ({ revision: 1 }),
        });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(enqueuedWsTypeIds()).not.toContain('game.snapshot');

        await relay.sendSnapshot();
        relay.stop();

        expect(enqueuedWsTypeIds()).toContain('game.snapshot');
    });

    it('falls back to WS when director room RTC output has no remote route', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: 1,
            heartbeatTtlMs: 60_000,
        }));
        const relay = createRallarFacade().director.createRelay<
            { move: string },
            { ok: true }
        >({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
        });

        const result = await relay.sendOutput({ ok: true });
        relay.stop();

        expect(result).toMatchObject({
            status: 'sent',
            rtc: {
                transport: 'rtc',
                status: 'no-route',
            },
            ws: {
                transport: 'ws',
                status: 'enqueued',
            },
        });
    });

    it('stops director relay heartbeats when auth logs out', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: 1,
            heartbeatTtlMs: 60_000,
        }));
        const facade = createRallarFacade();
        facade.director.createRelay<{ move: string }, { ok: true }>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 1_000,
        });

        await facade.auth.logout();
        mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent.mockClear();
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockClear();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
        expect(mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
        expect(mocks.initMiddleware).not.toHaveBeenCalled();
    });

    it('rejects stale director relay handle sends after logout without reconnecting', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: 1,
            heartbeatTtlMs: 60_000,
        }));
        const facade = createRallarFacade();
        const relay = facade.director.createRelay<{ move: string }, { ok: true }, { revision: number }>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 60_000,
            snapshotTypeId: 'game.snapshot',
            snapshotIntervalMs: false,
            readSnapshot: () => ({ revision: 1 }),
        });

        await facade.auth.logout();
        mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent.mockClear();
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockClear();
        mocks.initMiddleware.mockClear();

        const results = await Promise.all([
            relay.sendHeartbeat(),
            relay.sendOutput({ ok: true }),
            relay.sendSnapshot({ revision: 2 }),
            relay.sendIntent({ move: 'dash' }),
            relay.requestSync({ reason: 'late-join' }),
        ]);

        expect(results.every((result) => result.status === 'no-director')).toBe(true);
        expect(results.every((result) => result.reason === 'Auth session ended.')).toBe(true);
        expect(mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
        expect(mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
        expect(mocks.initMiddleware).not.toHaveBeenCalled();
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

function enqueuedWsTypeIds(): readonly string[] {
    return mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls
        .map(([message]) => {
            const payload = (message as { payload?: { typeId?: unknown } }).payload;
            return typeof payload?.typeId === 'string' ? payload.typeId : undefined;
        })
        .filter((typeId): typeId is string => typeId !== undefined);
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
