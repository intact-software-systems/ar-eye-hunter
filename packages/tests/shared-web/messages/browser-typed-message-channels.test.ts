import { newALBroadcastMessage, newALMulticastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type MiddlewareModule = typeof import('@shared-web/browser/middleware.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

interface ChatMessage {
    readonly text: string;
}

interface GroupSnapshotFixtureScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        '../api-middleware-test-double.ts'
    );
    const ctx = createApiMiddlewareTestDouble();
    const clientRepositoryMissing = (): never => {
        throw new Error(
            'Repository not found: shared.repository.client-state-snapshots'
        );
    };
    const groupRepositoryMissing = (): never => {
        throw new Error(
            'Repository not found: shared.repository.group-state-snapshots'
        );
    };

    return {
        ctx,
        webRtcConnectionService: ctx.middleware.webRtcConnectionService,
        clientRepositoryMissing,
        groupRepositoryMissing,
        hydrateStateCache: vi.fn((): Promise<void> => Promise.resolve()),
        initMiddleware: vi.fn(() => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        onCacheChange: vi.fn((): () => void => vi.fn()),
        readSession: vi.fn((): AuthSession | undefined => ctx.session),
        findClientStateSnapshotByPrincipalId: vi.fn(
            (_principalId: string): ClientSnapshot | undefined => clientRepositoryMissing()
        ),
        getAllClientStateSnapshots: vi.fn(
            (): ClientSnapshot[] => clientRepositoryMissing()
        ),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn(
            (_sessionId: string): GroupRef | undefined => groupRepositoryMissing()
        ),
        findGroupStateSnapshotByRef: vi.fn(
            (_ref: GroupRef): GroupSnapshot | undefined => groupRepositoryMissing()
        ),
        getAllGroupStateSnapshots: vi.fn(
            (): GroupSnapshot[] => groupRepositoryMissing()
        )
    };
});

vi.mock(import('@shared-web/browser/middleware.ts'), (): Partial<MiddlewareModule> => ({
    initialiseMiddleware: async () => (await mocks.initMiddleware()).middleware
}));

vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), (): Partial<StateCacheLifecycleModule> => ({
    browserStateCacheLifecycle: {
        hydrate: mocks.hydrateStateCache,
        onChange: mocks.onCacheChange,
        initialise: vi.fn()
    }
}));

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn()
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
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

describe('Rallar typed message channel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRepositoryDoublesToMissing();
        resetMiddlewareDoublesToDefaults();
        mocks.hydrateStateCache.mockResolvedValue(undefined);
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
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
                roomId: 'match-1'
            }
        });
        const channel = facade.messages.channel<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1'
        });

        const rtcResult = await channel.sendRtc(
            {
                text: 'rtc'
            },
            {
                resourceId: 'rtc-message-1'
            }
        );
        const wsResult = await channel.sendWs(
            {
                text: 'ws'
            },
            {
                resourceId: 'ws-message-1'
            }
        );

        expect(rtcResult.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'match-1',
            resourceId: 'rtc-message-1'
        });
        expect(rtcResult.message.payload.typeId).toBe('chat.message.v1');
        expect(JSON.parse(rtcResult.message.payload.resource)).toEqual({
            text: 'rtc'
        });
        expect(wsResult.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'match-1',
            resourceId: 'ws-message-1'
        });
        expect(wsResult.message.payload.typeId).toBe('chat.message.v1');
        expect(JSON.parse(wsResult.message.payload.resource)).toEqual({
            text: 'ws'
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
                typeId: 'chat.message.v1'
            })
        ).toThrow('$.topicId');
        expect(() =>
            facade.messages.room({
                topicId: 'room.chat',
                typeId: 'chat message',
                roomId: 'room-1'
            })
        ).toThrow('$.typeId');
        expect(() =>
            facade.messages.room({
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
                roomId: 'bad room'
            })
        ).toThrow('$.roomId');
    });

    it('falls back to WS through typed channel send when RTC has no route', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();
        const channel = facade.messages.channel<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1'
        });

        const result = await channel.send(
            {
                text: 'fallback'
            },
            {
                strategy: 'rtc-with-ws-fallback',
                roomId: 'room-1',
                resourceId: 'fallback-1'
            }
        );

        expect(result.transport).toBe('ws');
        expect(result.status).toBe('enqueued');
    });

    it('applies room defaults to typed RTC and WS room message sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const facade = createRallarFacade();
        const channel = facade.messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1'
        });

        const rtcResult = await channel.sendRtc(
            { text: 'rtc' },
            { resourceId: 'rtc-room-message-1' }
        );
        const wsResult = await channel.sendWs(
            { text: 'ws' },
            { resourceId: 'ws-room-message-1' }
        );

        expect(rtcResult.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'rtc-room-message-1'
        });
        expect(wsResult.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'ws-room-message-1'
        });
    });

    it('uses RTC with WS fallback by default for typed room message sends', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createRallarFacade();
        const channel = facade.messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1'
        });

        const result = await channel.send(
            { text: 'fallback' },
            { resourceId: 'room-fallback-1' }
        );

        expect(result.transport).toBe('ws');
        expect(result.message.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'room-fallback-1'
        });
    });

    it('uses WS only for typed channel send when strategy is ws', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const channel = facade.messages.channel<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1'
        });

        const result = await channel.send(
            {
                text: 'ws only'
            },
            {
                strategy: 'ws',
                scope: 'all',
                resourceId: 'ws-only-1'
            }
        );

        expect(result.transport).toBe('ws');
    });

    it('delivers decoded payloads through typed message channel subscriptions', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const channel = facade.messages.channel<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1'
        });
        const onRtc = vi.fn();
        const onWs = vi.fn();

        channel.onRtc(onRtc);
        channel.onWs(onWs);
        await facade.connect();

        const rtcCallback = vi.mocked(
            mocks.ctx.middleware.rtcRxStreamer.onInboxMessageDo
        ).mock.calls.find(([typeId]) => typeId === 'chat.message.v1')?.[1];
        const wsCallback = vi.mocked(
            mocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo
        ).mock.calls.find(([callbackId]) => callbackId === 'rallar:ws:any-message')?.[1];

        await rtcCallback?.onMessage(
            newALMulticastMessage(
                'peer-1',
                newALRoute('room.chat', 'match-1', 'rtc-message-1'),
                {
                    applicationId: 'game-app',
                    workspaceId: 'arena-1',
                    groupId: 'match-1'
                },
                'chat.message.v1',
                {
                    text: 'rtc'
                }
            ),
            toResourceEntry('chat.message.v1', { text: 'rtc' })
        );
        await wsCallback?.onMessage(
            newALBroadcastMessage(
                'peer-1',
                newALRoute('room.chat', 'match-1', 'ws-message-1'),
                'room',
                'chat.message.v1',
                {
                    text: 'ws'
                }
            ),
            toResourceEntry('chat.message.v1', { text: 'ws' })
        );

        expect(onRtc).toHaveBeenCalledWith(
            {
                text: 'rtc'
            },
            expect.objectContaining({
                payload: {
                    text: 'rtc'
                },
                transport: 'rtc'
            })
        );
        expect(onWs).toHaveBeenCalledWith(
            {
                text: 'ws'
            },
            expect.objectContaining({
                payload: {
                    text: 'ws'
                },
                transport: 'ws'
            })
        );
    });
});

function resetRepositoryDoublesToMissing(): void {
    mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
    mocks.getAllClientStateSnapshots.mockReturnValue([]);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
}

function resetMiddlewareDoublesToDefaults(): void {
    const { rtcRxStreamer, webRtcConnectionService, webSocketQueueBox } = mocks.ctx.middleware;
    vi.mocked(webRtcConnectionService.ensurePeerConnectionStarted).mockReset();
    vi.mocked(webRtcConnectionService.ensurePeerLaneOpen).mockReset();
    vi.mocked(webRtcConnectionService.onRtcPeerLifecycleDo).mockReset();
    vi.mocked(rtcRxStreamer.enqueueOutboxIfAbsent).mockReset();
    vi.mocked(rtcRxStreamer.onInboxMessageDo).mockReset();
    vi.mocked(rtcRxStreamer.removeInboxMessageCallback).mockReset();
    vi.mocked(webSocketQueueBox.enqueueOutboxIfAbsent).mockReset();
    vi.mocked(webSocketQueueBox.onAnyInboxMessageDo).mockReset();
    vi.mocked(webSocketQueueBox.removeAnyInboxMessageCallback).mockReset();
    vi.mocked(webSocketQueueBox.socket.onWebsocketCallbacksDo).mockReset();
    vi.mocked(webSocketQueueBox.socket.removeWebsocketCallbackById).mockReset();
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
        snapshots.find((snapshot) => sessionId === snapshot.group.groupId)?.group
    );
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: GroupSnapshotFixtureScope = {}
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
