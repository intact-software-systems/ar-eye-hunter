import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALReceiptControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

interface ReceiptTrackingFixture {
    readonly service: WsQueueBoxClientService;
    readonly outboundStores: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly settlements: ALDeliverySettlement[];
}

describe('WS client receipt tracking for a receiver room send', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('creates the pending receipt from the admitted audience and settles acknowledged on the complete aggregate', async () => {
        const fixture = await createReceiptTrackingFixture();
        const sent = await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        expect(sent.verdict.kind).toBe('admitted');
        expect(await readReceipt(fixture)).toBeUndefined();

        expect((await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []))).right).toEqual({
            kind: 'control',
            handled: false
        });
        expect(await readReceipt(fixture)).toMatchObject({
            mode: 'receiver',
            expectedPeerIds: ['b', 'c'],
            ackedPeerIds: []
        });

        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));

        expect(await readReceipt(fixture)).toMatchObject({ expectedPeerIds: ['b', 'c'], ackedPeerIds: ['b', 'c'] });
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            msgId: 'room-message-1',
            carrier: 'ws',
            mode: 'receiver',
            confirmedHopPeerIds: ['b', 'c'],
            unconfirmedHopPeerIds: [],
            complete: true
        });
    });

    it('settles a timed-out aggregate incomplete, naming the missing recipient, and ends the receipt', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));

        await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']));

        expect(await readReceipt(fixture)).toBeUndefined();
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            confirmedHopPeerIds: ['b'],
            unconfirmedHopPeerIds: ['c'],
            complete: false
        });
    });

    it('writes nothing for a repeated receipt or one about a message this origin never sent', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        const acknowledgements = () => fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');
        expect(acknowledgements()).toHaveLength(1);

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c'], 'unsent-message'));

        expect(acknowledgements()).toHaveLength(1);
        expect(await fixture.outboundStores.admissionStore.readReceiptState({ originPeerId: 'self', msgId: 'unsent-message' }))
            .toBeUndefined();
    });
});

async function createReceiptTrackingFixture(): Promise<ReceiptTrackingFixture> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const client = new JsonWebSocketClient('ws://configured-server', createPassThroughTransportFaultPort());
    const connected = client.connect();
    await Promise.resolve();
    TestWebSocket.instances.at(-1)!.open();
    await connected;
    const settlements: ALDeliverySettlement[] = [];
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage });
    const service = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: client,
        sessionId: 'self',
        outboundStores,
        outboundSettlements: (settlement) => settlements.push(settlement)
    });
    onTestFinished(() => service.close());
    return { service, outboundStores, settlements };
}

async function readReceipt(fixture: ReceiptTrackingFixture) {
    return await fixture.outboundStores.admissionStore.readReceiptState({ originPeerId: 'self', msgId: 'room-message-1' });
}

function roomMessage(): ALMessage {
    return {
        id: { v: 2, msgId: 'room-message-1', ts: Date.now(), senderId: 'self' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: Date.now() + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

function receiptMessage(
    phase: ALReceiptPayload['phase'],
    confirmedRecipientPeerIds: readonly string[],
    msgId = 'room-message-1'
): ALMessage {
    return newALReceiptControlMessage(
        { v: 2, msgId: `receipt-${phase}`, senderId: 'server', ts: Date.now() },
        {
            msgId,
            originPeerId: 'self',
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds,
            snapshotVersion: 7,
            phase,
            observedAtEpochMs: Date.now()
        }
    );
}
