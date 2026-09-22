import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { createDefaultWebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { TestWebSocket } from './websocket/test-web-socket.ts';

afterEach(() => vi.unstubAllGlobals());

describe('browser carrier cancellation ports', () => {
    it('reaches each real outbound owner once and independently remembers cancellation', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const settlements: ALDeliverySettlement[] = [];
        const rtc = createRtcOwner(settlements);
        const ws = createDefaultWsQueueBoxClientService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketClient('ws://configured-server', createPassThroughTransportFaultPort()),
            sessionId: 'self',
            outboundSettlements: (event) => {
                settlements.push(event);
            }
        });
        onTestFinished(() => ws.close());

        expect(rtc.cancelOutbox('pending-message')).toBe('cancelled');
        expect(ws.cancelOutbox('pending-message')).toBe('cancelled');
        expect(rtc.cancelOutbox('pending-message')).toBe('already-cancelled');
        expect(ws.cancelOutbox('pending-message')).toBe('already-cancelled');
        expect(settlements).toMatchObject([
            { kind: 'cancelled', msgId: 'pending-message', carrier: 'rtc' },
            { kind: 'cancelled', msgId: 'pending-message', carrier: 'ws' }
        ]);
    });
});

function createRtcOwner(settlements: ALDeliverySettlement[]) {
    const multicast = new WebRtcOverlayMulticastManager({
        connectionService: { input: { sessionId: 'self' }, readyPeerIdsForLane: () => [], readPeer: () => undefined },
        groupCache: new LatestRepository(),
        overlayCache: new LatestRepository(),
        multicasterFactory: () => {
            throw new Error('Cancellation does not construct multicast messages');
        },
        qosProvider: undefined,
        outboundDiagnostics: undefined,
        outboundSettlements: (event) => {
            settlements.push(event);
        },
        outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter(),
        dequeueResilience: createDefaultALOutboundDequeueResilience()
    });
    const service = createDefaultWebRtcRxStreamerService({ multicast, sessionId: 'self' });
    onTestFinished(() => {
        service.dispose();
        multicast.dispose();
    });
    return service;
}
