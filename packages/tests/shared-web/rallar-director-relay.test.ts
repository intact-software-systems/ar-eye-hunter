import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto, type WebRtcPeerConnectionLeft } from '@shared/services/WebRtcConnectionService.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveGroupMemberFixture, createActiveGroupPresenceSessionFixture, createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

type ApiIntegrationModule = typeof import('@shared-web/browser/api-integration.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type ApiWorkflowsModule = typeof import('@shared-web/browser/api-workflows.ts');
type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type MiddlewareModule = typeof import('@shared-web/browser/middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type DataCachesModule = typeof import('@shared-web/browser/data-caches.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');
type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        './api-middleware-test-double.ts'
    );
    const ctx = createApiMiddlewareTestDouble();
    const session = ctx.session;

    return {
        ctx,
        heartbeat: vi.mocked(ctx.middleware.heartbeat),
        qboxEngine: vi.mocked(ctx.middleware.qboxEngine),
        rtcRxStreamer: vi.mocked(ctx.middleware.rtcRxStreamer),
        webRtcConnectionService: vi.mocked(ctx.middleware.webRtcConnectionService),
        webSocketQueueBox: vi.mocked(ctx.middleware.webSocketQueueBox),
        webSocket: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
        clearMiddleware: vi.fn<AppContextModule['clearMiddleware']>(),
        initMiddleware: vi.fn<AppContextModule['initMiddleware']>(() => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn<AppContextModule['isMiddlewareReady']>(() => false),
        clearSession: vi.fn<AuthModule['clearSession']>(),
        readSession: vi.fn<AuthModule['readSession']>(() => session),
        writeSession: vi.fn<AuthModule['writeSession']>(),
        hydrateStateCaches: vi.fn<DataCachesModule['hydrateStateCaches']>(() => Promise.resolve()),
        onStateCacheChange: vi.fn<DataCachesModule['onStateCacheChange']>(() => vi.fn()),
        appointStateGroupDirector: vi.fn<ApiWorkflowsModule['appointStateGroupDirector']>(() => Promise.reject(new Error('director appointment not mocked'))),
        createAndJoinStateGroup: vi.fn<ApiWorkflowsModule['createAndJoinStateGroup']>(
            () => Promise.reject(new Error('create not mocked'))
        ),
        joinStateGroup: vi.fn<ApiWorkflowsModule['joinStateGroup']>(() => Promise.reject(new Error('join not mocked'))),
        leaveStateGroup: vi.fn<ApiWorkflowsModule['leaveStateGroup']>(() => Promise.reject(new Error('leave not mocked'))),
        updateStateGroupMetadata: vi.fn<ApiWorkflowsModule['updateStateGroupMetadata']>(
            () => Promise.reject(new Error('metadata update not mocked'))
        ),
        refreshStateSnapshots: vi.fn<ApiWorkflowsModule['refreshStateSnapshots']>(() => Promise.resolve({ clients: [], groups: [] })),
        loginToApi: vi.fn<AuthApiModule['loginToApi']>(() => Promise.resolve(session)),
        logoutFromApi: vi.fn<AuthApiModule['logoutFromApi']>(() => Promise.resolve({ loggedOut: true })),
        registerWithApi: vi.fn<AuthApiModule['registerWithApi']>(() =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            })
        ),
        listStateClientEvents: vi.fn<ApiIntegrationModule['listStateClientEvents']>(() => Promise.reject(new Error('client events not mocked'))),
        listStateClientEventPage: vi.fn<ApiIntegrationModule['listStateClientEventPage']>(() => Promise.reject(new Error('client event page not mocked'))),
        listStateGroupEvents: vi.fn<ApiIntegrationModule['listStateGroupEvents']>(() => Promise.reject(new Error('group events not mocked'))),
        listStateGroupEventPage: vi.fn<ApiIntegrationModule['listStateGroupEventPage']>(
            () => Promise.reject(new Error('group event page not mocked'))
        ),
        clientRepositoryMissing: vi.fn((): never => {
            throw new Error(
                'Repository not found: shared.repository.client-state-snapshots'
            );
        }),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<
            GroupStateSnapshotsRepositoryModule[
                'findFirstGroupStateSnapshotRefSessionIdIsIn'
            ]
        >(),
        findGroupStateSnapshotByRef: vi.fn<GroupStateSnapshotsRepositoryModule['findGroupStateSnapshotByRef']>(),
        getAllGroupStateSnapshots: vi.fn<GroupStateSnapshotsRepositoryModule['getAllGroupStateSnapshots']>()
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
        appointStateGroupDirector: mocks.appointStateGroupDirector,
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup,
        refreshStateSnapshots: mocks.refreshStateSnapshots,
        updateStateGroupMetadata: mocks.updateStateGroupMetadata
    })
);

vi.mock(
    import('@shared-web/browser/rooms/room-group-state-workflows.ts'),
    (): Partial<RoomGroupStateWorkflowsModule> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup
    })
);

vi.mock(
    import('@shared-web/browser/data-caches.ts'),
    (): Partial<DataCachesModule> => ({
        hydrateStateCaches: mocks.hydrateStateCaches,
        onStateCacheChange: mocks.onStateCacheChange
    })
);

vi.mock(
    import('@shared/api/auth.ts'),
    (): Partial<AuthModule> => ({
        clearSession: mocks.clearSession,
        isLoggedIn: vi.fn(() => true),
        readSession: mocks.readSession,
        writeSession: mocks.writeSession
    })
);

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
        getAllClientStateSnapshots: mocks.clientRepositoryMissing
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

describe('Rallar director relay', () => {
    beforeEach(async () => {
        (await import('@shared-web/browser/connection/browser-transport-runtime.ts'))
            .browserTransportRuntime.shutdown('test-reset');
        vi.clearAllMocks();
        vi.useRealTimers();
        mocks.clientRepositoryMissing.mockImplementation((principalId) => principalId === undefined ? [] : undefined);
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
        mocks.appointStateGroupDirector.mockRejectedValue(
            new Error('director appointment not mocked')
        );
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue([]);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
            (peerId) =>
                Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
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
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() => mocks.ctx.middleware.webRtcConnectionService);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
        mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
        mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => ({
                status: 'enqueued',
                message,
                entries: []
            })
        );
        mocks.rtcRxStreamer.onInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.rtcRxStreamer
        );
        mocks.rtcRxStreamer.removeInboxMessageCallback.mockReturnValue(true);
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => ({
                status: 'enqueued',
                message,
                entries: []
            })
        );
        mocks.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.webSocketQueueBox
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
            mocks.webSocket.close(code, reason);
        });
        mocks.webSocket.onWebsocketCallbacksDo.mockReturnValue(
            mocks.ctx.middleware.webSocketQueueBox.socket
        );
        mocks.webSocket.removeWebsocketCallbackById.mockReturnValue(true);
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

    it('appoints the current SPA session as room director', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const snapshot = createDirectorGroupSnapshot();
        mockGroupSnapshot(snapshot);
        mocks.appointStateGroupDirector.mockImplementation(
            async (
                _roomId: string,
                request: { heartbeatTtlMs?: number; }
            ) => {
                const appointment = {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'session-1',
                    principalId: 'principal-1',
                    epoch: 1,
                    appointedAtEpochMs: Date.now(),
                    heartbeatTtlMs: request.heartbeatTtlMs ?? 5_000
                };
                const updated = {
                    ...snapshot,
                    group: {
                        ...snapshot.group,
                        metadata: {
                            ...snapshot.group.metadata,
                            rallarDirector: appointment
                        }
                    }
                };
                mockGroupSnapshot(updated);
                return updated;
            }
        );

        const status = await createRallarFacade().director.appoint('room-1', {
            heartbeatTtlMs: 1_000
        });

        expect(mocks.appointStateGroupDirector).toHaveBeenCalledWith(
            'room-1',
            expect.objectContaining({
                heartbeatTtlMs: 1_000
            }),
            'principal-1',
            'session-1',
            expect.objectContaining({
                applicationId: 'app-1',
                workspaceId: 'workspace-1'
            }),
            expect.any(Object)
        );
        expect(status).toMatchObject({
            role: 'director',
            state: 'fresh',
            isDirector: true,
            isFresh: true,
            active: true
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
            accessToken: 'token-2'
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
                    expiresAtEpochMs: 61_000
                }
            ],
            onlineMemberCount: 1
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
                request: { heartbeatTtlMs?: number; },
                principalId: string,
                sessionId: string
            ) => {
                const appointment = {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId,
                    principalId,
                    epoch: 1,
                    appointedAtEpochMs: Date.now(),
                    heartbeatTtlMs: request.heartbeatTtlMs ?? 5_000
                };
                const updated = {
                    ...rejoined,
                    group: {
                        ...rejoined.group,
                        metadata: {
                            ...rejoined.group.metadata,
                            rallarDirector: appointment
                        }
                    }
                };
                mockGroupSnapshot(updated);
                expect(principalId).toBe(rejoinSession.clientId);
                expect(sessionId).toBe(rejoinSession.sessionId);
                return updated;
            }
        );

        const facade = createRallarFacade();
        await facade.rooms.createAndSwitch('Owner arena');
        await facade.auth.logout();
        mocks.readSession.mockReturnValue(rejoinSession);
        mocks.initMiddleware.mockResolvedValue({
            ...mocks.ctx,
            session: rejoinSession
        });
        await facade.rooms.enter('room-1');

        const status = await facade.director.appoint('room-1', {
            heartbeatTtlMs: 1_000
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
                heartbeatTtlMs: 1_000
            }
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
            heartbeatTtlMs: 5_000
        }));
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'timeout',
            peerId: 'director-session',
            laneId: 'director',
            error: new Error('not ready')
        });
        const facade = createRallarFacade();
        const relay = facade.director.createRelay<{ move: string; }, { ok: true; }>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output'
        });

        const result = await relay.sendIntent({ move: 'left' });
        relay.stop();

        expect(result.status).toBe('sent');
        expect(result.rtc).toMatchObject({
            status: 'failed',
            peerIds: ['director-session']
        });
        expect(mocks.webSocketQueueBox.enqueueOutboxIfAbsent)
            .toHaveBeenCalledWith(
                expect.objectContaining({
                    targets: {
                        mode: 'unicast',
                        toPeerId: 'director-session'
                    },
                    payload: expect.objectContaining({
                        typeId: 'game.intent',
                        resource: expect.stringContaining('"move":"left"')
                    })
                })
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
            heartbeatTtlMs: 5
        }));
        const relay = createRallarFacade().director.createRelay<{ move: string; }, { ok: true; }>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output'
        });

        const result = await relay.sendIntent({ move: 'left' });
        relay.stop();

        expect(result).toMatchObject({
            status: 'stale-director'
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
            heartbeatTtlMs: 60_000
        }));
        const relay = createRallarFacade().director.createRelay<{ move: string; }, { ok: true; }, { revision: number; }>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 60_000,
            snapshotTypeId: 'game.snapshot',
            snapshotIntervalMs: false,
            readSnapshot: () => ({ revision: 1 })
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
            heartbeatTtlMs: 60_000
        }));
        const relay = createRallarFacade().director.createRelay<{ move: string; }, { ok: true; }>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output'
        });

        const result = await relay.sendOutput({ ok: true });
        relay.stop();

        expect(result).toMatchObject({
            status: 'sent',
            rtc: {
                transport: 'rtc',
                status: 'no-route'
            },
            ws: {
                transport: 'ws',
                status: 'enqueued'
            }
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
            heartbeatTtlMs: 60_000
        }));
        const facade = createRallarFacade();
        facade.director.createRelay<{ move: string; }, { ok: true; }>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 1_000
        });

        await facade.auth.logout();
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockClear();
        mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockClear();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(mocks.webSocketQueueBox.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
        expect(mocks.rtcRxStreamer.enqueueOutboxIfAbsent)
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
            heartbeatTtlMs: 60_000
        }));
        const facade = createRallarFacade();
        const relay = facade.director.createRelay<{ move: string; }, { ok: true; }, { revision: number; }>(
            {
                roomId: 'room-1',
                laneId: 'director',
                topicId: 'app.game.director',
                intentTypeId: 'game.intent',
                outputTypeId: 'game.output',
                heartbeatIntervalMs: 60_000,
                snapshotTypeId: 'game.snapshot',
                snapshotIntervalMs: false,
                readSnapshot: () => ({ revision: 1 })
            }
        );

        await facade.auth.logout();
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockClear();
        mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockClear();
        mocks.initMiddleware.mockClear();

        const results = await Promise.all([
            relay.sendHeartbeat(),
            relay.sendOutput({ ok: true }),
            relay.sendSnapshot({ revision: 2 }),
            relay.sendIntent({ move: 'dash' }),
            relay.requestSync({ reason: 'late-join' })
        ]);

        expect(results.every((result) => result.status === 'no-director')).toBe(true);
        expect(results.every((result) => result.reason === 'Auth session ended.')).toBe(true);
        expect(mocks.webSocketQueueBox.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
        expect(mocks.rtcRxStreamer.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
        expect(mocks.initMiddleware).not.toHaveBeenCalled();
    });
});

function findLatestWsAnyMessageCallback(): OnMessageCallback | undefined {
    return mocks.webSocketQueueBox
        .onAnyInboxMessageDo.mock.calls
        .filter(([callbackId]) => callbackId === 'rallar:ws:any-message')
        .at(-1)?.[1];
}
function enqueuedWsTypeIds(): readonly string[] {
    return mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls
        .map(([message]) => {
            const payload = (message as { payload?: { typeId?: unknown; }; }).payload;
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

function mockGroupRepositoryMissing(): void {
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
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

function createDirectorGroupSnapshot(
    appointment?: Readonly<{
        sessionId: string;
        principalId: string;
        epoch: number;
        appointedAtEpochMs: number;
        heartbeatTtlMs: number;
    }>
): GroupSnapshot {
    const snapshot = createGroupSnapshot('room-1', ['session-1']);
    const activeSessions: GroupSnapshot['activeSessions'][number][] = [{
        ...snapshot.activeSessions[0],
        principalId: 'principal-1',
        sessionId: 'session-1'
    }];
    const members: GroupSnapshot['members'][number][] = [{
        ...snapshot.members[0],
        principalId: 'principal-1',
        role: 'owner'
    }];

    if (appointment) {
        activeSessions.push(createActiveGroupPresenceSessionFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            sessionId: appointment.sessionId
        }));
        members.push(createActiveGroupMemberFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            role: 'member',
            actorPrincipalId: 'principal-1'
        }));
    }

    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            created: {
                ...snapshot.group.created,
                actor: { kind: 'principal', principalId: 'principal-1' }
            },
            metadata: appointment
                ? {
                    rallarDirector: {
                        version: 1,
                        mode: 'appointed-spa',
                        ...appointment
                    }
                }
                : {}
        },
        members,
        activeSessions,
        memberCount: members.length,
        onlineMemberCount: activeSessions.length
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
    kind: 'audio' | 'video'
): MediaStreamTrack {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const track = {
        id,
        kind,
        enabled: true,
        readyState: 'live',
        addEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject
        ) => {
            if (type === 'ended') {
                listeners.add(listener);
            }
        }),
        removeEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject
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
                }
                else {
                    listener.handleEvent(event);
                }
            }
        })
    };

    return track as unknown as MediaStreamTrack;
}

function createMediaStream(
    id: string,
    tracks: readonly MediaStreamTrack[]
): MediaStream {
    return {
        id,
        active: tracks.some((track) => track.readyState !== 'ended'),
        getTracks: vi.fn(() => [...tracks]),
        getAudioTracks: vi.fn(() => tracks.filter((track) => track.kind === 'audio')),
        getVideoTracks: vi.fn(() => tracks.filter((track) => track.kind === 'video'))
    } as unknown as MediaStream;
}
