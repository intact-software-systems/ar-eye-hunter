import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import {
    createRallarFacade,
    type RallarRoomMessageChannelDefinition,
    type RallarTypedMessageChannelDefinition
} from '@shared-web/browser/rallar.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute
} from '@shared/al-contracts/al-contract.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface GroupSnapshotFixtureScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    return {
        apiMiddleware: createDefaultApiMiddlewareTestDouble(),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findFirstGroupStateSnapshotRefSessionIdIsIn>(),
        findGroupStateSnapshotByRef: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef>(),
        getAllGroupStateSnapshots: vi.fn<typeof GroupStateSnapshotsRepositoryModule.getAllGroupStateSnapshots>()
    };
});
vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), async (original): Promise<typeof MiddlewareModule> => ({
    ...await original(),
    initialiseMiddleware: async () => mocks.apiMiddleware.middleware
}));
vi.mock(import('@shared/api/auth.ts'), async (original): Promise<typeof AuthModule> => ({
    ...await original(),
    readSession: () => mocks.apiMiddleware.session,
    isLoggedIn: () => true
}));
vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), async (original): Promise<typeof GroupStateSnapshotsRepositoryModule> => ({
    ...await original(),
    findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
    getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
}));
let rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
let webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);

interface ReceivedChatMessage {
    readonly payload: ChatMessage;
    readonly transport: string;
}

interface ChatMessage {
    readonly text: string;
}

describe('Rallar typed message channel', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        configureTestCacheRepositories();
        const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
        mocks.apiMiddleware = createDefaultApiMiddlewareTestDouble();
        rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
        webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);
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
            typeId: 'chat.message.v1',
            purpose: 'notification'
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

        const rtcMessage = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0];
        const wsMessage = webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0];
        expect(rtcMessage.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'match-1',
            resourceId: 'rtc-message-1'
        });
        expect(rtcMessage.payload.typeId).toBe('chat.message.v1');
        expect(JSON.parse(rtcMessage.payload.resource)).toEqual({
            text: 'rtc'
        });
        expect(wsMessage.route).toMatchObject({
            topicId: 'room.chat',
            contextId: 'match-1',
            resourceId: 'ws-message-1'
        });
        expect(wsMessage.payload.typeId).toBe('chat.message.v1');
        expect(JSON.parse(wsMessage.payload.resource)).toEqual({
            text: 'ws'
        });
    });

    it('reports channel definition problems through the public validation-error boundary', () => {
        expect(() => createFacade().messages.channel({ topicId: 'bad topic', typeId: '', purpose: 'notification' })).toThrow(
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
        expect(() =>
            createFacade().messages.room({
                roomId: 'bad room',
                topicId: 'bad topic',
                typeId: 'bad type',
                purpose: 'notification'
            })
        ).toThrow(
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
                typeId: 'chat.message.v1',
                purpose: 'notification'
            })
        ).toThrow('$.topicId');
        expect(() =>
            facade.messages.room({
                topicId: 'room.chat',
                typeId: 'chat message',
                roomId: 'room-1',
                purpose: 'notification'
            })
        ).toThrow('$.typeId');
        expect(() =>
            facade.messages.room({
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
                roomId: 'bad room',
                purpose: 'notification'
            })
        ).toThrow('$.roomId');
    });

    it('falls back to WS through typed channel send when RTC has no route', async () => {
        mockRtcNoRoute();
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1']));
        const facade = createFacade();
        const channel = facade.messages.channel<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            purpose: 'notification'
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
        expect(result.lifecycle()).toMatchObject({
            state: 'queued',
            evidence: {
                admittedDurable: true,
                attempts: expect.arrayContaining([expect.objectContaining({ carrier: 'rtc', unroutableReason: 'no-route' })])
            }
        });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
            id: expect.objectContaining({ msgId: result.msgId }),
            route: { topicId: 'room.chat', contextId: 'room-1', resourceId: 'fallback-1' },
            payload: expect.objectContaining({ typeId: 'chat.message.v1', resource: '{"text":"fallback"}' }),
            targets: expect.objectContaining({
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }
            })
        }));
    });

    it('applies room defaults to typed RTC and WS room message sends', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const facade = createFacade();
        const channel = facade.messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1',
            purpose: 'notification'
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
            roomId: 'room-1',
            purpose: 'notification'
        });

        const result = await channel.send(
            { text: 'fallback' },
            { resourceId: 'room-fallback-1' }
        );

        await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(result.lifecycle()).toMatchObject({
            state: 'queued',
            evidence: {
                admittedDurable: true,
                attempts: expect.arrayContaining([expect.objectContaining({ carrier: 'rtc', unroutableReason: 'no-route' })])
            }
        });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
            id: expect.objectContaining({ msgId: result.msgId }),
            route: { topicId: 'room.chat', contextId: 'room-1', resourceId: 'room-fallback-1' },
            payload: expect.objectContaining({ typeId: 'chat.message.v1', resource: '{"text":"fallback"}' }),
            targets: expect.objectContaining({
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }
            })
        }));
    });

    it('uses WS only for typed channel send when strategy is ws', async () => {
        const facade = createFacade();
        const channel = facade.messages.channel<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            purpose: 'notification'
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
        expect(result.lifecycle()).toMatchObject({ state: 'queued', evidence: { admittedDurable: true } });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
            id: expect.objectContaining({ msgId: result.msgId }),
            route: { topicId: 'room.chat', contextId: 'all', resourceId: 'ws-only-1' },
            payload: expect.objectContaining({ typeId: 'chat.message.v1', resource: '{"text":"ws only"}' }),
            targets: expect.objectContaining({ mode: 'broadcast', scope: 'all' })
        }));
        expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
    });

    it('delivers decoded payloads only while typed message channel subscriptions are active', async () => {
        const rtcCallbacks = new Map<string, Parameters<typeof rtcRxStreamer.onInboxMessageDo>[1]>();
        const wsCallbacks = new Map<string, Parameters<typeof webSocketQueueBox.onAnyInboxMessageDo>[1]>();
        rtcRxStreamer.onInboxMessageDo.mockImplementation((id, callback) => {
            rtcCallbacks.set(id, callback);
            return rtcRxStreamer;
        });
        rtcRxStreamer.removeInboxMessageCallback.mockImplementation((id) => rtcCallbacks.delete(id));
        webSocketQueueBox.onAnyInboxMessageDo.mockImplementation((id, callback) => {
            wsCallbacks.set(id, callback);
            return webSocketQueueBox;
        });
        webSocketQueueBox.removeAnyInboxMessageCallback.mockImplementation((id) => wsCallbacks.delete(id));
        const facade = createFacade();
        const channel = facade.messages.channel<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            purpose: 'notification'
        });
        const received: ReceivedChatMessage[] = [];
        const unsubscribeRtc = channel.onRtc((payload, event) => {
            received.push({ payload, transport: event.transport });
        });
        const unsubscribeWs = channel.onWs((payload, event) => {
            received.push({ payload, transport: event.transport });
        });
        await facade.connect();

        const deliverFrames = async () => {
            const rtcMessage = newALMulticastMessage(
                'peer-1',
                newALRoute('room.chat', 'match-1', 'rtc-message-1'),
                { applicationId: 'game-app', workspaceId: 'arena-1', groupId: 'match-1' },
                'chat.message.v1',
                { text: 'rtc' }
            );
            for (const callback of rtcCallbacks.values()) {
                await callback.onMessage(rtcMessage, toResourceEntry('chat.message.v1', { text: 'rtc' }));
            }
            const wsMessage = newALBroadcastMessage(
                'peer-1',
                newALRoute('room.chat', 'match-1', 'ws-message-1'),
                'room',
                'chat.message.v1',
                { text: 'ws' }
            );
            for (const callback of wsCallbacks.values()) {
                await callback.onMessage(wsMessage, toResourceEntry('chat.message.v1', { text: 'ws' }));
            }
        };
        await deliverFrames();
        expect(received).toEqual([
            { payload: { text: 'rtc' }, transport: 'rtc' },
            { payload: { text: 'ws' }, transport: 'ws' }
        ]);

        unsubscribeRtc();
        unsubscribeWs();
        await deliverFrames();
        expect(received).toEqual([
            { payload: { text: 'rtc' }, transport: 'rtc' },
            { payload: { text: 'ws' }, transport: 'ws' }
        ]);
    });

    it('builds a notification room send receipted, at-least-once and volatile with no options', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const channel = createFacade().messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1',
            purpose: 'notification'
        });

        const handle = await channel.send({ text: 'default' }, { resourceId: 'purpose-default-1' });
        await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });

        const message = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0];
        expect(message.delivery).toEqual({
            ownership: 'shared',
            reliability: 'at-least-once',
            ack: 'all-logical-recipients'
        });
        expect(message.qos?.durability).toEqual({ algo: 'volatile' });
        // The builder reads the clock once for the id and once for the deadline.
        expect(message.constraints?.expiresAtMs).toBeGreaterThanOrEqual(message.id.ts + 30_000);
        expect(message.constraints?.expiresAtMs).toBeLessThan(message.id.ts + 30_050);
    });

    it('asks the addressed receiver for a command and keeps the channel durability opt-in', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const channel = createFacade().messages.room<ChatMessage>({
            topicId: 'room.command',
            typeId: 'room.command.v1',
            roomId: 'room-1',
            purpose: 'command',
            durability: 'local-outbox'
        });

        await channel.sendRtc({ text: 'command' }, { resourceId: 'purpose-command-1' });

        const message = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0];
        expect(message.delivery?.ack).toBe('receiver');
        expect(message.qos?.durability).toEqual({ algo: 'local-outbox' });
    });

    it('lets every per-send option override the purpose', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const channel = createFacade().messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1',
            purpose: 'notification'
        });

        await channel.sendRtc({ text: 'override' }, {
            resourceId: 'purpose-override-1',
            reliability: 'best-effort',
            ack: 'none',
            ttlMs: 5_000,
            qos: { durability: { algo: 'local-inbox' } }
        });

        const message = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0];
        expect(message.delivery).toMatchObject({ reliability: 'best-effort', ack: 'none' });
        expect(message.qos?.durability).toEqual({ algo: 'local-inbox' });
        expect(message.constraints?.expiresAtMs).toBeGreaterThanOrEqual(message.id.ts + 5_000);
        expect(message.constraints?.expiresAtMs).toBeLessThan(message.id.ts + 5_050);
    });

    it('drops the purpose receipt from a best-effort send that names no ack, and keeps an ack it names', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const channel = createFacade().messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1',
            purpose: 'notification'
        });

        await channel.sendRtc({ text: 'fire and forget' }, { resourceId: 'best-effort-1', reliability: 'best-effort' });
        await channel.sendRtc({ text: 'stated ack' }, {
            resourceId: 'best-effort-2',
            reliability: 'best-effort',
            ack: 'receiver'
        });

        const [unstated, stated] = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls.map(([message]) => message);
        expect(unstated.delivery).toMatchObject({ reliability: 'best-effort', ack: 'none' });
        expect(stated.delivery).toMatchObject({ reliability: 'best-effort', ack: 'receiver' });
    });

    it('keeps no receipt on a world broadcast, whose audience A1 owns', async () => {
        const channel = createFacade().messages.channel<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            purpose: 'notification'
        });

        await channel.sendWs({ text: 'everyone' }, { scope: 'all', resourceId: 'purpose-all-1' });

        const message = webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0];
        expect(message.delivery).toMatchObject({ reliability: 'at-least-once', ack: 'none' });
        expect(message.qos?.durability).toEqual({ algo: 'volatile' });
    });

    it('refuses a realtime, a missing or an unknown purpose and an unknown durability at the channel', () => {
        const facade = createFacade();
        const define = (definition: object) => () => facade.messages.channel(definition as Parameters<typeof facade.messages.channel>[0]);

        expect(define({ typeId: 'chat.message.v1', purpose: 'realtime' })).toThrow(
            expect.objectContaining({
                issues: [expect.objectContaining({ path: '$.purpose', code: 'unsupported' })]
            })
        );
        expect(define({ typeId: 'chat.message.v1' })).toThrow(expect.objectContaining({
            issues: [expect.objectContaining({ path: '$.purpose', code: 'invalid-purpose' })]
        }));
        expect(define({ typeId: 'chat.message.v1', purpose: 'broadcast' })).toThrow(
            expect.objectContaining({
                issues: [expect.objectContaining({ path: '$.purpose', code: 'invalid-purpose' })]
            })
        );
        expect(define({ typeId: 'chat.message.v1', purpose: 'command', durability: 'forever' }))
            .toThrow(
                expect.objectContaining({
                    issues: [
                        expect.objectContaining({ path: '$.durability', code: 'invalid-durability' })
                    ]
                })
            );
    });

    it('fixes the channel policy at creation, so a definition changed afterwards changes nothing', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const facade = createFacade();
        const channelDefinition: RallarTypedMessageChannelDefinition = {
            topicId: 'room.command',
            typeId: 'room.command.v1',
            purpose: 'command'
        };
        const roomDefinition: RallarRoomMessageChannelDefinition = {
            topicId: 'room.command',
            typeId: 'room.command.v1',
            roomId: 'room-1',
            purpose: 'command',
            durability: 'local-outbox'
        };
        const channel = facade.messages.channel<ChatMessage>(channelDefinition);
        const room = facade.messages.room<ChatMessage>(roomDefinition);
        // A JavaScript caller can write anything onto the object it passed in.
        Object.assign(channelDefinition, { purpose: 'notification' });
        Object.assign(roomDefinition, { purpose: 'bogus', durability: 'forever' });

        await channel.sendRtc({ text: 'channel' }, { roomId: 'room-1', resourceId: 'purpose-fixed-1' });
        await room.sendRtc({ text: 'room' }, { resourceId: 'purpose-fixed-2' });

        const [channelMessage, roomMessage] = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls.map(([message]) => message);
        expect(channelMessage.delivery?.ack).toBe('receiver');
        expect(channelMessage.qos?.durability).toEqual({ algo: 'volatile' });
        expect(roomMessage.delivery?.ack).toBe('receiver');
        expect(roomMessage.qos?.durability).toEqual({ algo: 'local-outbox' });
    });

    it('retires the realtime send strategy', async () => {
        const channel = createFacade().messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1',
            purpose: 'notification'
        });

        await expect(channel.send({ text: 'x' }, { strategy: 'realtime' as never })).rejects
            .toMatchObject({
                name: 'RallarValidationError',
                issues: [expect.objectContaining({ path: '$.strategy', code: 'unsupported' })]
            });
    });
});

function mockRtcNoRoute(): void {
    vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent)
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
