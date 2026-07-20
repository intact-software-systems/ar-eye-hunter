import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
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
    const webRtcConnectionService = {
        peerIdsWithNoReconnectableLanes: vi.fn((): readonly string[] => []),
        knownPeerIds: vi.fn((): readonly string[] => []),
        activePeerIds: vi.fn((): readonly string[] => []),
        readyPeerIdsForLane: vi.fn((_laneId?: string): readonly string[] => []),
        ensurePeerConnectionStarted: vi.fn((_peerId: string) => ({
            left: {
                kind: 'connect-failed',
                peerId: _peerId,
                error: new Error('connect not mocked'),
            },
        })),
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
        hydrateStateCaches: vi.fn(() => Promise.resolve()),
        initMiddleware: vi.fn((_options?: unknown) => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        onStateCacheChange: vi.fn(() => vi.fn()),
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
        webRtcConnectionService,
    };
});

vi.mock('@shared-web/browser/app-context.ts', () => ({
    clearMiddleware: vi.fn(),
    getMiddleware: vi.fn(() => mocks.ctx),
    initMiddleware: mocks.initMiddleware,
    isMiddlewareReady: mocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: mocks.onStateCacheChange,
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

describe('Rallar typed message channel compatibility', () => {
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
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
            (peerId: string) => ({
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
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockReturnValue(
            mocks.webRtcConnectionService,
        );
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
        mocks.ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo
            .mockReturnValue(mocks.ctx.middleware.webSocketQueueBox.socket);
        mocks.ctx.middleware.webSocketQueueBox.socket.removeWebsocketCallbackById
            .mockReturnValue(true);
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

    it('rejects invalid typed message channel definitions', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        expect(() =>
            facade.messages.channel({
                topicId: 'room chat',
                typeId: 'chat.message.v1',
            })
        ).toThrow('$.topicId');
        expect(() =>
            facade.messages.room({
                topicId: 'room.chat',
                typeId: 'chat message',
                roomId: 'room-1',
            })
        ).toThrow('$.typeId');
        expect(() =>
            facade.messages.room({
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
                roomId: 'bad room',
            })
        ).toThrow('$.roomId');
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

    it('applies room defaults to typed RTC and WS room message sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const facade = createRallarFacade();
        const channel = facade.messages.room<{ text: string }>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1',
        });

        const rtcResult = await channel.sendRtc(
            { text: 'rtc' },
            { resourceId: 'rtc-room-message-1' },
        );
        const wsResult = await channel.sendWs(
            { text: 'ws' },
            { resourceId: 'ws-room-message-1' },
        );

        expect(rtcResult.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'rtc-room-message-1',
        });
        expect(wsResult.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'ws-room-message-1',
        });
    });

    it('uses RTC with WS fallback by default for typed room message sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();
        const channel = facade.messages.room<{ text: string }>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1',
        });

        const result = await channel.send(
            { text: 'fallback' },
            { resourceId: 'room-fallback-1' },
        );

        expect(result.transport).toBe('ws');
        expect(result.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'room-fallback-1',
        });
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
});

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
