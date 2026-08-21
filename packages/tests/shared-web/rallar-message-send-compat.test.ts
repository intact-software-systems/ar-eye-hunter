import type * as ApiIntegrationModule from '@shared-web/browser/api-integration.ts';
import type * as ApiWorkflowsModule from '@shared-web/browser/api-workflows.ts';
import type * as AppContextModule from '@shared-web/browser/app-context.ts';
import type * as AuthApiModule from '@shared-web/browser/auth/session-http-api.ts';
import type * as DataCachesModule from '@shared-web/browser/data-caches.ts';
import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';
import type * as ClientStateSnapshotsRepositoryModule from '@shared/repository/client-state-snapshots-repository.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/WebRtcConnectionService.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveGroupMemberFixture, createActiveGroupPresenceSessionFixture, createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

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

// The `Partial<typeof …Module>` return annotation is what makes these factories load-bearing: it
// turns a renamed or removed production export into a compile error here instead of a silently
// undefined mock member.
vi.mock(
    import('@shared-web/browser/app-context.ts'),
    (): Partial<typeof AppContextModule> => ({
        clearMiddleware: mocks.clearMiddleware,
        getMiddleware: vi.fn<typeof AppContextModule.getMiddleware>(
            () => mocks.ctx
        ),
        initMiddleware: mocks.initMiddleware,
        isMiddlewareReady: mocks.isMiddlewareReady
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

describe('Rallar message send compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        mocks.findClientStateSnapshotByPrincipalId.mockImplementation(
            mocks.readMissingClientStateSnapshotRepository
        );
        mocks.getAllClientStateSnapshots.mockImplementation(
            mocks.readMissingClientStateSnapshotRepository
        );
        mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation(
            mocks.readMissingGroupStateSnapshotRepository
        );
        mocks.findGroupStateSnapshotByRef.mockImplementation(
            mocks.readMissingGroupStateSnapshotRepository
        );
        mocks.getAllGroupStateSnapshots.mockImplementation(
            mocks.readMissingGroupStateSnapshotRepository
        );
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

    it('rejects invalid WS user topics before queueing', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );

        await expect(
            createRallarFacade().messages.ws.send({
                scope: 'all',
                topicId: 'manual.chat',
                typeId: 'chat.message.v1',
                payload: { text: 'invalid topic' }
            })
        ).rejects.toSatisfy(isRallarValidationError);

        expect(webSocketQueueBox.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
    });

    it('rejects room-scoped WS sends without a room target before queueing', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );

        await expect(
            createRallarFacade().messages.ws.send({
                scope: 'room',
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
                payload: { text: 'missing room' }
            })
        ).rejects.toSatisfy(isRallarValidationError);

        expect(webSocketQueueBox.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
    });

    it('rejects invalid RTC room ids before connecting or queueing', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );

        await expect(
            createRallarFacade().messages.rtc.send({
                roomId: 'bad room',
                typeId: 'chat.message.v1',
                payload: { text: 'invalid room' }
            })
        ).rejects.toSatisfy(isRallarValidationError);

        expect(mocks.initMiddleware).not.toHaveBeenCalled();
        expect(rtcRxStreamer.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
    });

    it('rejects corrupt and oversized message payloads before queueing', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            messages: {
                maxPayloadBytes: 8
            }
        });

        await expect(facade.messages.ws.send({
            scope: 'all',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            payload: 1n
        })).rejects.toSatisfy(isRallarValidationError);
        await expect(facade.messages.ws.send({
            scope: 'all',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            payload: { text: 'too large' }
        })).rejects.toSatisfy(isRallarValidationError);

        expect(webSocketQueueBox.enqueueOutboxIfAbsent)
            .not.toHaveBeenCalled();
    });

    it('returns RTC send status with the message when multicast enqueue reports no entries', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'no-route',
                message,
                entries: [],
                reason: 'Skipping RTC outbound dispatch without planned transport messages'
            })
        );
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        mockGroupSnapshot(room);

        const result = await createRallarFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-quiet',
            payload: {
                text: 'quiet outcome'
            }
        });

        expect(rtcRxStreamer.enqueueOutboxIfAbsent)
            .toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            transport: 'rtc',
            status: 'no-route',
            reason: 'Skipping RTC outbound dispatch without planned transport messages',
            entries: [],
            message: {
                id: {
                    senderId: 'session-1'
                },
                route: {
                    topicId: 'chat.message.v1',
                    resourceId: 'msg-quiet',
                    contextId: 'room-1'
                },
                targets: {
                    mode: 'multicast',
                    groupRef: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'room-1'
                    }
                },
                forwarding: {
                    overlayId: toScopedOverlayId(room.group)
                }
            }
        });
    });

    it('wakes the queue-box engine when RTC send queues durable outbox work', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'enqueued',
                message,
                entries: []
            })
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));

        await createRallarFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-queued-rtc',
            payload: {
                text: 'queued rtc'
            }
        });

        expect(qboxEngine.wake).toHaveBeenCalledOnce();
    });

    it('adds cached room snapshotVersion as minSnapshotVersion on RTC room sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(withSnapshotVersion(
            createGroupSnapshot('room-1', ['session-1', 'peer-1']),
            7
        ));

        const result = await createRallarFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-rtc',
            payload: {
                text: 'versioned rtc'
            }
        });

        expect(result.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            minSnapshotVersion: 7
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
                    workspaceId: 'workspace-a'
                }
            ),
            7
        );
        const workspaceB = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-b'],
                {
                    workspaceId: 'workspace-b'
                }
            ),
            11
        );
        mockGroupSnapshots([workspaceA, workspaceB]);

        const result = await createRallarFacade().messages.rtc.send({
            roomId: 'shared-room',
            roomRef: workspaceB.group,
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-rtc-scoped',
            payload: {
                text: 'versioned scoped rtc'
            }
        });

        expect(result.message.targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId: 'shared-room'
            },
            minSnapshotVersion: 11
        });
        expect(result.message.targets).not.toHaveProperty('groupId');
    });

    it('returns WS send status with the message when WS enqueue completes', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'sent-immediate',
                message,
                entries: []
            })
        );

        const result = await createRallarFacade().messages.ws.send({
            scope: 'all',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-ws',
            payload: {
                text: 'ws outcome'
            }
        });

        expect(webSocketQueueBox.enqueueOutboxIfAbsent)
            .toHaveBeenCalledOnce();
        expect(qboxEngine.wake).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            transport: 'ws',
            status: 'sent-immediate',
            entries: [],
            message: {
                id: {
                    senderId: 'session-1'
                },
                route: {
                    topicId: 'app.chat',
                    resourceId: 'msg-ws',
                    contextId: 'all'
                },
                targets: {
                    mode: 'broadcast',
                    scope: 'all'
                }
            }
        });
    });

    it('wakes the queue-box engine when WS send queues durable outbox work', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'enqueued',
                message,
                entries: []
            })
        );

        await createRallarFacade().messages.ws.send({
            scope: 'all',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-queued-ws',
            payload: {
                text: 'queued ws'
            }
        });

        expect(qboxEngine.wake).toHaveBeenCalledOnce();
    });

    it('adds cached room snapshotVersion as minSnapshotVersion on WS room sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(withSnapshotVersion(
            createGroupSnapshot('room-1', ['session-1', 'peer-1']),
            11
        ));

        const result = await createRallarFacade().messages.ws.send({
            roomId: 'room-1',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-ws',
            payload: {
                text: 'versioned ws'
            }
        });

        expect(result.message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            minSnapshotVersion: 11
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
                    workspaceId: 'workspace-a'
                }
            ),
            5
        );
        const workspaceB = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-b'],
                {
                    workspaceId: 'workspace-b'
                }
            ),
            13
        );
        mockGroupSnapshots([workspaceA, workspaceB]);

        const result = await createRallarFacade().messages.ws.send({
            roomId: 'shared-room',
            roomRef: workspaceB.group,
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-ws-scoped',
            payload: {
                text: 'versioned scoped ws'
            }
        });

        expect(result.message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId: 'shared-room'
            },
            minSnapshotVersion: 13
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
