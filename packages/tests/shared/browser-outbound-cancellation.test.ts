import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
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
import { toRateLimiter } from '@shared/resilience/rate-limiter.ts';
import { createDefaultWebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

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
            serverPeerId: 'server',
            outboundSettlements: (event) => {
                settlements.push(event);
            }
        });
        onTestFinished(() => ws.close());

        expect(rtc.cancelOutbox('pending-message', 'trace-browser-outbound-cancellation')).toBe('cancelled');
        expect(ws.cancelOutbox('pending-message', 'trace-browser-outbound-cancellation')).toBe('cancelled');
        expect(rtc.cancelOutbox('pending-message', 'trace-browser-outbound-cancellation')).toBe('already-cancelled');
        expect(ws.cancelOutbox('pending-message', 'trace-browser-outbound-cancellation')).toBe('already-cancelled');
        expect(settlements).toMatchObject([
            { kind: 'cancelled', msgId: 'pending-message', carrier: 'rtc' },
            { kind: 'cancelled', msgId: 'pending-message', carrier: 'ws' }
        ]);
    });

    it('joins a pending RTC disposal before final test cleanup', () => {
        const gate = Promise.withResolvers<void>();
        let disposed = false;
        onTestFinished(() => {
            expect(disposed).toBe(true);
        });
        const rtc = createRtcOwner([]);
        const dispose = rtc.dispose.bind(rtc);
        vi.spyOn(rtc, 'dispose').mockImplementationOnce(async () => {
            await gate.promise;
            await dispose();
            disposed = true;
        });
        onTestFinished(() => {
            setTimeout(() => gate.resolve(), 0);
        });
    });
});

function createRtcOwner(settlements: ALDeliverySettlement[]) {
    const multicast = new WebRtcOverlayMulticastManager({
        quotaNow: Date.now,
        creationNow: Temporal.Now.instant,
        connectionService: { input: { sessionId: 'self' }, readyPeerIdsForLane: () => [], readPeer: () => undefined },
        groupCache: new LatestRepository(),
        overlayCache: new LatestRepository(),
        multicasterFactory: () => {
            throw new Error('Cancellation does not construct multicast messages');
        },
        qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, undefined),
        outboundDiagnostics: undefined,
        outboundSettlements: (event) => {
            settlements.push(event);
        },
        outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter(),
        faultPort: createPassThroughTransportFaultPort(),
        dequeueResilience: createDefaultALOutboundDequeueResilience()
    });
    onTestFinished(() => multicast.dispose());
    const service = createDefaultWebRtcRxStreamerService({ multicast, sessionId: 'self' });
    onTestFinished(() => service.dispose());
    return service;
}
