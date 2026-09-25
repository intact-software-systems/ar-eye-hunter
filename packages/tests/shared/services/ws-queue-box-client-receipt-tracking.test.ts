import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_RECEIPT_DEADLINE_GRACE_MS, newALReceiptControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
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
        vi.useRealTimers();
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

        // The complete aggregate leaves its final snapshot, so a redelivered receipt finds nothing to move.
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

    it('settles a timed-out aggregate at the message deadline, naming the missing recipient, and keeps its final snapshot', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        const fixture = await createReceiptTrackingFixture();
        const message = roomMessage();
        await fixture.service.enqueueOutboxIfAbsent(message);
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        // The server sweeps the aggregate once the message deadline has passed; its receipt arrives after it.
        vi.setSystemTime(message.constraints!.expiresAtMs! + 50);

        expect((await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']))).left).toBeUndefined();

        expect(await readReceipt(fixture)).toMatchObject({ expectedPeerIds: ['b', 'c'], ackedPeerIds: ['b'] });
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

describe('WS client receipt admission edges', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('acknowledges an empty admitted audience at once', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', [], 'room-message-1', []));

        expect(await readReceipt(fixture)).toMatchObject({ expectedPeerIds: [], ackedPeerIds: [] });
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([
            expect.objectContaining({ confirmedHopPeerIds: [], unconfirmedHopPeerIds: [], complete: true })
        ]);
    });

    it('settles a complete aggregate that overtook its admitted receipt, and the late admitted receipt moves nothing', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        const acknowledgements = () => fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');

        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));

        expect(acknowledgements()).toEqual([
            expect.objectContaining({ confirmedHopPeerIds: ['b', 'c'], unconfirmedHopPeerIds: [], complete: true })
        ]);
        expect(await readReceipt(fixture)).toMatchObject({ ackedPeerIds: ['b', 'c'] });
    });

    it('refuses a terminal aggregate about a message this origin never sent', async () => {
        const fixture = await createReceiptTrackingFixture();

        await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']));

        expect(await readReceipt(fixture)).toBeUndefined();
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([]);
    });

    it.each(['admitted', 'complete'] as const)(
        'refuses a redelivered %s receipt after the complete aggregate without a write or a settlement',
        async (redelivered) => {
            const fixture = await createReceiptTrackingFixture();
            await fixture.service.enqueueOutboxIfAbsent(roomMessage());
            await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
            await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));
            const settled = fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').length;

            // Receipt rows are durable at-least-once outbox rows: the same receipt may be dispatched again.
            await fixture.service.acceptIncomingMessage(receiptMessage(redelivered, redelivered === 'complete' ? ['b', 'c'] : []));

            const acknowledgements = fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');
            expect(acknowledgements).toHaveLength(settled);
            expect(acknowledgements.at(-1)).toMatchObject({ confirmedHopPeerIds: ['b', 'c'], unconfirmedHopPeerIds: [], complete: true });
            expect(await readReceipt(fixture)).toMatchObject({ ackedPeerIds: ['b', 'c'] });
        }
    );

    it.each([
        { name: 'after the admitted row it answers', admitted: true },
        { name: 'with no row at all', admitted: false }
    ])('refuses a timed-out receipt past the message deadline plus the receipt grace $name', async ({ admitted }) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        const fixture = await createReceiptTrackingFixture();
        const message = roomMessage();
        await fixture.service.enqueueOutboxIfAbsent(message);
        if (admitted) {
            await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        }
        const settled = fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').length;
        vi.setSystemTime(message.constraints!.expiresAtMs! + AL_RECEIPT_DEADLINE_GRACE_MS + 1_000);

        await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']));

        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toHaveLength(settled);
    });

    it('reads afresh after a version conflict and refuses once the conflicts outlast its attempts', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        const commit = vi.spyOn(fixture.outboundStores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));

        expect(await readReceipt(fixture)).toMatchObject({ expectedPeerIds: ['b', 'c'] });
        commit.mockResolvedValue('conflict');
        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));

        expect(await readReceipt(fixture)).toMatchObject({ ackedPeerIds: [] });
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement' && settlement.complete)).toEqual([]);
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
    msgId = 'room-message-1',
    expectedRecipientPeerIds: readonly string[] = ['b', 'c']
): ALMessage {
    return newALReceiptControlMessage(
        { v: 2, msgId: `receipt-${phase}`, senderId: 'server', ts: Date.now() },
        {
            msgId,
            originPeerId: 'self',
            expectedRecipientPeerIds,
            confirmedRecipientPeerIds,
            snapshotVersion: 7,
            phase,
            observedAtEpochMs: Date.now()
        }
    );
}
