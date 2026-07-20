import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    createActiveClientSessionFixture,
    createClientSnapshotFixture,
    createGroupSnapshotFixture,
} from './authoritative-group-fixtures.ts';
import {
    newALBroadcastMessage,
    newALEventRoute,
} from '@shared/al-contracts/al-contract.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';

const mocks = vi.hoisted(() => {
    const session = {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000,
    };
    const webSocketQueueBox = {
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
    };
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
                stopLocalMedia: vi.fn(),
                stopAllHeartbeats: vi.fn(),
            },
            webRtcGroupManager: {},
            webRtcConnectionService: {
                knownPeerIds: vi.fn((): readonly string[] => []),
                activePeerIds: vi.fn((): readonly string[] => []),
                disconnectPeer: vi.fn(() => true),
                onRtcPeerLifecycleDo: vi.fn(),
                removeRtcPeerLifecycleById: vi.fn(() => true),
            },
            heartbeat: {
                stop: vi.fn(),
            },
            webSocketQueueBox,
        },
    } as unknown as ApiMiddleware;

    return {
        ctx,
        hydrateStateCaches: vi.fn(() => Promise.resolve()),
        initMiddleware: vi.fn((_options?: unknown) => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        listStateClientEvents: vi.fn(
            (_principalId?: unknown, _scope?: unknown, _options?: unknown) =>
                Promise.reject(new Error('client events not mocked')),
        ),
        listStateClientEventPage: vi.fn(
            (_principalId?: unknown, _scope?: unknown, _options?: unknown) =>
                Promise.reject(new Error('client event page not mocked')),
        ),
        listStateGroupEvents: vi.fn(
            (_groupId?: unknown, _scope?: unknown, _options?: unknown) =>
                Promise.reject(new Error('group events not mocked')),
        ),
        listStateGroupEventPage: vi.fn(
            (_groupId?: unknown, _scope?: unknown, _options?: unknown) =>
                Promise.reject(new Error('group event page not mocked')),
        ),
        refreshStateSnapshots: vi.fn(
            (
                _scope?: unknown,
                _policies?: unknown,
            ): Promise<{
                clients: readonly ClientSnapshot[];
                groups: readonly GroupSnapshot[];
            }> => Promise.resolve({ clients: [], groups: [] }),
        ),
        readSession: vi.fn(() => session),
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
    };
});

vi.mock('@shared-web/browser/app-context.ts', () => ({
    clearMiddleware: vi.fn(),
    getMiddleware: vi.fn(() => mocks.ctx),
    initMiddleware: mocks.initMiddleware,
    isMiddlewareReady: mocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/api-integration.ts', () => ({
    listStateClientEventPage: mocks.listStateClientEventPage,
    listStateClientEvents: mocks.listStateClientEvents,
    listStateGroupEventPage: mocks.listStateGroupEventPage,
    listStateGroupEvents: mocks.listStateGroupEvents,
}));

vi.mock('@shared-web/browser/api-workflows.ts', () => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots,
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: vi.fn(() => vi.fn()),
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn(),
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

describe('Rallar rooms and people event compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
        mocks.hydrateStateCaches.mockResolvedValue(undefined);
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
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
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.ctx.middleware.webSocketQueueBox.close.mockImplementation(
            (code?: number, reason?: string) => {
                mocks.ctx.middleware.webSocketQueueBox.socket.close(code, reason);
            },
        );
        mocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.webSocketQueueBox,
        );
        mocks.ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback
            .mockReturnValue(true);
        mocks.ctx.middleware.webRtcConnectionService.onRtcPeerLifecycleDo
            .mockReturnValue(mocks.ctx.middleware.webRtcConnectionService);
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

    it('drops malformed authoritative group and client events received over WS', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const roomListener = vi.fn();
        const peopleListener = vi.fn();

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        facade.rooms.onEvent(roomListener, { roomId: 'room-1' });
        facade.people.onEvent(peopleListener, { principalId: 'alice' });
        await facade.connect();

        const wsCallback = findWsAnyMessageCallback();
        const groupEvent = createGroupEvent(
            'room-1',
            'group-event-valid',
            'member-joined',
        );
        const clientEvent = createClientEvent(
            'alice',
            'client-event-valid',
            'session-connected',
        );
        await wsCallback?.onMessage?.(toGroupStateEventMessage({
            ...groupEvent,
            actor: { kind: 'session', principalId: 'alice', sessionId: '' },
        }));
        const { requestId: omitted, ...missingRequestId } = clientEvent;
        expect(omitted).not.toBeUndefined();
        await wsCallback?.onMessage?.(toClientStateEventMessage(missingRequestId));
        await wsCallback?.onMessage?.(toGroupStateEventMessage(groupEvent));
        await wsCallback?.onMessage?.(toClientStateEventMessage(clientEvent));

        expect(roomListener).toHaveBeenCalledOnce();
        expect(roomListener.mock.calls[0]?.[0]).toEqual(groupEvent);
        expect(peopleListener).toHaveBeenCalledOnce();
        expect(peopleListener.mock.calls[0]?.[0]).toEqual(clientEvent);
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

function toGroupStateEventMessage<
    TEvent extends Readonly<{ groupId: string; eventId: string }>,
>(
    event: TEvent,
) {
    return newALBroadcastMessage(
        'server-1',
        newALEventRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
        'all',
        AppTopics.groupStateEvent,
        event,
    );
}

function toClientStateEventMessage<
    TEvent extends Readonly<{ principalId: string; eventId: string }>,
>(
    event: TEvent,
) {
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
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        occurredAtEpochMs: scope.occurredAtEpochMs ?? 1,
        actor: {
            kind: 'session',
            principalId: 'alice',
            sessionId: 'session-1',
        },
        reason: null,
        traceId: null,
        requestId: `request-${eventId}`,
        payload: {},
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
            kind: 'session',
            principalId,
            sessionId: `${principalId}-session`,
        },
        reason: null,
        traceId: null,
        requestId: `request-${eventId}`,
        payload: {},
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
    const snapshot = createClientSnapshotFixture({
        applicationId,
        workspaceId,
        principalId,
    });
    return {
        ...snapshot,
        principal: {
            ...snapshot.principal,
        },
        activeSessions: [createActiveClientSessionFixture({
            applicationId,
            workspaceId,
            principalId,
            clientInstanceId: `${principalId}-instance`,
            sessionId,
        })],
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
    return createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds,
    });
}
