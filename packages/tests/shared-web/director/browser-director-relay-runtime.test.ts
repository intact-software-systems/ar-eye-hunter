import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto, type WebRtcPeerConnectionLeft } from '@shared/services/WebRtcConnectionService.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectorGroupSnapshot } from '../director-group-snapshot-fixture.ts';

type StateEventHttpApiModule = typeof import('@shared-web/browser/state-read/state-event-http-api.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type AppointRoomDirectorModule = typeof import('@shared-web/browser/director/appoint-room-director.ts');
type RoomMutationWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');
type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');

interface DirectorMove {
    readonly move: string;
}

interface DirectorAcknowledgement {
    readonly ok: true;
}

interface DirectorSnapshot {
    readonly revision: number;
}

const mocks = await vi.hoisted(async () => {
    const { createLightweightBrowserFacadeTestMocks } = await import(
        '../lightweight-browser-facade-test-mocks.ts'
    );
    return createLightweightBrowserFacadeTestMocks();
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

vi.mock(import('@shared-web/browser/director/appoint-room-director.ts'), (): Partial<AppointRoomDirectorModule> => ({
    appointStateGroupDirector: mocks.appointStateGroupDirector
}));
vi.mock(import('@shared-web/browser/state-read/refresh-state-snapshots.ts'), (): Partial<RefreshStateSnapshotsModule> => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots
}));
vi.mock(import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'), (): Partial<RoomMutationWorkflowsModule> => ({
    updateStateGroupMetadata: mocks.updateStateGroupMetadata
}));

vi.mock(
    import('@shared-web/browser/rooms/room-group-state-workflows.ts'),
    (): Partial<RoomGroupStateWorkflowsModule> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup
    })
);

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
        resetDirectorTestDoubles();
    });

    it('appoints the current SPA session as room director', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const snapshot = createDirectorGroupSnapshot();
        mockGroupSnapshot(snapshot);
        mocks.appointStateGroupDirector.mockImplementation(
            async (input) => {
                const appointment = {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'session-1',
                    principalId: 'principal-1',
                    epoch: 1,
                    appointedAtEpochMs: Date.now(),
                    heartbeatTtlMs: input.request.heartbeatTtlMs ?? 5_000
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
            expect.objectContaining({
                groupId: 'room-1',
                request: expect.objectContaining({ heartbeatTtlMs: 1_000 }),
                principalId: 'principal-1',
                sessionId: 'session-1',
                scope: expect.objectContaining({
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1'
                }),
                policies: expect.any(Object)
            })
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
            async (input) => {
                const appointment = {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: input.sessionId,
                    principalId: input.principalId,
                    epoch: 1,
                    appointedAtEpochMs: Date.now(),
                    heartbeatTtlMs: input.request.heartbeatTtlMs ?? 5_000
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
                expect(input.principalId).toBe(rejoinSession.clientId);
                expect(input.sessionId).toBe(rejoinSession.sessionId);
                return updated;
            }
        );

        const facade = createRallarFacade();
        await facade.rooms.createAndSwitch('Owner arena');
        await facade.auth.logout();
        mocks.readSession.mockReturnValue(rejoinSession);
        mocks.initialiseApiMiddleware.mockResolvedValue({
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
        const relay = facade.director.createRelay<DirectorMove, DirectorAcknowledgement>({
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
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async () => {
                throw new Error('Stale director intents must not open an RTC lane.');
            }
        );
        const relay = createRallarFacade().director.createRelay<DirectorMove, DirectorAcknowledgement>({
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
        const enqueuedWsTypeIds: string[] = [];
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                enqueuedWsTypeIds.push(message.payload.typeId);
                return { status: 'enqueued', message, entries: [] };
            }
        );
        const relay = createRallarFacade().director.createRelay<DirectorMove, DirectorAcknowledgement, DirectorSnapshot>({
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
        expect(enqueuedWsTypeIds).not.toContain('game.snapshot');

        await relay.sendSnapshot();
        relay.stop();

        expect(enqueuedWsTypeIds).toContain('game.snapshot');
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
        const relay = createRallarFacade().director.createRelay<DirectorMove, DirectorAcknowledgement>({
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
        facade.director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            laneId: 'director',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 1_000
        });

        await facade.auth.logout();
        const postLogoutEffects: string[] = [];
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                postLogoutEffects.push(`ws:${message.payload.typeId}`);
                return { status: 'enqueued', message, entries: [] };
            }
        );
        mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                postLogoutEffects.push(`rtc:${message.payload.typeId}`);
                return { status: 'enqueued', message, entries: [] };
            }
        );
        mocks.initialiseApiMiddleware.mockImplementation(async () => {
            postLogoutEffects.push('middleware:init');
            return mocks.ctx;
        });
        await vi.advanceTimersByTimeAsync(5_000);

        expect(postLogoutEffects).toEqual([]);
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
        const relay = facade.director.createRelay<DirectorMove, DirectorAcknowledgement, DirectorSnapshot>(
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
        const postLogoutEffects: string[] = [];
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                postLogoutEffects.push(`ws:${message.payload.typeId}`);
                return { status: 'enqueued', message, entries: [] };
            }
        );
        mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                postLogoutEffects.push(`rtc:${message.payload.typeId}`);
                return { status: 'enqueued', message, entries: [] };
            }
        );
        mocks.initialiseApiMiddleware.mockImplementation(async () => {
            postLogoutEffects.push('middleware:init');
            return mocks.ctx;
        });

        const results = await Promise.all([
            relay.sendHeartbeat(),
            relay.sendOutput({ ok: true }),
            relay.sendSnapshot({ revision: 2 }),
            relay.sendIntent({ move: 'dash' }),
            relay.requestSync({ reason: 'late-join' })
        ]);

        expect(results.every((result) => result.status === 'no-director')).toBe(true);
        expect(results.every((result) => result.reason === 'Auth session ended.')).toBe(true);
        expect(postLogoutEffects).toEqual([]);
    });
});

function resetDirectorTestDoubles(): void {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetDirectorRepositoryAndSessionDoubles();
    resetDirectorRtcDoubles();
    resetDirectorWsDoubles();
    resetDirectorApiDoubles();
}

function resetDirectorRepositoryAndSessionDoubles(): void {
    mocks.clientRepositoryMissing.mockImplementation(
        (principalId?: string): never => (principalId === undefined ? [] : undefined) as never
    );
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
    mocks.appointStateGroupDirector.mockRejectedValue(
        new Error('director appointment not mocked')
    );
}

function resetDirectorRtcDoubles(): void {
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
    mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(
        () => mocks.ctx.middleware.webRtcConnectionService
    );
    mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
    mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
    mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(
        async (message) => ({ status: 'enqueued', message, entries: [] })
    );
    mocks.rtcRxStreamer.onInboxMessageDo.mockReturnValue(
        mocks.ctx.middleware.rtcRxStreamer
    );
    mocks.rtcRxStreamer.removeInboxMessageCallback.mockReturnValue(true);
}

function resetDirectorWsDoubles(): void {
    mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
        async (message) => ({ status: 'enqueued', message, entries: [] })
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
}

function resetDirectorApiDoubles(): void {
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
