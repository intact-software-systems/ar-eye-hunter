import {
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { AL_WS_SERVER_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { WsQueueBoxServerDeliveryReporting } from '@shared/services/ws-queue-box-server/ws-queue-box-server-delivery-reporting.ts';
import { WsQueueBoxServerLiveDelivery } from '@shared/services/ws-queue-box-server/ws-queue-box-server-live-delivery.ts';
import { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

interface LiveClockFixture {
    readonly socket: JsonWebSocketServer;
    readonly first: TestWebSocket;
    readonly second: TestWebSocket;
    readonly clock: LiveTestClock;
}

it('uses the service clock for live admission and rechecks message expiry before each recipient', () => {
    const fixture = createClockFixture();
    const service = createClockService(fixture);
    const send = fixture.first.send.bind(fixture.first);
    vi.spyOn(fixture.first, 'send').mockImplementation((data) => {
        send(data);
        fixture.clock.epochMs = 2000;
    });
    onTestFinished(() => {
        vi.restoreAllMocks();
    });

    const result = service.sendToTargetsWithResult({ message: createMessage(2000), inboundScope: SCOPE });

    expect(result).toMatchObject({ status: 'expired', sentCount: 1, failedCount: 0 });
    expect(fixture.first.sent).toHaveLength(1);
    expect(fixture.second.sent).toEqual([]);
});

it('uses a fresh service-clock observation for authenticated lease expiry after encoding', () => {
    const fixture = createClockFixture();
    const service = createClockService(fixture);
    const encode = fixture.socket.encode.bind(fixture.socket);
    vi.spyOn(fixture.socket, 'encode').mockImplementation((message) => {
        const encoded = encode(message);
        fixture.clock.epochMs = 2000;
        return encoded;
    });
    onTestFinished(() => {
        vi.restoreAllMocks();
    });

    const result = service.sendToTargetsWithResult({ message: createMessage(3000), inboundScope: SCOPE });

    expect(result).toMatchObject({ status: 'no-recipients', sentCount: 0, failedCount: 0 });
    expect(fixture.first.sent).toEqual([]);
    expect(fixture.second.sent).toEqual([]);
});

it('uses the injected clock for resolved-peer delivery and rejects the exact expiry boundary', () => {
    const fixture = createClockFixture();
    const live = new WsQueueBoxServerLiveDelivery({
        socket: fixture.socket,
        clock: fixture.clock,
        targetResolution: new WsQueueBoxServerTargetResolution({ socket: fixture.socket, targetResolver: {} }),
        deliveryReporting: new WsQueueBoxServerDeliveryReporting({}),
        readAuthenticatedConnectionScope: () => ({ scope: SCOPE, expiresAtEpochMs: 2000 })
    });
    const input = { peerId: 'first', message: createMessage(2000), inboundScope: SCOPE };

    expect(live.sendToResolvedPeer(input)).toBe(1);
    fixture.clock.epochMs = 2000;
    expect(live.sendToResolvedPeer(input)).toBe(0);
    expect(fixture.first.sent).toHaveLength(1);
});

class LiveTestClock {
    epochMs = 1000;

    nowMs(): number {
        return this.epochMs;
    }
}

function createClockFixture(): LiveClockFixture {
    const socket = new JsonWebSocketServer();
    const first = new TestWebSocket('ws://first');
    const second = new TestWebSocket('ws://second');
    first.open();
    second.open();
    socket.addConnection(new ConnectionContext({ id: 'first', socket: first }));
    socket.addConnection(new ConnectionContext({ id: 'second', socket: second }));
    return { socket, first, second, clock: new LiveTestClock() };
}

function createClockService(fixture: LiveClockFixture): WsQueueBoxServerService {
    const service = new WsQueueBoxServerService({
        socket: fixture.socket,
        name: 'server',
        qosProvider: toALCarrierQosInputProvider(AL_WS_SERVER_CAPABILITIES, undefined),
        targetResolver: {
            resolvePeerRecipients: () => [
                { peerId: 'first', connectionId: 'first' },
                { peerId: 'first', connectionId: 'second' }
            ]
        },
        readProducerProvenance: undefined,
        inboundRuntime: createDefaultALInboundRuntimeResources({
            selfPeerId: 'server',
            nowMs: () => fixture.clock.nowMs(),
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_INBOX)
        }),
        outboundRuntime: createDefaultALOutboundRuntimeResources({
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            nowMs: () => fixture.clock.nowMs()
        }),
        dequeueResilience: createDefaultALOutboundDequeueResilience(),
        outboundDiagnostics: undefined,
        outboundSettlements: undefined,
        inboundDiagnostics: undefined,
        outboundDeliveryOutcome: undefined,
        deliveryDiagnostics: undefined,
        validateInboundMessage: Either.ofRight,
        readAuthenticatedConnectionScope: () => ({ scope: SCOPE, expiresAtEpochMs: 2000 }),
        publishRelayedAck: undefined,
        forwardsRoomScopedMessages: false
    });
    onTestFinished(() => service.dispose());
    return service;
}

function createMessage(expiresAtMs: number): ALMessage {
    return {
        id: { v: 2, msgId: 'clock-message', senderId: 'server', ts: 1000 },
        route: { topicId: 'app.message', contextId: 'direct', resourceId: 'clock' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' },
        targets: { mode: 'unicast', toPeerId: 'first' },
        constraints: { expiresAtMs }
    };
}
