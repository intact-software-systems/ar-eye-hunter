import { Temporal } from '@js-temporal/polyfill';
import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { BROWSER_DELIVERY_RETENTION } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    isRoomScopedALMessage,
    newALMulticastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID, AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALAckPayload, decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime, type ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { planRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import {
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    toOriginDirectedSnapshot,
    type RtcOriginOverlayFixture
} from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import { openConnectingWebSocket, SimulatedWebSocket } from '../../shared/native-websocket-fixture.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

interface ReceiptLoopPeer {
    readonly ws: WsQueueBoxClientService;
    readonly socket: SimulatedWebSocket;
    readonly engine: InboxOutboxEngine;
    readonly inboundStores: ALInboundRuntimeStores;
    readonly outboundStores: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly settlements: readonly ALDeliverySettlement[];
}

interface ReceiptLoopReceiver extends ReceiptLoopPeer {
    readonly rtc: ALInboundMessageRuntime;
    readonly rtcControls: readonly ALMessage[];
    readonly delivered: readonly string[];
    readonly businessDelivery: Promise<void>;
}

interface ReceiptLoopExpectation {
    readonly mode: 'receiver' | 'leader';
    readonly expectedRecipientPeerIds: readonly ('b' | 'c')[];
    readonly initialConfirmedPeerIds: readonly ('b' | 'c')[];
    readonly delivered: Readonly<Record<'b' | 'c', readonly string[]>>;
}

const RECEIVER_EXPECTATION: ReceiptLoopExpectation = {
    mode: 'receiver',
    expectedRecipientPeerIds: ['b', 'c'],
    initialConfirmedPeerIds: ['b'],
    delivered: { b: ['{"start":true}'], c: ['{"start":true}'] }
};

const LEADER_EXPECTATION: ReceiptLoopExpectation = {
    mode: 'leader',
    expectedRecipientPeerIds: ['c'],
    initialConfirmedPeerIds: [],
    delivered: { b: [], c: ['{"start":true}'] }
};

interface ReceiptLoopServer {
    readonly service: WsQueueBoxServerService;
    readonly sockets: Readonly<Record<'a' | 'b' | 'c', SimulatedWebSocket>>;
}

interface ReceiptLoopOrigin {
    readonly ws: ReceiptLoopPeer;
    readonly rtc: RtcOriginOverlayFixture;
    readonly registry: BrowserRallarDeliveryRegistry;
    readonly dispatch: BrowserRallarMessageDispatch;
    readonly delivery: BrowserRallarMessageDispatch.Delivery;
    readonly handle: RallarMessageHandle;
    readonly rtcAdmissions: readonly ALMessage[];
}

interface ReceiptLoop {
    readonly expectation: ReceiptLoopExpectation;
    readonly server: ReceiptLoopServer;
    readonly origin: ReceiptLoopOrigin;
    readonly receivers: Readonly<Record<'b' | 'c', ReceiptLoopReceiver>>;
    readonly submission: {
        holdFinalAck: boolean;
        readonly heldFinalAcks: ALMessage[];
    };
}

describe('cross-carrier receipts', () => {
    beforeEach(() => {
        registerReceiptLoopCleanup([
            () => {
                vi.useRealTimers();
            },
            () => {
                vi.restoreAllMocks();
            },
            () => {
                vi.unstubAllGlobals();
            },
            () => {
                SimulatedWebSocket.instances.length = 0;
            }
        ]);
    });

    it.each([RECEIVER_EXPECTATION, LEADER_EXPECTATION])(
        'acknowledges the origin only after the final real WS duplicate ACK reaches the server ($mode)',
        async (expectation) => {
            const loop = await createReceiptLoop(expectation);
            const completed = loop.origin.handle.wait({ until: ['acknowledged'] });
            await deliverRtcThenWs(loop);
            await Promise.all(expectation.expectedRecipientPeerIds.map((peerId) => loop.receivers[peerId].businessDelivery));

            if (expectation.mode === 'receiver') {
                const firstAck = readSubmittedAck(loop.receivers.b, 'b');
                expect((await loop.server.service.acceptIncomingMessage(firstAck, 'b')).right?.kind).toBe('control');
                await vi.advanceTimersByTimeAsync(100);
            }
            const finalAck = readSubmittedAck(loop.receivers.c, 'c');
            expect(decodeALAckPayload(JSON.parse(finalAck.payload.resource)).ackedMsgId).toBe(loop.origin.handle.msgId);
            expect(readServerReceipts(loop.server).map((receipt) => receipt.phase)).toEqual(['admitted']);
            expect(loop.origin.handle.lifecycle().state).toBe('transport-accepted');
            const receiptRef = { originPeerId: 'a', msgId: loop.origin.handle.msgId };
            const currentWsReceipt = await loop.origin.ws.outboundStores.admissionStore.readPendingAck(receiptRef);
            expect(currentWsReceipt).toMatchObject({
                mode: expectation.mode,
                expectedPeerIds: expectation.expectedRecipientPeerIds,
                ackedPeerIds: [],
                timeoutMs: 2_000,
                maxAttempts: 3
            });

            const lateRtcAck = loop.receivers.c.rtcControls.find((message) => message.payload.typeId === AL_CONTROL_ACK_TYPE_ID)!;
            expect(lateRtcAck).toBeDefined();
            expect(decodeALAckPayload(JSON.parse(lateRtcAck.payload.resource))).toMatchObject({
                ackedMsgId: loop.origin.handle.msgId,
                fromPeerId: 'c',
                toPeerId: 'a',
                originPeerId: 'a',
                logicalRecipientPeerId: 'c',
                carrier: 'rtc',
                status: 'delivered'
            });
            const lifecycleBeforeLateRtcAck = structuredClone(loop.origin.handle.lifecycle());
            const lateRtcAdmission = await loop.origin.rtc.manager.acceptControlMessage(lateRtcAck);
            expect(loop.origin.handle.lifecycle()).toEqual(lifecycleBeforeLateRtcAck);
            expect(await loop.origin.rtc.resources.admissionStore.readPendingAck(receiptRef)).toBeUndefined();
            expect(await loop.origin.ws.outboundStores.admissionStore.readPendingAck(receiptRef)).toEqual(currentWsReceipt);
            expect(loop.origin.handle.lifecycle()).toMatchObject({
                state: 'transport-accepted',
                evidence: {
                    receiptMode: expectation.mode,
                    expectedRecipientPeerIds: expectation.expectedRecipientPeerIds,
                    confirmedRecipientPeerIds: [],
                    unconfirmedRecipientPeerIds: expectation.expectedRecipientPeerIds
                }
            });

            expect((await loop.server.service.acceptIncomingMessage(finalAck, 'c')).right?.kind).toBe('control');
            await vi.advanceTimersByTimeAsync(100);
            await returnReceiptToOrigin(loop, 'complete');

            expect(await completed).toMatchObject({
                status: 'settled',
                lifecycle: {
                    state: 'acknowledged',
                    receiptAlgo: expectation.mode,
                    evidence: {
                        receiptMode: expectation.mode,
                        expectedRecipientPeerIds: expectation.expectedRecipientPeerIds,
                        confirmedRecipientPeerIds: expectation.expectedRecipientPeerIds,
                        unconfirmedRecipientPeerIds: []
                    }
                }
            });
            expect(Date.now()).toBeLessThan(loop.origin.delivery.message.constraints!.expiresAtMs!);
            console.info(
                'Cross-carrier receipt ownership',
                JSON.stringify({
                    mode: expectation.mode,
                    expectedRecipientPeerIds: expectation.expectedRecipientPeerIds,
                    businessDeliveries: { b: loop.receivers.b.delivered.length, c: loop.receivers.c.delivered.length },
                    lateRtcAdmission: lateRtcAdmission.kind,
                    serverReceiptPhases: readServerReceipts(loop.server).map((receipt) => receipt.phase),
                    finalState: loop.origin.handle.lifecycle().state,
                    remainingOriginalTtlMs: loop.origin.delivery.message.constraints!.expiresAtMs! - Date.now()
                })
            );
        }
    );

    it('times out naming c when both ACKs are submitted but only b reaches server ingress', async () => {
        const loop = await createReceiptLoop(RECEIVER_EXPECTATION);
        const ended = loop.origin.handle.wait({ until: ['acknowledged'] });
        await deliverRtcThenWs(loop);
        const firstAck = readSubmittedAck(loop.receivers.b, 'b');
        readSubmittedAck(loop.receivers.c, 'c');
        expect((await loop.server.service.acceptIncomingMessage(firstAck, 'b')).right?.kind).toBe('control');
        await vi.advanceTimersByTimeAsync(100);

        expect(readServerReceipts(loop.server).map((receipt) => receipt.phase)).toEqual(['admitted']);
        expect(loop.origin.handle.lifecycle().state).toBe('transport-accepted');
        await vi.advanceTimersByTimeAsync(loop.origin.delivery.message.constraints!.expiresAtMs! - Date.now());
        await vi.advanceTimersByTimeAsync(100);

        expect(readServerReceipts(loop.server)).toEqual([
            expect.objectContaining({ phase: 'admitted', expectedRecipientPeerIds: ['b', 'c'], confirmedRecipientPeerIds: [] }),
            expect.objectContaining({ phase: 'timed-out', expectedRecipientPeerIds: ['b', 'c'], confirmedRecipientPeerIds: ['b'] })
        ]);
        await returnReceiptToOrigin(loop, 'timed-out');
        expect(await ended).toMatchObject({ status: 'settled', lifecycle: { state: 'expired' } });
        expect(loop.origin.handle.lifecycle()).toMatchObject({
            state: 'expired',
            evidence: { expectedRecipientPeerIds: ['b', 'c'], confirmedRecipientPeerIds: ['b'], unconfirmedRecipientPeerIds: ['c'] }
        });
    });

    it('keeps an admitted ACK pending while submission is held and completes after releasing that work', async () => {
        const loop = await createReceiptLoop(RECEIVER_EXPECTATION);
        const completed = loop.origin.handle.wait({ until: ['acknowledged'] });
        loop.submission.holdFinalAck = true;
        await deliverRtcThenWs(loop);
        const firstAck = readSubmittedAck(loop.receivers.b, 'b');
        expect((await loop.server.service.acceptIncomingMessage(firstAck, 'b')).right?.kind).toBe('control');
        await vi.advanceTimersByTimeAsync(100);

        const held = loop.submission.heldFinalAcks[0]!;
        expect(held).toBeDefined();
        expect(decodeALAckPayload(JSON.parse(held.payload.resource))).toMatchObject({
            ackedMsgId: loop.origin.handle.msgId,
            fromPeerId: 'c',
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: 'c',
            carrier: 'ws',
            status: 'delivered'
        });
        expect(loop.receivers.c.settlements).toContainEqual(expect.objectContaining({
            kind: 'attempt-settled',
            msgId: held.id.msgId,
            carrier: 'ws',
            outcome: 'not-ready',
            submissionAttempted: false,
            detail: 'Final ACK submission held'
        }));
        expect(loop.receivers.c.socket.sent).toEqual([]);
        expect(readServerReceipts(loop.server).map((receipt) => receipt.phase)).toEqual(['admitted']);
        expect(loop.origin.handle.lifecycle().state).toBe('transport-accepted');

        loop.submission.holdFinalAck = false;
        await vi.advanceTimersByTimeAsync(100);
        const released = readSubmittedAck(loop.receivers.c, 'c');
        expect(released.id.msgId).toBe(held.id.msgId);
        expect((await loop.server.service.acceptIncomingMessage(released, 'c')).right?.kind).toBe('control');
        await vi.advanceTimersByTimeAsync(100);
        await returnReceiptToOrigin(loop, 'complete');

        expect(await completed).toMatchObject({ status: 'settled', lifecycle: { state: 'acknowledged' } });
        expect(Date.now()).toBeLessThan(loop.origin.delivery.message.constraints!.expiresAtMs!);
    });
});

async function createReceiptLoop(expectation: ReceiptLoopExpectation): Promise<ReceiptLoop> {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', SimulatedWebSocket);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(Date.now()));
    const submission: ReceiptLoop['submission'] = { holdFinalAck: false, heldFinalAcks: [] };
    const server = await createReceiptLoopServer();
    const registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, ...BROWSER_DELIVERY_RETENTION, cancel: () => {} });
    registerReceiptLoopCleanup([() => registry.releaseAll()]);
    const ws = await createReceiptLoopPeer('a', (settlement) => registry.record(settlement), () => undefined);
    const room = createOriginSnapshot(['a', 'b', 'c'], 4);
    const snapshot = expectation.mode === 'leader' ? toOriginDirectedSnapshot(room, 'c') : room;
    const rtc = createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: ['b', 'c'],
        onSettlement: (settlement) => registry.record(settlement)
    });
    const origin = createReceiptLoopOrigin({ ws, rtc, registry }, expectation);
    const b = await createReceiptLoopReceiver('b', snapshot, () => undefined);
    const c = await createReceiptLoopReceiver('c', snapshot, (message) => {
        if (!submission.holdFinalAck || message.payload.typeId !== AL_CONTROL_ACK_TYPE_ID) {
            return undefined;
        }
        submission.heldFinalAcks.push(message);
        return 'Final ACK submission held';
    });
    return { expectation, server, origin, receivers: { b, c }, submission };
}

async function createReceiptLoopServer(): Promise<ReceiptLoopServer> {
    const socket = new JsonWebSocketServer();
    const sockets = { a: new SimulatedWebSocket('ws://server/a'), b: new SimulatedWebSocket('ws://server/b'), c: new SimulatedWebSocket('ws://server/c') };
    for (const [peerId, native] of Object.entries(sockets)) {
        await native.open();
        socket.addConnection(new ConnectionContext({ id: peerId, socket: native }));
    }
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(),
        socket,
        name: 'server',
        queueEngine: engine,
        inboundStores: createReceiptLoopInboundStores('server'),
        forwardsRoomScopedMessages: true,
        targetResolver: {
            resolvePeerRecipients: (peerId) => [{ peerId, connectionId: peerId }],
            resolveGroupRecipients: () => ['a', 'b', 'c'].map((peerId) => ({ peerId, connectionId: peerId }))
        },
        readAuthenticatedConnectionScope: (connection) =>
            socket.connections.get(connection.id) === connection
                ? { scope: { applicationId: 'app', workspaceId: 'workspace' }, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined
    });
    service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? { authorized: true, roomAudience: { recipientPeerIds: ['a', 'b', 'c'], snapshotVersion: 4 } }
                : { authorized: true }
    });
    engine.start();
    registerReceiptLoopCleanup([() => service.dispose(), () => engine.stop()]);
    return { service, sockets };
}

async function createReceiptLoopPeer(
    peerId: string,
    settle: (settlement: ALDeliverySettlement) => void,
    readSubmissionIneligibility: WsQueueBoxClientService.Dependencies['readSubmissionIneligibility']
): Promise<ReceiptLoopPeer> {
    const socket = new JsonWebSocketClient(`ws://client/${peerId}`, createPassThroughTransportFaultPort());
    const native = await openConnectingWebSocket(socket, socket.connect());
    const engine = new InboxOutboxEngine();
    const inboundStores = createReceiptLoopInboundStores(peerId);
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        namespace: `receipt-loop/${peerId}/ws-outbound`,
        nowMs: Date.now,
        decodePrepared: decodeALOutboundTransportMessage
    });
    const settlements: ALDeliverySettlement[] = [];
    const ws = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(),
        socket,
        sessionId: peerId,
        serverPeerId: 'server',
        inboundStores,
        outboundStores,
        queueEngine: engine,
        readSubmissionIneligibility,
        outboundSettlements: (settlement) => {
            settlements.push(settlement);
            settle(settlement);
        }
    });
    ws.enableDefaultCallbacks();
    engine.start();
    registerReceiptLoopCleanup([() => ws.close(), () => engine.stop()]);
    return { ws, socket: native, engine, inboundStores, outboundStores, settlements };
}

async function createReceiptLoopReceiver(
    peerId: 'b' | 'c',
    snapshot: GroupSnapshot,
    readSubmissionIneligibility: WsQueueBoxClientService.Dependencies['readSubmissionIneligibility']
): Promise<ReceiptLoopReceiver> {
    const peer = await createReceiptLoopPeer(peerId, () => {}, readSubmissionIneligibility);
    const delivered: string[] = [];
    const businessDelivery = Promise.withResolvers<void>();
    const rtcControls: ALMessage[] = [];
    peer.ws.onAnyInboxMessageDo('application', {
        onMessage: async (message) => {
            delivered.push(message.payload.resource);
            businessDelivery.resolve();
        }
    });
    const rtc = new ALInboundMessageRuntime({
        ...createDefaultALInboundRuntimeResources({
            selfPeerId: peerId,
            stores: peer.inboundStores,
            queueEngine: peer.engine,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'rtc-inbox')
        }),
        carrier: 'rtc',
        planIncomingMessage: (message, source, observations) => {
            const fromPeerId = source.kind === 'trusted-server' ? undefined : source.peerId;
            return planRtcRoomSnapshotAdmission({
                message,
                plan: planALMessageHandling(message, { ...observations, selfPeerId: peerId, fromPeerId }),
                snapshot,
                selfPeerId: peerId,
                fromPeerId,
                recipientPeerId: undefined,
                overlay: undefined,
                nowMs: observations.nowMs
            });
        },
        dispatchInboxEntry: async (entry) => {
            delivered.push(decodePersistedALMessage(entry.resource).payload.resource);
            businessDelivery.resolve();
        },
        sendControlMessages: async (messages) => {
            rtcControls.push(...messages);
        },
        diagnostics: undefined
    });
    registerReceiptLoopCleanup([() => rtc.dispose()]);
    return { ...peer, rtc, delivered, rtcControls, businessDelivery: businessDelivery.promise };
}

function createReceiptLoopOrigin(
    owners: Pick<ReceiptLoopOrigin, 'ws' | 'rtc' | 'registry'>,
    expectation: ReceiptLoopExpectation
): ReceiptLoopOrigin {
    const rtcAdmissions: ALMessage[] = [];
    const middleware = createDefaultApiMiddlewareTestDouble({
        session: { sessionId: 'a' },
        middleware: {
            qboxEngine: { wake: () => owners.ws.engine.wake() },
            webSocketQueueBox: { enqueueOutboxIfAbsent: (message) => owners.ws.ws.enqueueOutboxIfAbsent(message) },
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: async (message, gap) => {
                    const admission = await owners.rtc.manager.enqueueLegIfAbsent(message, gap ?? 'hold');
                    rtcAdmissions.push(admission.message);
                    return admission;
                },
                handOverOutbox: (msgId) => owners.rtc.manager.handOver(msgId)
            }
        }
    });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(owners.registry, {
        deliverySettlements: feed,
        readMiddleware: () => middleware,
        readRtcCaptureReceipt: () => undefined
    }, () => middleware.session);
    sessionDeliveries.beginSession(middleware.session);
    feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
    const dispatch = new BrowserRallarMessageDispatch({ deliveries: owners.registry, sessionDeliveries, nowMs: Date.now });
    const message = newALMulticastMessage('a', { topicId: 'chat', resourceId: 'start', contextId: 'room' }, ORIGIN_ROOM, 'chat.message.v1', { start: true }, {
        ack: expectation.mode === 'leader' ? 'group-leader' : 'all-logical-recipients',
        reliability: 'at-least-once',
        ttlMs: 30_000,
        qos: { durability: { algo: 'volatile' } }
    });
    expect(message.constraints?.expiresAtMs).toBe(Date.now() + 30_000);
    const delivery: BrowserRallarMessageDispatch.Delivery = {
        requestedConfiguration: undefined,
        rtcCapture: { status: 'unavailable', reason: 'absent' },
        context: middleware,
        carrier: 'rtc',
        message,
        canFallback: true,
        payloadIssues: [],
        onStorageUnavailable: 'refuse'
    };
    return { ...owners, dispatch, delivery, handle: owners.registry.open(delivery.message, 'rtc'), rtcAdmissions };
}

function createReceiptLoopInboundStores(peerId: string): ALInboundRuntimeStores {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    return {
        admissionStore: createALInboundAdmissionStore({
            namespace: `receipt-loop/${peerId}`,
            nowMs: Date.now,
            backend,
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention(),
            maxOrderingTracks: undefined
        }),
        workQueue: backend.workQueue
    };
}

async function deliverRtcThenWs(loop: ReceiptLoop): Promise<void> {
    await deliverOriginalRtcMessage(loop);
    await exhaustRtcAndAdmitWsFallback(loop);
    await deliverWsDuplicates(loop);
}

async function deliverOriginalRtcMessage(loop: ReceiptLoop): Promise<void> {
    loop.origin.dispatch.send(loop.origin.delivery);
    await vi.advanceTimersByTimeAsync(100);
    for (const peerId of ['b', 'c'] as const) {
        const message = loop.origin.rtc.channels[peerId]!.sent[0]!;
        expect(message).toBeDefined();
        expect(message.targets).toEqual({
            mode: 'multicast',
            groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
            recipientPeerIds: loop.expectation.expectedRecipientPeerIds,
            snapshotVersion: 4
        });
        expect((await loop.receivers[peerId].rtc.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: 'a' })).right?.kind).toBe('admitted');
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.receivers.b.delivered).toEqual(loop.expectation.delivered.b);
    expect(loop.receivers.c.delivered).toEqual(loop.expectation.delivered.c);
    if (loop.expectation.mode === 'receiver') {
        const firstRtcAck = loop.receivers.b.rtcControls.find((message) => message.payload.typeId === AL_CONTROL_ACK_TYPE_ID)!;
        expect(firstRtcAck).toBeDefined();
        await loop.origin.rtc.manager.acceptControlMessage(firstRtcAck);
    }
    expect(loop.origin.handle.lifecycle().state).toBe('transport-accepted');
    expect(await loop.origin.rtc.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: loop.origin.handle.msgId })).toMatchObject({
        mode: loop.expectation.mode,
        expectedPeerIds: loop.expectation.expectedRecipientPeerIds,
        ackedPeerIds: loop.expectation.initialConfirmedPeerIds,
        timeoutMs: 2_000,
        maxAttempts: 3
    });
}

async function exhaustRtcAndAdmitWsFallback(loop: ReceiptLoop): Promise<void> {
    await vi.advanceTimersByTimeAsync(8_000);
    expect(loop.origin.rtc.settlements).toContainEqual(expect.objectContaining({
        kind: 'receipt-exhausted',
        msgId: loop.origin.handle.msgId
    }));
    const submittedMessages = loop.origin.ws.socket.sent.map(decodePersistedALMessage)
        .filter((message) => message.id.msgId === loop.origin.handle.msgId);
    expect(submittedMessages).toHaveLength(1);
    const submitted = submittedMessages[0]!;
    expect(submitted).toEqual(decodePersistedALMessage(JSON.stringify(loop.origin.rtcAdmissions[0])));
    expect(submitted.constraints?.expiresAtMs).toBe(loop.origin.delivery.message.constraints?.expiresAtMs);
    expect(await loop.origin.rtc.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: submitted.id.msgId })).toBeUndefined();
    expect((await loop.server.service.acceptIncomingMessage(submitted, 'a')).right?.kind).toBe('admitted');
    await vi.advanceTimersByTimeAsync(100);
    await returnReceiptToOrigin(loop, 'admitted');
    expect(loop.origin.handle.lifecycle()).toMatchObject({
        state: 'transport-accepted',
        evidence: {
            carrierFallback: { from: 'rtc', to: 'ws', reason: 'receipt-exhausted' },
            receiptMode: loop.expectation.mode,
            expectedRecipientPeerIds: loop.expectation.expectedRecipientPeerIds,
            confirmedRecipientPeerIds: [],
            unconfirmedRecipientPeerIds: loop.expectation.expectedRecipientPeerIds
        }
    });
}

async function deliverWsDuplicates(loop: ReceiptLoop): Promise<void> {
    for (const peerId of loop.expectation.expectedRecipientPeerIds) {
        const frame = loop.server.sockets[peerId].sent.find((frame) => decodePersistedALMessage(frame).id.msgId === loop.origin.handle.msgId)!;
        expect(frame).toBeDefined();
        const accepted = await loop.receivers[peerId].ws.acceptIncomingMessage(decodePersistedALMessage(frame));
        expect(accepted.left).toBeUndefined();
        expect(accepted.right?.kind).toBe('duplicate');
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.receivers.b.delivered).toEqual(loop.expectation.delivered.b);
    expect(loop.receivers.c.delivered).toEqual(loop.expectation.delivered.c);
}

function readSubmittedAck(receiver: ReceiptLoopReceiver, peerId: 'b' | 'c'): ALMessage {
    const message = receiver.socket.sent.map(decodePersistedALMessage).find((message) => message.payload.typeId === AL_CONTROL_ACK_TYPE_ID)!;
    expect(message).toBeDefined();
    expect(message.id.senderId).toBe(peerId);
    expect(decodeALAckPayload(JSON.parse(message.payload.resource))).toMatchObject({
        fromPeerId: peerId,
        toPeerId: 'a',
        originPeerId: 'a',
        logicalRecipientPeerId: peerId,
        carrier: 'ws',
        status: 'delivered'
    });
    return message;
}

function readServerReceipts(server: ReceiptLoopServer): readonly ALReceiptPayload[] {
    return server.sockets.a.sent.map(decodePersistedALMessage)
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
}

async function returnReceiptToOrigin(loop: ReceiptLoop, phase: ALReceiptPayload['phase']): Promise<void> {
    const frame = loop.server.sockets.a.sent.find((frame) => {
        const message = decodePersistedALMessage(frame);
        return message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID && decodeALReceiptPayload(JSON.parse(message.payload.resource)).phase === phase;
    })!;
    const message = decodePersistedALMessage(frame);
    expect(decodeALReceiptPayload(JSON.parse(message.payload.resource))).toMatchObject({
        msgId: loop.origin.handle.msgId,
        originPeerId: 'a',
        expectedRecipientPeerIds: loop.expectation.expectedRecipientPeerIds,
        snapshotVersion: 4,
        phase
    });
    await loop.origin.ws.socket.receive(frame);
}

function registerReceiptLoopCleanup(disposals: readonly (() => void | Promise<void>)[]): void {
    onTestFinished(async (context) => {
        const primaryFailed = context.task.result?.state === 'fail';
        const outcomes = await Promise.allSettled(disposals.map((dispose) => Promise.resolve().then(dispose)));
        const failures: Error[] = [];
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') {
                failures.push(toError(outcome.reason));
            }
        }
        console.info('Cross-carrier receipt cleanup joined', JSON.stringify({ owners: disposals.length, failures: failures.length, primaryFailed }));
        if (failures[0] !== undefined && !primaryFailed) {
            throw failures[0];
        }
    });
}
