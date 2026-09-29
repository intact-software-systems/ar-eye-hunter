import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALAckControlMessage,
    newALReceiptControlMessage,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';
import {
    createDefaultInMemoryALOutboundRuntimeStores,
    createVolatileALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeStores,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
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
    readonly diagnostics: ALOutboundRuntimeDiagnosticsEvent[];
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
            // A `receiver` receipt at a WS origin names no hop; its server's peer id is the hop of a `hop` or `subtree` send only.
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            confirmedRecipientPeerIds: ['b', 'c'],
            unconfirmedRecipientPeerIds: [],
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
            mode: 'receiver',
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: ['c'],
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

describe('WS client receipt tracking for a volatile send whose server receipt arrives after the deadline (D74)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('settles a timed-out aggregate that arrives inside the receipt grace', async () => {
        const { fixture, message } = await sendVolatileRoomMessage();
        vi.setSystemTime(message.constraints!.expiresAtMs! + AL_RECEIPT_DEADLINE_GRACE_MS - 1);

        expect((await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']))).left).toBeUndefined();

        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            msgId: 'room-message-1',
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: ['c'],
            complete: false
        });
    });

    it('settles nothing for an aggregate that arrives once the grace has passed', async () => {
        const { fixture, message } = await sendVolatileRoomMessage();
        const acknowledgements = () => fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');
        const admittedAcknowledgements = acknowledgements().length;
        vi.setSystemTime(message.constraints!.expiresAtMs! + AL_RECEIPT_DEADLINE_GRACE_MS);

        expect((await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']))).left).toBeUndefined();

        expect(acknowledgements()).toHaveLength(admittedAcknowledgements);
    });
});

describe('WS client receipt tracking for a receiver unicast that names its room (D53)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('expects nobody at admission; the admitted receipt names the addressee and its complete receipt acknowledges it', async () => {
        const fixture = await createReceiptTrackingFixture();
        const unicast: ALMessage = {
            ...roomMessage(),
            id: { ...roomMessage().id, msgId: 'unicast-message-1' },
            targets: { mode: 'unicast', toPeerId: 'b', groupRef: ROOM }
        };
        expect((await fixture.service.enqueueOutboxIfAbsent(unicast)).verdict.kind).toBe(
            'admitted'
        );
        const readUnicastReceipt = async () =>
            await fixture.outboundStores.admissionStore.readReceiptState({
                originPeerId: 'self',
                msgId: 'unicast-message-1'
            });
        expect(await readUnicastReceipt()).toBeUndefined();

        await fixture.service.acceptIncomingMessage(
            receiptMessage('admitted', [], 'unicast-message-1', ['b'])
        );
        expect(await readUnicastReceipt()).toMatchObject({
            mode: 'receiver',
            expectedPeerIds: ['b'],
            ackedPeerIds: []
        });
        await fixture.service.acceptIncomingMessage(
            receiptMessage('complete', ['b'], 'unicast-message-1', ['b'])
        );

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'unicast-message-1',
            mode: 'receiver',
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });
});

describe('WS client receipts the server answers itself (R-S3a-4, D57 as applied)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('tracks a hop room send against its server, the one hop a WS origin has', async () => {
        const fixture = await createReceiptTrackingFixture();
        const hop: ALMessage = {
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'none' },
            qos: { ack: { algo: 'hop' } }
        };
        await fixture.service.enqueueOutboxIfAbsent(hop);
        expect(await readReceipt(fixture)).toMatchObject({
            mode: 'hop',
            expectedPeerIds: ['server'],
            ackedPeerIds: []
        });

        await fixture.service.acceptIncomingMessage(serverAck('room-message-1'));

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'room-message-1',
            mode: 'hop',
            confirmedHopPeerIds: ['server'],
            unconfirmedHopPeerIds: [],
            complete: true
        });
    });

    it('tracks a subtree room send against its server and completes on the server\'s own delivered ACK', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent({
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'group-leader' }
        });
        expect(await readReceipt(fixture)).toMatchObject({
            mode: 'subtree',
            expectedPeerIds: ['server'],
            ackedPeerIds: []
        });

        await fixture.service.acceptIncomingMessage(serverAck('room-message-1'));

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'room-message-1',
            mode: 'subtree',
            confirmedHopPeerIds: ['server'],
            unconfirmedHopPeerIds: [],
            complete: true
        });
    });

    it('expects the server itself for a receiver command addressed to it and completes on the server\'s own ACK', async () => {
        const fixture = await createReceiptTrackingFixture();
        const command: ALMessage = {
            ...roomMessage(),
            id: { ...roomMessage().id, msgId: 'server-command-1' },
            targets: { mode: 'unicast', toPeerId: 'server', groupRef: ROOM }
        };
        await fixture.service.enqueueOutboxIfAbsent(command);
        expect(
            await fixture.outboundStores.admissionStore.readReceiptState({
                originPeerId: 'self',
                msgId: 'server-command-1'
            })
        )
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['server'], ackedPeerIds: [] });

        await fixture.service.acceptIncomingMessage(serverAck('server-command-1'));

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'server-command-1',
            mode: 'receiver',
            confirmedRecipientPeerIds: ['server'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });

    it('tracks no server hop while the server named no peer id: one that predates S3c-i (R-S3c-i-6)', async () => {
        const fixture = await createReceiptTrackingFixture({ serverPeerId: undefined });

        await fixture.service.enqueueOutboxIfAbsent({
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'none' },
            qos: { ack: { algo: 'hop' } }
        });

        expect(await readReceipt(fixture)).toBeUndefined();
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
            expect.objectContaining({
                confirmedHopPeerIds: [],
                unconfirmedHopPeerIds: [],
                expectedRecipientPeerIds: [],
                confirmedRecipientPeerIds: [],
                unconfirmedRecipientPeerIds: [],
                complete: true
            })
        ]);
    });

    it('settles a complete aggregate that overtook its admitted receipt, and the late admitted receipt moves nothing', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        const acknowledgements = () => fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');

        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));

        expect(acknowledgements()).toEqual([
            expect.objectContaining({ confirmedRecipientPeerIds: ['b', 'c'], unconfirmedRecipientPeerIds: [], complete: true })
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
            expect(acknowledgements.at(-1)).toMatchObject({ confirmedRecipientPeerIds: ['b', 'c'], unconfirmedRecipientPeerIds: [], complete: true });
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

    it('states one control-admission diagnostic per receipt control, admitted or refused, keyed by the control', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c'], 'unsent-message'));

        expect(fixture.diagnostics.filter((event) => event.kind === 'control-admission')).toEqual([
            {
                kind: 'control-admission',
                msgId: 'receipt-admitted',
                typeId: AL_CONTROL_RECEIPT_TYPE_ID,
                targetMsgId: 'room-message-1',
                outcome: 'committed',
                reason: 'none',
                phase: 'admitted'
            },
            {
                kind: 'control-admission',
                msgId: 'receipt-complete',
                typeId: AL_CONTROL_RECEIPT_TYPE_ID,
                targetMsgId: 'unsent-message',
                outcome: 'rejected',
                reason: 'AL receipt names no retained outbound message of its origin',
                phase: 'complete'
            }
        ]);
    });

    // R-S3a-9: a recipe waits for the `complete` receipt by matching the serialized event in its key order. The
    // phase comes last, so a wait that names no phase still matches the same event.
    it('states the receipt phase after the outcome and reason of the serialized diagnostic', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));

        const [admission] = fixture.diagnostics.filter((event) => event.kind === 'control-admission');
        expect(JSON.stringify(admission)).toContain(
            `"typeId":"${AL_CONTROL_RECEIPT_TYPE_ID}","targetMsgId":"room-message-1","outcome":"committed","reason":"none","phase":"admitted"`
        );
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

interface ReceiptTrackingFixtureInput {
    readonly serverPeerId: string | undefined;
    /** The memory pair a volatile send is admitted to; absent, every send uses the one pair. */
    readonly outboundVolatileStores?: ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage>;
}

async function createReceiptTrackingFixture(
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
        outboundDiagnostics: (event) => diagnostics.push(event)
    });
    onTestFinished(() => service.close());
    return { service, outboundStores, settlements, diagnostics };
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

/** The server's own ACK: it speaks for itself as the recipient and is addressed to the origin. */
function serverAck(ackedMsgId: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `server-ack-${ackedMsgId}`, senderId: 'server', ts: Date.now() },
        {
            ackedMsgId,
            fromPeerId: 'server',
            toPeerId: 'self',
            originPeerId: 'self',
            logicalRecipientPeerId: 'server',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

interface VolatileRoomSend {
    readonly fixture: ReceiptTrackingFixture;
    readonly message: ALMessage;
}

/** A volatile receiver room send on the WS client, whose server has stated the admitted audience. */
async function sendVolatileRoomMessage(): Promise<VolatileRoomSend> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const fixture = await createReceiptTrackingFixture({
        serverPeerId: 'server',
        outboundVolatileStores: createVolatileALOutboundRuntimeStores(
            { decodePrepared: decodeALOutboundTransportMessage },
            undefined
        )
    });
    const message: ALMessage = { ...roomMessage(), qos: { durability: { algo: 'volatile' } } };
    expect((await fixture.service.enqueueOutboxIfAbsent(message)).verdict.kind).toBe('admitted');
    await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
    // The receipt row lives in the memory pair, never in the durable one.
    expect(await readReceipt(fixture)).toBeUndefined();
    return { fixture, message };
}
