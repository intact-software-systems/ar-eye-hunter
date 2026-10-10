import { onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALReceiptControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage, type ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

export interface ReceiptTrackingFixture {
    readonly service: WsQueueBoxClientService;
    readonly outboundStores: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly settlements: ALDeliverySettlement[];
    readonly diagnostics: ALOutboundRuntimeDiagnosticsEvent[];
}

interface ReceiptMessageInput {
    readonly msgId: string;
    readonly expectedRecipientPeerIds: readonly string[];
}

export interface ReceiptTrackingFixtureInput {
    readonly serverPeerId: string | undefined;
    readonly diagnosticsSink?: ALOutboundRuntimeDiagnosticsSink | null;
    /** The memory pair a volatile send is admitted to; absent, every send uses the one pair. */
    readonly outboundVolatileStores?: ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage>;
}

export async function createReceiptTrackingFixture(
    input: ReceiptTrackingFixtureInput = { serverPeerId: 'server' }
): Promise<ReceiptTrackingFixture> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const client = new JsonWebSocketClient('ws://configured-server', createPassThroughTransportFaultPort());
    const connected = client.connect();
    await Promise.resolve();
    TestWebSocket.instances.at(-1)!.open();
    await connected;
    const settlements: ALDeliverySettlement[] = [];
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage });
    const service = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: client,
        sessionId: 'self',
        serverPeerId: input.serverPeerId,
        outboundStores,
        outboundVolatileStores: input.outboundVolatileStores,
        outboundSettlements: (settlement) => settlements.push(settlement),
        outboundDiagnostics: input.diagnosticsSink === null ? undefined : input.diagnosticsSink ?? ((event) => diagnostics.push(event))
    });
    onTestFinished(() => service.close());
    return { service, outboundStores, settlements, diagnostics };
}

export function roomMessage(): ALMessage {
    return {
        id: { v: 3, msgId: 'room-message-1', ts: Date.now(), senderId: 'self' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: Date.now() + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

export function receiptMessage(
    phase: ALReceiptPayload['phase'],
    confirmedRecipientPeerIds: readonly string[],
    input: ReceiptMessageInput = { msgId: 'room-message-1', expectedRecipientPeerIds: ['b', 'c'] }
): ALMessage {
    return newALReceiptControlMessage(
        { v: 3, msgId: `receipt-${phase}`, senderId: 'server', ts: Date.now() },
        {
            msgId: input.msgId,
            originPeerId: 'self',
            expectedRecipientPeerIds: input.expectedRecipientPeerIds,
            confirmedRecipientPeerIds,
            snapshotVersion: 7,
            phase,
            observedAtEpochMs: Date.now()
        }
    );
}
