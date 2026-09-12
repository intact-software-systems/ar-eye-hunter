import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { newALBroadcastMessage, newALMulticastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface GroupSnapshotFixtureScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    return {
        ctx: createDefaultApiMiddlewareTestDouble(),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findFirstGroupStateSnapshotRefSessionIdIsIn>(),
        findGroupStateSnapshotByRef: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef>(),
        getAllGroupStateSnapshots: vi.fn<typeof GroupStateSnapshotsRepositoryModule.getAllGroupStateSnapshots>()
    };
});
vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), async (original): Promise<typeof MiddlewareModule> => ({
    ...await original(),
    initialiseMiddleware: async () => mocks.ctx.middleware
}));
vi.mock(import('@shared/api/auth.ts'), async (original): Promise<typeof AuthModule> => ({
    ...await original(),
    readSession: () => mocks.ctx.session,
    isLoggedIn: () => true
}));
vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), async (original): Promise<typeof GroupStateSnapshotsRepositoryModule> => ({
    ...await original(),
    findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
    getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
}));
let rtcRxStreamer = vi.mocked(mocks.ctx.middleware.rtcRxStreamer);
let webSocketQueueBox = vi.mocked(mocks.ctx.middleware.webSocketQueueBox);

interface ChatMessage {
    readonly text: string;
}

describe('Rallar typed message channel', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        configureTestCacheRepositories();
        const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
        mocks.ctx = createDefaultApiMiddlewareTestDouble();
        rtcRxStreamer = vi.mocked(mocks.ctx.middleware.rtcRxStreamer);
        webSocketQueueBox = vi.mocked(mocks.ctx.middleware.webSocketQueueBox);
        mockGroupSnapshots([]);
    });

    it('sends RTC and WS payloads through a typed message channel', async () => {
        const facade = createFacade();
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

        await channel.sendRtc(
            {
                text: 'rtc'
            },
            {
                resourceId: 'rtc-message-1'
            }
        );
        await channel.sendWs(
            {
                text: 'ws'
            },
            {
                resourceId: 'ws-message-1'
            }
        );

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'match-1',
            resourceId: 'rtc-message-1'
        });
        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].payload.typeId).toBe('chat.message.v1');
        expect(JSON.parse(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].payload.resource)).toEqual({
            text: 'rtc'
        });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0].route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'match-1',
            resourceId: 'ws-message-1'
        });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0].payload.typeId).toBe('chat.message.v1');
        expect(JSON.parse(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0].payload.resource)).toEqual({
            text: 'ws'
        });
    });

    it('reports channel definition problems through the public validation-error boundary', () => {
        expect(() => createFacade().messages.channel({ topicId: 'bad topic', typeId: '' })).toThrow(
            expect.objectContaining({
                name: 'RallarValidationError',
                issues: expect.arrayContaining([
                    expect.objectContaining({ path: '$.topicId' }),
                    expect.objectContaining({ path: '$.typeId' })
                ])
            })
        );
    });

    it('collects room and channel definition issues together', () => {
        expect(() => createFacade().messages.room({ roomId: 'bad room', topicId: 'bad topic', typeId: 'bad type' })).toThrow(
            expect.objectContaining({
                name: 'RallarValidationError',
                issues: expect.arrayContaining([
                    expect.objectContaining({ path: '$.roomId' }),
                    expect.objectContaining({ path: '$.topicId' }),
                    expect.objectContaining({ path: '$.typeId' })
                ])
            })
        );
    });

    it('rejects invalid typed message channel definitions', async () => {
        const facade = createFacade();

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
        mockRtcNoRoute();
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createFacade();
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

        await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).toHaveBeenCalledTimes(1);
        expect(result.lifecycle().state).toBe('queued');
    });

    it('applies room defaults to typed RTC and WS room message sends', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const facade = createFacade();
        const channel = facade.messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1'
        });

        await channel.sendRtc(
            { text: 'rtc' },
            { resourceId: 'rtc-room-message-1' }
        );
        await channel.sendWs(
            { text: 'ws' },
            { resourceId: 'ws-room-message-1' }
        );

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'rtc-room-message-1'
        });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0].route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'ws-room-message-1'
        });
    });

    it('uses RTC with WS fallback by default for typed room message sends', async () => {
        mockRtcNoRoute();
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createFacade();
        const channel = facade.messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1'
        });

        const result = await channel.send(
            { text: 'fallback' },
            { resourceId: 'room-fallback-1' }
        );

        await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).toHaveBeenCalledTimes(1);
        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0].route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'room-1',
            resourceId: 'room-fallback-1'
        });
    });

    it('uses WS only for typed channel send when strategy is ws', async () => {
        const facade = createFacade();
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

        await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).toHaveBeenCalledTimes(1);
    });

    it('delivers decoded payloads through typed message channel subscriptions', async () => {
        const facade = createFacade();
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

function mockRtcNoRoute(): void {
    vi.mocked(mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent)
        .mockImplementation(async (message) => ({
            status: 'no-route',
            verdict: { kind: 'unroutable' as const, reason: 'no-route' as const, detail: `No outbound transport route for message ${message.id.msgId}` },
            message,
            entries: [],
            reason: `No outbound transport route for message ${message.id.msgId}`
        }));
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
            snapshot.group.workspaceId === ref.workspaceId
        )
    );
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshots.find((snapshot) => snapshot.activeSessions.some((session) => session.sessionId === sessionId))?.group
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

function createFacade() {
    const facade = createRallarFacade();
    onTestFinished(() => facade.disconnect());
    return facade;
}
