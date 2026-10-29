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
    newALRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';

const rtcCaptureReceipt = await vi.hoisted(async () => (await import('../rtc/browser-rtc-capture-fixture.ts')).createBrowserRtcCaptureReceiptFixture());

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
    initialiseMiddleware: async () => ({ middleware: mocks.apiMiddleware.middleware, rtcCaptureReceipt, checkpoints: [] })
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

const LIVE_PUBLICATION: ALPublicationPolicy = { cadenceMs: 500, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } };

installFakeBroadcastChannelPerTest();

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

    it('sends a command channel\'s WS send to one peer as a receipted room unicast (Q11, Relic\'s call)', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const channel = createFacade().messages.room<ChatMessage>({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomId: 'room-1',
            purpose: 'command'
        });

        await channel.sendWs({ text: 'to the server' }, { peerId: 'server-peer' });

        const message = webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0];
        // The room channel adds only its route: a default it injected (a snapshot floor) would be refused on a peer send.
        expect(message.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'server-peer',
            groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }
        });
        expect(message.route).toMatchObject({ topicId: 'room.chat', contextId: 'room-1' });
        expect(message.delivery).toMatchObject({ reliability: 'at-least-once', ack: 'receiver' });
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
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            purpose: 'notification'
        });

        const result = await channel.send(
            {
                text: 'ws only'
            },
            {
                strategy: 'ws',
                scope: 'world',
                resourceId: 'ws-only-1'
            }
        );

        await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(result.lifecycle()).toMatchObject({ state: 'queued', evidence: { admittedDurable: true } });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
            id: expect.objectContaining({ msgId: result.msgId }),
            route: { topicId: 'app.chat', contextId: 'world', resourceId: 'ws-only-1' },
            payload: expect.objectContaining({ typeId: 'chat.message.v1', resource: '{"text":"ws only"}' }),
            targets: expect.objectContaining({ mode: 'broadcast', scope: 'world' })
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
        expect(message.constraints?.expiresAtMs).toBe(message.id.ts + 30_000);
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
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            purpose: 'notification'
        });

        await channel.sendWs({ text: 'everyone' }, { scope: 'world', resourceId: 'purpose-all-1' });

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
                        expect.objectContaining({
                            path: '$.durability',
                            code: 'invalid-durability',
                            message: 'Durability must be volatile, local-checkpoint, local-outbox or local-inbox.'
                        })
                    ]
                })
            );
        expect(define({ typeId: 'chat.message.v1', purpose: 'command', durability: 'local-checkpoint' })).not.toThrow();
        expect(define({ typeId: 'chat.message.v1', purpose: 'command', onStorageUnavailable: 'drop' })).toThrow(
            expect.objectContaining({
                issues: [
                    expect.objectContaining({ path: '$.onStorageUnavailable', code: 'invalid-on-storage-unavailable' })
                ]
            })
        );
    });

    it('refuses a live channel without a publication, a publication on another purpose and a live durability other than volatile', () => {
        const facade = createFacade();
        const define = (definition: object) => () => facade.messages.channel(definition as Parameters<typeof facade.messages.channel>[0]);
        const refusing = (path: string, code: string) => expect.objectContaining({ issues: [expect.objectContaining({ path, code })] });

        expect(define({ typeId: 'arena.pose.v1', purpose: 'live' })).toThrow(refusing('$.publication', 'missing-publication'));
        expect(define({ typeId: 'room.command.v1', purpose: 'command', publication: LIVE_PUBLICATION }))
            .toThrow(refusing('$.publication', 'unsupported'));
        expect(define({ typeId: 'room.notice.v1', purpose: 'notification', publication: LIVE_PUBLICATION }))
            .toThrow(refusing('$.publication', 'unsupported'));
        expect(define({ typeId: 'arena.pose.v1', purpose: 'live', publication: LIVE_PUBLICATION, durability: 'local-outbox' }))
            .toThrow(refusing('$.durability', 'invalid-durability'));
        expect(define({ typeId: 'arena.pose.v1', purpose: 'live', publication: { ...LIVE_PUBLICATION, cadenceMs: 0 } }))
            .toThrow(refusing('$.publication.cadenceMs', 'invalid-cadence-ms'));
        expect(define({ typeId: 'arena.pose.v1', purpose: 'live', publication: LIVE_PUBLICATION })).not.toThrow();
        expect(define({ typeId: 'arena.pose.v1', purpose: 'live', publication: LIVE_PUBLICATION, durability: 'volatile' }))
            .not.toThrow();
    });

    it('refuses a live send that asks for reliability, a receipt, ordering, a claim or storage, or names no resource', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const channel = createFacade().messages.room<ChatMessage>({
            topicId: 'room.arena',
            typeId: 'arena.pose.v1',
            roomId: 'room-1',
            purpose: 'live',
            publication: LIVE_PUBLICATION
        });
        const unsupported = (path: string) => expect.objectContaining({ path, code: 'unsupported' });

        await expect(channel.send({ text: 'pose' }, { resourceId: 'entity-1', reliability: 'at-least-once' })).rejects
            .toMatchObject({ name: 'RallarValidationError', issues: [unsupported('$.reliability')] });
        await expect(channel.sendWs({ text: 'pose' }, {
            resourceId: 'entity-1',
            ack: 'receiver',
            seq: 1,
            orderingKey: 'arena-order',
            ownership: 'exclusive',
            qos: {
                delivery: { algo: 'at-least-once' },
                ack: { algo: 'receiver' },
                supersedence: { algo: 'latest-wins' },
                durability: { algo: 'local-outbox' }
            }
        })).rejects.toMatchObject({
            issues: [
                unsupported('$.qos.delivery'),
                unsupported('$.ack'),
                unsupported('$.qos.ack'),
                unsupported('$.seq'),
                unsupported('$.orderingKey'),
                unsupported('$.ownership'),
                unsupported('$.qos.supersedence'),
                unsupported('$.qos.durability')
            ]
        });
        await expect(channel.sendRtc({ text: 'pose' })).rejects.toMatchObject({
            issues: [expect.objectContaining({ path: '$.resourceId', code: 'missing-resource-id' })]
        });
    });

    it('stages a live room send and admits it at its lane\'s opportunity on the connect\'s queue engine', async () => {
        const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
        const engine = new InboxOutboxEngine({ nowEpochMs: () => Date.now(), random: () => 0.5, reportTaskFailure: () => undefined });
        mocks.apiMiddleware = createDefaultApiMiddlewareTestDouble({ middleware: { qboxEngine: engine } });
        const admitted: ALMessage[] = [];
        vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer).enqueueOutboxIfAbsent.mockImplementation(async (message) => {
            admitted.push(message);
            return await Promise.resolve({
                verdict: { kind: 'admitted' as const, durable: false, queuedAttempts: 1 },
                message,
                entries: [],
                trackedReceiptAlgo: 'none' as const
            });
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const channel = createFacade().messages.room<ChatMessage>({
            topicId: 'room.arena',
            typeId: 'arena.pose.v1',
            roomId: 'room-1',
            purpose: 'live',
            publication: LIVE_PUBLICATION
        });

        // The facade's delivery clock is the page's own; a deadline no runner stall reaches keeps the value staged.
        const handle = await channel.sendRtc({ text: 'pose' }, { resourceId: 'entity-1', ttlMs: 60_000 });
        expect(handle.lifecycle().state).toBe('staged');
        expect(admitted).toEqual([]);

        await engine.executeOnce();
        await engine.stop();

        expect(admitted.map((message) => message.id.msgId)).toEqual([handle.msgId]);
        expect(handle.lifecycle().state).toBe('queued');
    });

    it('refuses a durable send storage cannot hold unless the channel chose to send it without storage', async () => {
        webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(async (message) => ({
            verdict: message.qos?.durability?.algo === 'volatile'
                ? { kind: 'admitted' as const, durable: false, queuedAttempts: 1 }
                : { kind: 'storage-unavailable' as const, cause: 'missing' as const, detail: 'No IndexedDB.' },
            message,
            entries: [],
            trackedReceiptAlgo: 'none'
        }));
        const facade = createFacade();
        const definition = {
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            purpose: 'command',
            durability: 'local-outbox'
        } as const;
        const refusing = facade.messages.channel<ChatMessage>(definition);
        const downgrading = facade.messages.channel<ChatMessage>({ ...definition, onStorageUnavailable: 'volatile' });

        const refused = await refusing.sendWs({ text: 'refused' }, { scope: 'world', resourceId: 'storage-refused-1' });
        const downgraded = await downgrading.sendWs({ text: 'sent' }, { scope: 'world', resourceId: 'storage-volatile-1' });

        await expect.poll(() => refused.lifecycle().state).toBe('failed');
        await expect.poll(() => downgraded.lifecycle().state).toBe('queued');
        expect(refused.lifecycle().evidence.failure).toEqual({ kind: 'storage-unavailable', cause: 'missing' });
        expect(downgraded.lifecycle().evidence.durabilityDowngrade).toEqual({ requested: 'local-outbox', cause: 'missing' });
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

    it('carries a send\'s corrId onto the envelope on every typed send path', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const channel = createFacade().messages.room<ChatMessage>({
            topicId: 'room.command',
            typeId: 'room.command.v1',
            roomId: 'room-1',
            purpose: 'command'
        });

        const first = await channel.send({ text: 'ask' }, { resourceId: 'corr-1' });
        await channel.send({ text: 're-ask' }, { resourceId: 'corr-2', corrId: first.corrId });
        await channel.sendRtc({ text: 're-ask' }, { resourceId: 'corr-3', corrId: first.corrId });
        await channel.sendWs({ text: 're-ask' }, { resourceId: 'corr-4', corrId: first.corrId });
        await channel.sendWs({ text: 're-ask' }, { peerId: 'peer-1', corrId: first.corrId });

        const rtcMessages = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls.map(([message]) => message);
        const wsMessages = webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls.map(([message]) => message);
        expect(rtcMessages[0]).not.toHaveProperty('actions');
        expect([...rtcMessages.slice(1), ...wsMessages].map((message) => message.actions)).toEqual([
            { corrId: first.msgId },
            { corrId: first.msgId },
            { corrId: first.msgId },
            { corrId: first.msgId }
        ]);
    });

    it('answers a received request through reply() and resolves the asker\'s awaitReply with a reply no onWs handler sees', async () => {
        const wsCallbacks = new Map<string, Parameters<typeof webSocketQueueBox.onAnyInboxMessageDo>[1]>();
        webSocketQueueBox.onAnyInboxMessageDo.mockImplementation((id, callback) => {
            wsCallbacks.set(id, callback);
            return webSocketQueueBox;
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const facade = createFacade();
        const channel = facade.messages.room<ChatMessage>({
            topicId: 'room.command',
            typeId: 'room.command.v1',
            roomId: 'room-1',
            purpose: 'command'
        });
        const received: string[] = [];
        channel.onWs(async (payload, message) => {
            received.push(payload.text);
            await message.reply({ text: `re: ${payload.text}` });
        });
        await facade.connect();
        const asked = await channel.sendWs({ text: 'ask' }, { peerId: 'peer-1' });
        const pending = asked.awaitReply<ChatMessage>({ timeoutMs: 5_000 });
        const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
        const deliver = async (message: ALMessage) => {
            for (const callback of wsCallbacks.values()) {
                await callback.onMessage(message, toResourceEntry('room.command.v1', {}));
            }
        };

        const route = (resourceId: string) => newALRoute('room.command', 'room-1', resourceId);
        const answer = newALUnicastMessage('peer-1', route('r-1'), 'session-1', 'room.command.v1', { text: 'answer' }, {
            groupRef: roomRef,
            actions: { corrId: asked.corrId, replyToMsgId: asked.msgId }
        });
        const question = newALUnicastMessage('peer-1', route('r-2'), 'session-1', 'room.command.v1', { text: 'question' }, {
            groupRef: roomRef
        });

        await deliver(answer);
        await deliver(question);

        const outcome = await pending;
        expect(outcome.status === 'replied' ? outcome.reply.payload : outcome.status).toEqual({ text: 'answer' });
        expect(received).toEqual(['question']);
        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls.at(-1)?.[0]).toMatchObject({
            targets: { mode: 'unicast', toPeerId: 'peer-1', groupRef: roomRef },
            route: { topicId: 'room.command', contextId: 'room-1' },
            payload: { typeId: 'room.command.v1', resource: '{"text":"re: question"}' },
            actions: { corrId: question.id.msgId, replyToMsgId: question.id.msgId }
        });
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
            reason: `No outbound transport route for message ${message.id.msgId}`,
            trackedReceiptAlgo: 'none'
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
