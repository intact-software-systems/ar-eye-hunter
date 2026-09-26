import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { BROWSER_DELIVERY_RETENTION } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALChannelSendDefaults } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { isALDeliveryTerminal, type ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { createOriginSnapshot, createRtcOriginOverlayFixture, ORIGIN_ROOM } from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const SESSION_ID = 'session-1';
const TTL_MS = 30_000;

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
        { ackLabel: 'qos.ack hop', ack: 'none' as const, qos: { ack: { algo: 'hop' as const } }, requested: 'hop' as const },
        { ackLabel: 'ack group-leader', ack: 'group-leader' as const, qos: undefined, requested: 'subtree' as const }
    ])(
        'ends a room send asking $ackLabel at transport-accepted, tracking none and naming the downgrade',
        async ({ ack, qos, requested }) => {
            const harness = await createWsDispatchHarness();
            const handle = harness.send(newALMulticastMessage(SESSION_ID, toRoute('room-hop'), ORIGIN_ROOM, 'chat.message.v1', {
                text: 'hop'
            }, { reliability: 'at-least-once', ack, ttlMs: TTL_MS, qos }));

            await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

            expect(handle.lifecycle()).toMatchObject({ receiptAlgo: 'none' });
            expect(handle.lifecycle().evidence.receiptDowngrade).toEqual({ requested, tracked: 'none' });
            expect(isALDeliveryTerminal(handle.lifecycle())).toBe(true);
        }
    );

    it('keeps a unicast send asking qos.ack hop open past transport acceptance, with no downgrade', async () => {
        const harness = await createWsDispatchHarness();
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
        const harness = await createWsDispatchHarness();
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
        const harness = createDispatchHarness(createRegistry(), 'rtc', (message) => fixture.manager.enqueueIfAbsent(message));
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

function toRoute(resourceId: string): ALMessage['route'] {
    return { topicId: 'chat', resourceId, contextId: ORIGIN_ROOM.groupId };
}

/** The origin WS client, connected to a native socket that accepts every frame it writes. */
async function createWsDispatchHarness(): Promise<DispatchHarness> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const client = new JsonWebSocketClient('ws://configured-server', createPassThroughTransportFaultPort());
    const connected = client.connect();
    await Promise.resolve();
    TestWebSocket.instances.at(-1)!.open();
    await connected;
    const registry = createRegistry();
    const service = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: client,
        sessionId: SESSION_ID,
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage }),
        outboundSettlements: (settlement) => registry.record(settlement)
    });
    onTestFinished(() => service.close());
    return createDispatchHarness(registry, 'ws', (message) => service.enqueueOutboxIfAbsent(message));
}

function createRegistry(): BrowserRallarDeliveryRegistry {
    return new BrowserRallarDeliveryRegistry({ nowMs: Date.now, ...BROWSER_DELIVERY_RETENTION, cancel: () => {} });
}

/** The browser's own dispatch and registry over one real carrier admission. */
function createDispatchHarness(
    registry: BrowserRallarDeliveryRegistry,
    carrier: ALDeliveryCarrier,
    admit: CarrierAdmission
): DispatchHarness {
    const middleware: ApiMiddleware = createDefaultApiMiddlewareTestDouble({
        middleware: carrier === 'ws' ? { webSocketQueueBox: { enqueueOutboxIfAbsent: admit } } : { rtcRxStreamer: { enqueueOutboxIfAbsent: admit } }
    });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(registry, { deliverySettlements: feed, readMiddleware: () => middleware });
    sessionDeliveries.beginSession(middleware.session);
    feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
    const dispatch = new BrowserRallarMessageDispatch({ deliveries: registry, sessionDeliveries, nowMs: Date.now });
    return {
        registry,
        send: (message) => {
            const handle = registry.open(message, carrier);
            dispatch.send({ context: middleware, carrier, message, canFallback: false, payloadIssues: [] });
            return handle;
        }
    };
}
