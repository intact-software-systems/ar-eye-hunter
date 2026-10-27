import type { ALQosPolicyRequest } from '@shared-web/browser/rallar-messages.ts';
import { newALMulticastMessage, newALRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';
import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRallarTestFacade,
    getRallarFacadeMocks,
    resetRallarFacadeTestRuntime,
    setRallarFacadeRoomSnapshots
} from './rallar-facade-test-runtime.ts';
// After the facade runtime: its mocks must be registered before the fixture loads the modules they replace.
import { createBrowserMessageSenderFixture, toQueuedMessageAdmission } from './browser-message-sender-fixture.ts';

/** Either carrier's admission port; the RTC one also takes its carrier-gap mode, which these tests ignore. */
interface EnvelopeCarrier {
    enqueueOutboxIfAbsent(message: ALMessage, carrierGap: RtcCarrierGapAdmission): Promise<ALOutboundEnqueueResult>;
}

interface GroupSnapshotFixtureScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const mocks = getRallarFacadeMocks();
let qboxEngine = vi.mocked(mocks.apiMiddleware.middleware.qboxEngine);
let rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
let webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);

installFakeBroadcastChannelPerTest();

describe('Rallar message send', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRallarFacadeTestRuntime();
        qboxEngine = vi.mocked(mocks.apiMiddleware.middleware.qboxEngine);
        rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
        webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);
    });

    it('rejects invalid WS user topics before queueing', async () => {
        await expect(
            createRallarTestFacade().messages.ws.send({
                scope: 'world',
                topicId: 'manual.chat',
                typeId: 'chat.message.v1',
                payload: { text: 'invalid topic' }
            })
        ).rejects.toSatisfy(isRallarValidationError);
    });

    it('rejects room-scoped WS sends without a room target before queueing', async () => {
        await expect(
            createRallarTestFacade().messages.ws.send({
                scope: 'room',
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
                payload: { text: 'missing room' }
            })
        ).rejects.toSatisfy(isRallarValidationError);
    });

    it('rejects invalid RTC room ids before connecting or queueing', async () => {
        await expect(
            createRallarTestFacade().messages.rtc.send({
                roomId: 'bad room',
                typeId: 'chat.message.v1',
                payload: { text: 'invalid room' }
            })
        ).rejects.toSatisfy(isRallarValidationError);
    });

    it('rejects corrupt and oversized message payloads before queueing', async () => {
        const facade = createRallarTestFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            messages: {
                maxPayloadBytes: 8
            }
        });

        await expect(facade.messages.ws.send({
            scope: 'world',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            payload: 1n
        })).rejects.toSatisfy(isRallarValidationError);
        const oversized = await facade.messages.ws.send({
            scope: 'world',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            payload: { text: 'too large' }
        });
        expect((await oversized.wait()).lifecycle.state).toBe('rejected');
    });

    it('records an unroutable RTC failure with the original scoped envelope', async () => {
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'no-route',
                verdict: {
                    kind: 'unroutable' as const,
                    reason: 'no-route' as const,
                    detail: 'Skipping RTC outbound dispatch without planned transport messages'
                },
                message,
                entries: [],
                reason: 'Skipping RTC outbound dispatch without planned transport messages',
                trackedReceiptAlgo: 'none'
            })
        );
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        mockGroupSnapshot(room);

        const result = await createRallarTestFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-quiet',
            payload: {
                text: 'quiet outcome'
            }
        });

        expect((await result.wait()).lifecycle).toMatchObject({
            state: 'failed',
            evidence: { reason: 'Skipping RTC outbound dispatch without planned transport messages' }
        });
        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0]).toMatchObject({
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
                overlayId: '["app-1","workspace-1","room-1"]'
            }
        });
    });

    it('delegates RTC routing when the room cache is temporarily absent', async () => {
        const result = await createRallarTestFacade().messages.rtc.send({
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            nextHopPeerIds: ['peer-1'],
            typeId: 'chat.message.v1',
            resourceId: 'msg-cache-lag',
            payload: {
                text: 'route through the transport runtime'
            }
        });

        expect((await result.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
    });

    it('wakes the queue-box engine when RTC send queues durable outbox work', async () => {
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'enqueued',
                verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                message,
                entries: [],
                trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
            })
        );
        const engineEvents: string[] = [];
        qboxEngine.wake.mockImplementation(() => {
            engineEvents.push('wake');
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));

        const sent = await createRallarTestFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-queued-rtc',
            payload: {
                text: 'queued rtc'
            }
        });

        await sent.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(engineEvents).toEqual(['wake']);
    });

    it('stamps the cached room snapshot and roster versions on RTC room sends', async () => {
        mockGroupSnapshot(withSnapshotVersion(
            createGroupSnapshot('room-1', ['session-1', 'peer-1']),
            7,
            4
        ));

        const result = await createRallarTestFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-rtc',
            payload: {
                text: 'versioned rtc'
            }
        });

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            minSnapshotVersion: 7,
            rosterVersion: 4
        });
        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].targets).not.toHaveProperty('groupId');
    });

    it('stamps the larger of a typed send\'s stated floor and the cached version, and the cached roster either way', async () => {
        mockGroupSnapshot(withSnapshotVersion(createGroupSnapshot('room-1', ['session-1', 'peer-1']), 7, 4));
        const channel = createRallarTestFacade().messages.room({
            typeId: 'chat.message.v1',
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
            purpose: 'notification'
        });

        await channel.send({ text: 'stated floor' }, { strategy: 'rtc', minSnapshotVersion: 42 });
        await channel.send({ text: 'sender floor' }, { strategy: 'rtc' });
        await channel.send({ text: 'stale stated floor' }, { strategy: 'rtc', minSnapshotVersion: 3 });

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls.map(([message]) => message.targets)).toMatchObject([
            { mode: 'multicast', minSnapshotVersion: 42, rosterVersion: 4 },
            { mode: 'multicast', minSnapshotVersion: 7, rosterVersion: 4 },
            { mode: 'multicast', minSnapshotVersion: 7, rosterVersion: 4 }
        ]);
    });

    it('stamps neither version on RTC or WS room sends when no room snapshot is cached', async () => {
        const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
        const facade = createRallarTestFacade();

        await facade.messages.rtc.send({ roomRef, typeId: 'chat.message.v1', payload: { text: 'uncached rtc' } });
        await facade.messages.ws.send({ roomRef, topicId: 'room.chat', typeId: 'chat.message.v1', payload: { text: 'uncached ws' } });

        for (const { targets } of [rtcRxStreamer, webSocketQueueBox].map((port) => port.enqueueOutboxIfAbsent.mock.calls[0][0])) {
            expect(targets).toMatchObject({ groupRef: roomRef });
            expect(targets).toMatchObject({ minSnapshotVersion: undefined, rosterVersion: undefined });
        }
    });

    it('carries a typed send\'s stated QoS request on the envelope over both carriers, and only the purpose\'s durability without one', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const channel = createRallarTestFacade().messages.room({
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
            purpose: 'notification'
        });
        const qos: ALQosPolicyRequest = { ack: { algo: 'hop' } };

        await channel.send({ text: 'rtc hop' }, { strategy: 'rtc', ack: 'receiver', qos });
        await channel.send({ text: 'ws hop' }, { strategy: 'ws', ack: 'receiver', qos });
        await channel.send({ text: 'rtc default' }, { strategy: 'rtc', ack: 'receiver' });

        const [rtcStated, rtcDefault] = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls.map(([message]) => message);
        expect(rtcStated).toMatchObject({ delivery: { ack: 'receiver' }, qos });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0]).toMatchObject({ delivery: { ack: 'receiver' }, qos });
        expect(rtcDefault.qos).toEqual({ durability: { algo: 'volatile' } });
    });

    it('rejects a QoS request the envelope cannot carry', async () => {
        await expect(
            createRallarTestFacade().messages.ws.send({
                scope: 'world',
                topicId: 'app.chat',
                typeId: 'chat.message.v1',
                payload: { text: 'unknown ack algorithm' },
                qos: JSON.parse('{"ack":{"algo":"everyone"}}')
            })
        ).rejects.toMatchObject({
            name: 'RallarValidationError',
            issues: [expect.objectContaining({ path: '$.qos', code: 'invalid-qos' })]
        });
    });

    it('uses roomRef scope for cached snapshotVersion on RTC room sends', async () => {
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
        setRallarFacadeRoomSnapshots([workspaceA, workspaceB]);

        const result = await createRallarTestFacade().messages.rtc.send({
            roomId: 'shared-room',
            roomRef: workspaceB.group,
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-rtc-scoped',
            payload: {
                text: 'versioned scoped rtc'
            }
        });

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId: 'shared-room'
            },
            minSnapshotVersion: 11
        });
        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].targets).not.toHaveProperty('groupId');
    });

    it('records WS admission and keeps the original broadcast envelope', async () => {
        webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'accepted',
                verdict: { kind: 'admitted' as const, durable: false, queuedAttempts: 1 },
                message,
                entries: [],
                trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
            })
        );
        const engineEvents: string[] = [];
        qboxEngine.wake.mockImplementation(() => {
            engineEvents.push('wake');
        });

        const result = await createRallarTestFacade().messages.ws.send({
            scope: 'world',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-ws',
            payload: {
                text: 'ws outcome'
            }
        });

        await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(engineEvents).toEqual(['wake']);
        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0]).toMatchObject({
            id: {
                senderId: 'session-1'
            },
            route: {
                topicId: 'app.chat',
                resourceId: 'msg-ws',
                contextId: 'world'
            },
            targets: {
                mode: 'broadcast',
                scope: 'world'
            }
        });
    });

    it('carries a WS send\'s client-assigned ordering on its broadcast envelope, and none without it', async () => {
        const facade = createRallarTestFacade();
        const send = { scope: 'world', topicId: 'app.chat', typeId: 'chat.message.v1' } as const;

        await facade.messages.ws.send({ ...send, payload: { text: 'ordered' }, orderingKey: 'k', seq: 7 });
        await facade.messages.ws.send({ ...send, payload: { text: 'unordered' } });

        const [ordered, unordered] = webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls.map(([message]) => message);
        expect(ordered.ordering).toEqual({ orderingKey: 'k', seq: 7 });
        expect(unordered.ordering).toBeUndefined();
    });

    it('rejects a WS send that states only one half of its ordering with a typed issue for the missing half', async () => {
        const facade = createRallarTestFacade();
        const send = { scope: 'world', topicId: 'app.chat', typeId: 'chat.message.v1', payload: { text: 'half' } } as const;

        await expect(facade.messages.ws.send({ ...send, seq: 7 })).rejects.toMatchObject({
            name: 'RallarValidationError',
            issues: [expect.objectContaining({ path: '$.orderingKey', code: 'missing-ordering-key' })]
        });
        await expect(facade.messages.ws.send({ ...send, orderingKey: 'k' })).rejects.toMatchObject({
            name: 'RallarValidationError',
            issues: [expect.objectContaining({ path: '$.seq', code: 'missing-seq' })]
        });
    });

    it('wakes the queue-box engine when WS send queues durable outbox work', async () => {
        webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'enqueued',
                verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                message,
                entries: [],
                trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
            })
        );
        const engineEvents: string[] = [];
        qboxEngine.wake.mockImplementation(() => {
            engineEvents.push('wake');
        });

        const sent = await createRallarTestFacade().messages.ws.send({
            scope: 'world',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-queued-ws',
            payload: {
                text: 'queued ws'
            }
        });

        await sent.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(engineEvents).toEqual(['wake']);
    });

    it('stamps the cached room snapshot and roster versions on WS room sends', async () => {
        mockGroupSnapshot(withSnapshotVersion(
            createGroupSnapshot('room-1', ['session-1', 'peer-1']),
            11,
            5
        ));

        const result = await createRallarTestFacade().messages.ws.send({
            roomId: 'room-1',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-ws',
            payload: {
                text: 'versioned ws'
            }
        });

        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0].targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            minSnapshotVersion: 11,
            rosterVersion: 5
        });
    });

    it('uses roomRef scope for cached snapshotVersion and target groupRef on WS room sends', async () => {
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
        setRallarFacadeRoomSnapshots([workspaceA, workspaceB]);

        const result = await createRallarTestFacade().messages.ws.send({
            roomId: 'shared-room',
            roomRef: workspaceB.group,
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-ws-scoped',
            payload: {
                text: 'versioned scoped ws'
            }
        });

        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0].targets).toMatchObject({
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

    it('keeps a lane send on today\'s defaults: at-least-once, no receipt, no durability request', async () => {
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
        const facade = createRallarTestFacade();

        await facade.messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            payload: { text: 'lane' }
        });

        const message = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0];
        expect(message.delivery).toMatchObject({ reliability: 'at-least-once', ack: 'none' });
        expect(message.qos).toBeUndefined();
    });
});

describe('the send correlation and the reply path', () => {
    const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

    it('writes no actions on a send that names no correlation, and only the corrId on a re-ask', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const ws = captureEnvelopes(fixture.middleware.middleware.webSocketQueueBox);
        const rtc = captureEnvelopes(fixture.middleware.middleware.rtcRxStreamer);
        const send = { typeId: 'app.ask.v1', payload: { text: 'ask' }, roomId: 'room' } as const;

        const first = await fixture.sender.sendWs({ ...send, scope: 'room' }, undefined);
        const reAsk = await fixture.sender.sendWs({ ...send, scope: 'room', corrId: first.msgId }, undefined);
        const peer = await fixture.sender.sendWs({ ...send, peerId: 'peer-b', corrId: first.msgId }, undefined);
        const multicast = await fixture.sender.sendRtc({ ...send, corrId: first.msgId }, undefined);

        const [firstMessage, reAskMessage, peerMessage] = ws;
        expect(firstMessage).not.toHaveProperty('actions');
        expect(first.corrId).toBe(first.msgId);
        for (const message of [reAskMessage, peerMessage, rtc[0]]) {
            expect(message.actions).toEqual({ corrId: first.msgId });
        }
        expect([reAsk.corrId, peer.corrId, multicast.corrId]).toEqual([first.msgId, first.msgId, first.msgId]);
        expect(reAsk.replyToMsgId).toBeUndefined();
    });

    it.each([
        ['empty', ''],
        ['longer than 128 bytes', 'é'.repeat(65)]
    ])('refuses an %s corrId with a $.corrId issue before queueing', async (_label, corrId) => {
        const fixture = createBrowserMessageSenderFixture();
        const ws = captureEnvelopes(fixture.middleware.middleware.webSocketQueueBox);

        const sending = fixture.sender.sendWs({ typeId: 'app.ask.v1', payload: {}, scope: 'room', corrId }, undefined);

        await expect(sending).rejects.toSatisfy(isRallarValidationError);
        await expect(sending).rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.corrId' })] });
        expect(ws).toEqual([]);
        expect(fixture.registry.size()).toBe(0);
    });

    it('sends a reply as a receipted WS unicast to the requester, in its room and route, under its correlation', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const ws = captureEnvelopes(fixture.middleware.middleware.webSocketQueueBox);
        const request = toRoomRequest({ corrId: 'corr-0' });

        const handle = await fixture.sender.sendReply(request, { answer: 42 }, undefined);

        const reply = ws[0];
        expect(reply).toMatchObject({
            id: { senderId: fixture.middleware.session.sessionId },
            route: { topicId: 'room.ask', contextId: 'room' },
            targets: { mode: 'unicast', toPeerId: 'requester-1', groupRef: ROOM_REF },
            delivery: { reliability: 'at-least-once', ack: 'receiver' },
            payload: { typeId: 'app.ask.v1', resource: '{"answer":42}' },
            actions: { corrId: 'corr-0', replyToMsgId: request.id.msgId }
        });
        expect(reply.constraints?.expiresAtMs).toBe(reply.id.ts + 30_000);
        expect(reply.qos).toBeUndefined();
        expect(handle).toMatchObject({ corrId: 'corr-0', replyToMsgId: request.id.msgId });
    });

    it('lets the reply name its own type and lifetime', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const ws = captureEnvelopes(fixture.middleware.middleware.webSocketQueueBox);
        const request = toRoomRequest({});

        await fixture.sender.sendReply(request, { answer: 42 }, { typeId: 'app.answer.v1', ttlMs: 5_000 });

        const reply = ws[0];
        expect(reply.payload.typeId).toBe('app.answer.v1');
        expect(reply.constraints?.expiresAtMs).toBe(reply.id.ts + 5_000);
        expect(reply.actions).toEqual({ corrId: request.id.msgId, replyToMsgId: request.id.msgId });
    });

    it('replies to a request that named no room outside any room, never in the default room', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const ws = captureEnvelopes(fixture.middleware.middleware.webSocketQueueBox);
        const request = newALUnicastMessage(
            'requester-1',
            newALRoute('app.ask', 'world', 'resource-1'),
            'session-1',
            'app.ask.v1',
            { question: 'ping' }
        );

        await fixture.sender.sendReply(request, { answer: 'pong' }, undefined);

        expect(ws[0].targets).toEqual({ mode: 'unicast', toPeerId: 'requester-1' });
        expect(ws[0].route).toMatchObject({ topicId: 'app.ask', contextId: 'world' });
    });

    /** Records each envelope a carrier admits, in admission order. */
    function captureEnvelopes(carrier: EnvelopeCarrier): ALMessage[] {
        const envelopes: ALMessage[] = [];
        carrier.enqueueOutboxIfAbsent = async (message: ALMessage) => {
            envelopes.push(message);
            return await Promise.resolve(toQueuedMessageAdmission(message));
        };
        return envelopes;
    }

    function toRoomRequest(input: Readonly<{ corrId?: string; }>): ALMessage {
        return newALMulticastMessage(
            'requester-1',
            newALRoute('room.ask', 'room', 'resource-1'),
            ROOM_REF,
            'app.ask.v1',
            { question: 'ping' },
            input.corrId === undefined ? {} : { actions: { corrId: input.corrId } }
        );
    }
});

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    setRallarFacadeRoomSnapshots([snapshot]);
}

function withSnapshotVersion(
    snapshot: GroupSnapshot,
    snapshotVersion: number,
    rosterVersion = snapshot.group.rosterVersion
): GroupSnapshot {
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            snapshotVersion,
            rosterVersion
        }
    };
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
