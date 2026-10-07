import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { BROWSER_DELIVERY_RETENTION } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage, newALReceiptControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { resolveALChannelSendDefaults } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    isALDeliveryTerminal,
    type ALDeliveryCarrier,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import {
    acknowledgeAtOrigin,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    toOriginDirectedSnapshot,
    type RtcOriginOverlayFixture
} from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const SESSION_ID = 'session-1';
const TTL_MS = 30_000;
const SERVER_PEER_ID = 'server';

interface DispatchHarness {
    readonly registry: BrowserRallarDeliveryRegistry;
    send(message: ALMessage): RallarMessageHandle;
}

type CarrierAdmission = (message: ALMessage) => Promise<ALOutboundEnqueueResult>;

describe('the receipt a WS send tracks reaches its handle (R-S3a-4)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it.each([
        {
            ackLabel: 'qos.ack hop',
            ack: 'none' as const,
            qos: { ack: { algo: 'hop' as const } },
            requested: 'hop' as const
        },
        {
            ackLabel: 'qos.ack subtree',
            ack: 'none' as const,
            qos: { ack: { algo: 'subtree' as const } },
            requested: 'subtree' as const
        }
    ])(
        'keeps a room send asking $ackLabel open past transport acceptance, tracking the server as its hop (R-S3a-4)',
        async ({ ack, qos, requested }) => {
            const harness = await createWsDispatchHarness(SERVER_PEER_ID);
            const handle = harness.send(
                newALMulticastMessage(SESSION_ID, toRoute('room-hop'), ORIGIN_ROOM, 'chat.message.v1', {
                    text: 'hop'
                }, { reliability: 'at-least-once', ack, ttlMs: TTL_MS, qos })
            );

            await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

            expect(handle.lifecycle()).toMatchObject({ receiptAlgo: requested });
            expect(handle.lifecycle().evidence.receiptDowngrade).toBeUndefined();
            expect(isALDeliveryTerminal(handle.lifecycle())).toBe(false);
        }
    );

    it.each([
        {
            ackLabel: 'qos.ack hop',
            ack: 'none' as const,
            qos: { ack: { algo: 'hop' as const } },
            requested: 'hop' as const
        },
        {
            ackLabel: 'qos.ack subtree',
            ack: 'none' as const,
            qos: { ack: { algo: 'subtree' as const } },
            requested: 'subtree' as const
        }
    ])(
        'ends a room send asking $ackLabel at transport-accepted, naming the downgrade, while the server named no peer id (R-S3c-i-6)',
        async ({ ack, qos, requested }) => {
            const harness = await createWsDispatchHarness(undefined);
            const handle = harness.send(
                newALMulticastMessage(SESSION_ID, toRoute('room-hop-server-unknown'), ORIGIN_ROOM, 'chat.message.v1', {
                    text: 'hop'
                }, { reliability: 'at-least-once', ack, ttlMs: TTL_MS, qos })
            );

            await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

            expect(handle.lifecycle()).toMatchObject({ receiptAlgo: 'none' });
            expect(handle.lifecycle().evidence.receiptDowngrade).toEqual({ requested, tracked: 'none' });
            expect(isALDeliveryTerminal(handle.lifecycle())).toBe(true);
        }
    );

    it('keeps a unicast send asking qos.ack hop open past transport acceptance, with no downgrade', async () => {
        const harness = await createWsDispatchHarness(SERVER_PEER_ID);
        const handle = harness.send({
            ...newALUnicastMessage(SESSION_ID, toRoute('unicast-hop'), 'peer-b', 'chat.message.v1', { text: 'hop' }, {
                ttlMs: TTL_MS
            }),
            delivery: { reliability: 'at-least-once', ack: 'none' },
            qos: { ack: { algo: 'hop' } }
        });

        await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

        expect(handle.lifecycle()).toMatchObject({ receiptAlgo: 'hop' });
        expect(handle.lifecycle().evidence.receiptDowngrade).toBeUndefined();
        expect(isALDeliveryTerminal(handle.lifecycle())).toBe(false);
    });

    it('keeps a default notification room send tracking receiver, with no downgrade', async () => {
        const harness = await createWsDispatchHarness(SERVER_PEER_ID);
        const defaults = resolveALChannelSendDefaults({ purpose: 'notification', durability: undefined, hasLogicalAudience: true });
        const handle = harness.send(newALMulticastMessage(SESSION_ID, toRoute('room-default'), ORIGIN_ROOM, 'chat.message.v1', {
            text: 'default'
        }, {
            reliability: defaults.reliability,
            ack: defaults.ack,
            ttlMs: defaults.ttlMs,
            qos: { durability: { algo: defaults.durability } }
        }));

        await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

        expect(handle.lifecycle()).toMatchObject({ receiptAlgo: 'receiver' });
        expect(handle.lifecycle().evidence.receiptDowngrade).toBeUndefined();
        expect(isALDeliveryTerminal(handle.lifecycle())).toBe(false);
    });
});

describe('the receipt an RTC send tracks reaches its handle (R-S3a-4)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps a room send asking qos.ack hop tracking hop, with no downgrade', async () => {
        vi.useFakeTimers();
        const fixture = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a', 'b', 'c'], 4), nextHopPeerIds: ['b', 'c'] });
        const harness = createDispatchHarness(createRegistry(), 'rtc', { rtc: (message) => fixture.manager.enqueueIfAbsent(message) });
        const handle = harness.send(newALMulticastMessage('a', toRoute('rtc-hop'), ORIGIN_ROOM, 'chat.message.v1', { text: 'hop' }, {
            reliability: 'at-least-once',
            ack: 'none',
            ttlMs: TTL_MS,
            qos: { ack: { algo: 'hop' } }
        }));

        await vi.advanceTimersByTimeAsync(0);

        expect(handle.lifecycle().evidence.admittedAtMs).toBeDefined();
        expect(handle.lifecycle()).toMatchObject({ receiptAlgo: 'hop' });
        expect(handle.lifecycle().evidence.receiptDowngrade).toBeUndefined();
        expect(isALDeliveryTerminal(handle.lifecycle())).toBe(false);
    });
});

describe('the receipt a WS fallback leg tracks reaches its handle (R-S3a-4)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    // The RTC leg's `unroutable` leaves the handle's receipt alone; the WS leg that takes over tracks the server as the
    // room send's one hop, so the handle stays open for the server's ACK (R-S3a-4 closed by S3c-i).
    it('keeps a room send asking qos.ack hop open on its WS leg after its RTC leg is unroutable', async () => {
        const registry = createRegistry();
        const ws = await createWsClient(registry, 'a', SERVER_PEER_ID);
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 4),
            nextHopPeerIds: []
        });
        const harness = createDispatchHarness(registry, 'rtc', {
            rtc: (message) => fixture.manager.enqueueIfAbsent(message),
            ws: (message) => ws.enqueueOutboxIfAbsent(message)
        });
        const handle = harness.send(
            newALMulticastMessage('a', toRoute('fallback-hop'), ORIGIN_ROOM, 'chat.message.v1', {
                text: 'hop'
            }, {
                reliability: 'at-least-once',
                ack: 'none',
                ttlMs: TTL_MS,
                qos: { ack: { algo: 'hop' } }
            })
        );

        await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

        expect(handle.lifecycle()).toMatchObject({ receiptAlgo: 'hop' });
        expect(handle.lifecycle().evidence.receiptDowngrade).toBeUndefined();
        expect(
            handle.lifecycle().evidence.attempts.map(({ carrier, outcome }) => ({ carrier, outcome }))
        ).toEqual([
            { carrier: 'rtc', outcome: 'unroutable' },
            { carrier: 'ws', outcome: 'sent' }
        ]);
        expect(isALDeliveryTerminal(handle.lifecycle())).toBe(false);
    });
});

describe('the leader receipt of a group-leader room send reaches its handle', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)(
        'ends a group-leader send on %s acknowledged when the director session confirms it, with no WS leg',
        async (strategy) => {
            const leg = await createLeaderRtcLeg(toOriginDirectedSnapshot(createOriginSnapshot(['a', 'b', 'c'], 4), 'c'), strategy);
            const handle = leg.harness.send(createLeaderSend('a', `leader-acknowledged-${strategy}`));
            await expect.poll(() => handle.lifecycle().evidence.admittedAtMs).toBeDefined();

            await acknowledgeAtOrigin(leg.fixture.manager, {
                msgId: handle.msgId,
                fromPeerId: 'c',
                logicalRecipientPeerId: 'c',
                status: 'delivered'
            });
            await recordCompleteAcknowledgement(leg);

            expect(handle.lifecycle()).toMatchObject({
                state: 'acknowledged',
                receiptAlgo: 'leader',
                evidence: { receiptMode: 'leader', expectedRecipientPeerIds: ['c'], confirmedRecipientPeerIds: ['c'] }
            });
            expect(leg.wsAdmissions).toEqual([]);
        }
    );

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)(
        'ends a group-leader send on %s rejected for no leader when the room appoints no director, with no fallback',
        async (strategy) => {
            const leg = await createLeaderRtcLeg(createOriginSnapshot(['a', 'b', 'c'], 4), strategy);
            const handle = leg.harness.send(createLeaderSend('a', `leader-refused-${strategy}`));

            await expect.poll(() => handle.lifecycle().state).toBe('rejected');

            expect(handle.lifecycle().evidence.failure).toEqual({ kind: 'refused', reason: 'no-leader' });
            expect(handle.lifecycle().evidence.carrierFallback).toBeUndefined();
            expect(leg.wsAdmissions).toEqual([]);
        }
    );

    it('ends a group-leader send on ws acknowledged when the server\'s receipt names the director confirmed', async () => {
        const registry = createRegistry();
        const ws = await createWsClient(registry, SESSION_ID, SERVER_PEER_ID);
        const harness = createDispatchHarness(registry, 'ws', { ws: (message) => ws.enqueueOutboxIfAbsent(message) });
        const handle = harness.send(createLeaderSend(SESSION_ID, 'leader-acknowledged-ws'));
        await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

        await ws.acceptIncomingMessage(toLeaderReceipt(handle.msgId, 'admitted', []));
        await ws.acceptIncomingMessage(toLeaderReceipt(handle.msgId, 'complete', ['director']));

        await expect.poll(() => handle.lifecycle().state).toBe('acknowledged');
        expect(handle.lifecycle()).toMatchObject({
            receiptAlgo: 'leader',
            evidence: { receiptMode: 'leader', expectedRecipientPeerIds: ['director'], confirmedRecipientPeerIds: ['director'] }
        });
    });

    it('ends a group-leader send on ws rejected by the server\'s no-leader refusal, as its relay rejection', async () => {
        const registry = createRegistry();
        const ws = await createWsClient(registry, SESSION_ID, SERVER_PEER_ID);
        const harness = createDispatchHarness(registry, 'ws', { ws: (message) => ws.enqueueOutboxIfAbsent(message) });
        const handle = harness.send(createLeaderSend(SESSION_ID, 'leader-refused-ws'));
        await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

        await ws.acceptIncomingMessage(newALNackControlMessage(
            { v: 3, msgId: 'nack-no-leader', senderId: SERVER_PEER_ID, ts: Date.now() },
            { msgId: handle.msgId, fromPeerId: SERVER_PEER_ID, toPeerId: SESSION_ID, reason: 'no-leader', observedAtEpochMs: Date.now() }
        ));

        await expect.poll(() => handle.lifecycle().state).toBe('rejected');
        expect(handle.lifecycle().evidence.failure).toEqual({
            kind: 'relay-rejected',
            rejection: { relay: 'trusted-server', reason: 'no-leader' }
        });
    });
});

interface LeaderRtcLeg {
    readonly fixture: RtcOriginOverlayFixture;
    readonly harness: DispatchHarness;
    readonly wsAdmissions: readonly ALMessage[];
}

/** The RTC origin `a` and, on the fallback strategy, a WS leg that records every message handed to it. */
async function createLeaderRtcLeg(
    snapshot: ReturnType<typeof createOriginSnapshot>,
    strategy: 'rtc' | 'rtc-with-ws-fallback'
): Promise<LeaderRtcLeg> {
    const registry = createRegistry();
    const fixture = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
    const wsAdmissions: ALMessage[] = [];
    const ws = strategy === 'rtc' ? undefined : await createWsClient(registry, 'a', SERVER_PEER_ID);
    const harness = createDispatchHarness(registry, 'rtc', {
        rtc: (message) => fixture.manager.enqueueIfAbsent(message),
        ...(ws === undefined ? {} : {
            ws: (message: ALMessage) => {
                wsAdmissions.push(message);
                return ws.enqueueOutboxIfAbsent(message);
            }
        })
    });
    return { fixture, harness, wsAdmissions };
}

/**
 * The harness opens its delivery feed with a no-op relay, so the test relays the RTC origin's complete settlement to
 * the handle registry itself.
 */
async function recordCompleteAcknowledgement(leg: LeaderRtcLeg): Promise<void> {
    const isComplete = (settlement: ALDeliverySettlement) => settlement.kind === 'acknowledgement' && settlement.complete;
    await expect.poll(() => leg.fixture.settlements.some(isComplete)).toBe(true);
    leg.fixture.settlements.filter(isComplete).forEach((settlement) => leg.harness.registry.record(settlement));
}

function createLeaderSend(senderId: string, resourceId: string): ALMessage {
    return newALMulticastMessage(senderId, toRoute(resourceId), ORIGIN_ROOM, 'chat.message.v1', { text: 'lead' }, {
        reliability: 'at-least-once',
        ack: 'group-leader',
        ttlMs: TTL_MS
    });
}

function toLeaderReceipt(msgId: string, phase: ALReceiptPayload['phase'], confirmedRecipientPeerIds: readonly string[]): ALMessage {
    return newALReceiptControlMessage(
        { v: 3, msgId: `receipt-${phase}-${msgId}`, senderId: SERVER_PEER_ID, ts: Date.now() },
        {
            msgId,
            originPeerId: SESSION_ID,
            expectedRecipientPeerIds: ['director'],
            confirmedRecipientPeerIds,
            snapshotVersion: 4,
            phase,
            observedAtEpochMs: Date.now()
        }
    );
}

function toRoute(resourceId: string): ALMessage['route'] {
    return { topicId: 'chat', resourceId, contextId: ORIGIN_ROOM.groupId };
}

/** The origin WS client, connected to a native socket that accepts every frame it writes. */
async function createWsDispatchHarness(serverPeerId: string | undefined): Promise<DispatchHarness> {
    const registry = createRegistry();
    const service = await createWsClient(registry, SESSION_ID, serverPeerId);
    return createDispatchHarness(registry, 'ws', { ws: (message) => service.enqueueOutboxIfAbsent(message) });
}

async function createWsClient(
    registry: BrowserRallarDeliveryRegistry,
    sessionId: string,
    serverPeerId: string | undefined
): Promise<WsQueueBoxClientService> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const client = new JsonWebSocketClient('ws://configured-server', createPassThroughTransportFaultPort());
    const connected = client.connect();
    await Promise.resolve();
    TestWebSocket.instances.at(-1)!.open();
    await connected;
    const service = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: client,
        sessionId,
        serverPeerId,
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage }),
        outboundSettlements: (settlement) => registry.record(settlement)
    });
    onTestFinished(() => service.close());
    return service;
}

function createRegistry(): BrowserRallarDeliveryRegistry {
    return new BrowserRallarDeliveryRegistry({ nowMs: Date.now, ...BROWSER_DELIVERY_RETENTION, cancel: () => {} });
}

/** The browser's own dispatch and registry over real carrier admissions; with both carriers it may fall back. */
function createDispatchHarness(
    registry: BrowserRallarDeliveryRegistry,
    carrier: ALDeliveryCarrier,
    admits: Readonly<Partial<Record<ALDeliveryCarrier, CarrierAdmission>>>
): DispatchHarness {
    const middleware: ApiMiddleware = createDefaultApiMiddlewareTestDouble({
        middleware: {
            ...(admits.ws === undefined ? {} : { webSocketQueueBox: { enqueueOutboxIfAbsent: admits.ws } }),
            ...(admits.rtc === undefined ? {} : { rtcRxStreamer: { enqueueOutboxIfAbsent: admits.rtc } })
        }
    });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(registry, {
        deliverySettlements: feed,
        readMiddleware: () => middleware,
        readRtcCaptureReceipt: () => undefined
    }, () => middleware.session);
    sessionDeliveries.beginSession(middleware.session);
    feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
    const dispatch = new BrowserRallarMessageDispatch({ deliveries: registry, sessionDeliveries, nowMs: Date.now });
    const canFallback = admits.ws !== undefined && admits.rtc !== undefined;
    return {
        registry,
        send: (message) => {
            const handle = registry.open(message, carrier);
            dispatch.send({
                requestedConfiguration: undefined,
                rtcCapture: { status: 'unavailable', reason: 'absent' },
                context: middleware,
                carrier,
                message,
                canFallback,
                payloadIssues: [],
                onStorageUnavailable: 'refuse'
            });
            return handle;
        }
    };
}
