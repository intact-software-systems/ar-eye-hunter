import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID, AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALAckControlMessage,
    type ALAckPayload,
    type ALAckStatus,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage, type ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeDiagnosticsEvent, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALReceiptRecordHeadKey } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import { createInMemoryALReceiptRecordStores, type ALReceiptRecordStores } from '@shared/alm/receipt-record/al-receipt-record-stores.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import { AL_RECEIPT_RECORD_WINDOW_MS } from '@shared/alm/receipt-record/validate-al-receipt-record-opening.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { WsQueueBoxServerReceiptAggregation } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts';
import type { WsQueueBoxServerReceiptObservation } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createWorkerHold } from '../alm/create-worker-hold.ts';
import { holdALAdmissionWrite } from '../alm/hold-al-admission-write.ts';
import { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import { settleQueueEngine } from './ws-queue-box-server-receipt-fixture.ts';

import { toTestALAckPayload } from '../../al-control-test-payloads.ts';
import { readSentReceipts } from '../../ws-receipted-send-test-controls.ts';
import { attachTestWebSocket } from '../websocket/attach-test-web-socket.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const SNAPSHOT_VERSION = 7;
/** The room message's lifetime: its deadline is this long after it was sent. */
const ROOM_MESSAGE_LIFETIME_MS = 30_000;
/** The ack timeout an at-least-once message resolves to: the server's own retry window. */
const ROOM_MESSAGE_ACK_TIMEOUT_MS = 2_000;
/** The conditional commits one receipt admission tries before it retains the receipt as work. */
const RECEIPT_ADMISSION_ATTEMPTS = 3;

interface ReceiptFixture {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly outbox: InMemoryQueueBox;
    readonly sockets: Readonly<Record<'a' | 'b' | 'c', SimulatedWebSocket>>;
    readonly clock: { nowMs: number; };
    /** The origin's socket on a second instance, when the origin's live session is there. */
    readonly remoteOrigin: SimulatedWebSocket | undefined;
    /** What the server's own outbound owner stated about the messages it originated. */
    readonly settlements: ALDeliverySettlement[];
    /** What the server's own outbound owner recorded through its diagnostics sink. */
    readonly diagnostics: ALOutboundRuntimeDiagnosticsEvent[];
    /** The server's own outbound admission store, where its pending row for a fanned-out message lives. */
    readonly admissionStore: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>;
}

interface ReceiptFixtureOptions {
    /** The router's outbox branch: the admitted message leaves through the service's own outbound row. */
    readonly fanout: 'forward' | 'outbox';
    /** `remote`: the origin's live session is on a second instance that shares the outbox. */
    readonly origin: 'local' | 'remote';
    /** The room authority's audience for a room message; the whole room `a`, `b` and `c` when absent. */
    readonly authorizedPeerIds?: readonly string[];
    /** The audience the router admits an outbox-fanned message to, which its dequeue records; none when absent. */
    readonly admittedAudience?: readonly string[];
}

describe('WS server receipt aggregation for receiver acknowledgements', () => {
    it('admits a receiver ACK addressed to the origin as the aggregating relay hop', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);

        const admitted = await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');

        expect(admitted.left).toBeUndefined();
        expect(admitted.right?.kind).toBe('control');
    });

    it('refuses at ingress, as its typed return value, a receiver ACK not addressed to the origin it names', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        const misaddressed = newALAckControlMessage(
            { v: 4, msgId: 'ack-b-misaddressed', senderId: 'b', ts: fixture.clock.nowMs, traceId: 'trace-ws-queue-box-server-receipt-aggregation' },
            toTestALAckPayload({
                ackedMsgId: 'room-message-1',
                fromPeerId: 'b',
                toPeerId: 'c',
                originPeerId: 'a',
                logicalRecipientPeerId: 'b',
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: fixture.clock.nowMs
            })
        );

        const refused = await fixture.service.acceptIncomingMessage(misaddressed, 'b');

        expect(refused.left).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement is not addressed to the origin it names'
        });
    });

    it('admits a repeated receiver ACK and counts it once', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');

        const repeated = await fixture.service.acceptIncomingMessage(
            { ...receiverAck(fixture, 'b'), id: { ...receiverAck(fixture, 'b').id, msgId: 'ack-b-again' } },
            'b'
        );

        expect(repeated.left).toBeUndefined();
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual(['admitted', 'complete']);
        await settleQueueEngine(fixture.engine);
        expect(readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual(['admitted', 'complete']);
    });

    it('refuses a WS session ACK that names another recipient of a message the server originated', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        const fromServer: ALMessage = {
            ...roomMessage(fixture.clock.nowMs),
            id: { v: 4, msgId: 'server-room-1', ts: fixture.clock.nowMs, senderId: 'server', traceId: 'trace-ws-queue-box-server-receipt-aggregation' },
            delivery: undefined,
            qos: { ack: { algo: 'receiver' }, durability: { algo: 'volatile' } }
        };
        await fixture.service.enqueueOutboxIfAbsent(fromServer);
        const forged = newALAckControlMessage(
            { v: 4, msgId: 'ack-c-for-b', senderId: 'c', ts: fixture.clock.nowMs, traceId: 'trace-ws-queue-box-server-receipt-aggregation' },
            toTestALAckPayload({
                ackedMsgId: 'server-room-1',
                fromPeerId: 'c',
                toPeerId: 'server',
                originPeerId: 'server',
                logicalRecipientPeerId: 'b',
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: fixture.clock.nowMs
            })
        );

        const refused = await fixture.service.acceptIncomingMessage(forged, 'c');

        expect(refused.left).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement from a WS session speaks for another recipient than its sender'
        });
        expect(fixture.settlements.flatMap((settlement) => settlement.kind === 'acknowledgement' ? settlement.confirmedHopPeerIds : [])).not.toContain('b');
    });

    it('caps the receipt deadline at the record window whatever deadline the message names', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        const farFuture = { ...roomMessage(fixture.clock.nowMs), constraints: { expiresAtMs: fixture.clock.nowMs + 10 * 24 * 60 * 60_000 } };
        expect((await fixture.service.acceptIncomingMessage(farFuture, 'a')).right?.kind).toBe('admitted');
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual(['admitted']);

        fixture.clock.nowMs += AL_RECEIPT_RECORD_WINDOW_MS;

        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase);
        }).toEqual(['admitted', 'timed-out']);
    });

    it('answers the origin with the admitted audience at once and the complete aggregate as one more row', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        await expect.poll(() => readReceiptRows(fixture)).toEqual([
            expect.objectContaining({ phase: 'admitted', expectedRecipientPeerIds: ['b', 'c'], confirmedRecipientPeerIds: [] })
        ]);
        expect((await readReceiptRows(fixture))[0]).toMatchObject({
            msgId: 'room-message-1',
            originPeerId: 'a',
            snapshotVersion: SNAPSHOT_VERSION
        });

        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        expect((await readReceiptRows(fixture)).map((receipt) => receipt.phase)).toEqual(['admitted']);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');

        await expect.poll(async () => (await readReceiptRows(fixture)).map((receipt) => receipt.phase)).toEqual(['admitted', 'complete']);
        const receipts = await readReceiptRows(fixture);
        expect(receipts[1]).toMatchObject({
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: ['b', 'c'],
            snapshotVersion: SNAPSHOT_VERSION
        });
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual([
            'admitted',
            'complete'
        ]);
    });

    it('answers a duplicate of an admitted receiver room message with admitted again, to its sender, with what it has counted', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');

        const again = await fixture.service.acceptIncomingMessage(roomMessage(fixture.clock.nowMs), 'a');

        expect(again.right?.kind).toBe('duplicate');
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => [receipt.phase, receipt.confirmedRecipientPeerIds]))
            .toEqual([['admitted', []], ['admitted', ['b']]]);
        await settleQueueEngine(fixture.engine);
        expect(readSentReceipts(fixture.sockets.a)).toHaveLength(2);
        expect(readSentReceipts(fixture.sockets.b)).toEqual([]);
        expect(readSentReceipts(fixture.sockets.c)).toEqual([]);
        expect(readRoomMessageCopies(fixture.sockets.b)).toBe(1);
        expect(readRoomMessageCopies(fixture.sockets.c)).toBe(1);
    });

    it('answers a duplicate once its receipt has ended with its terminal phase, from the record', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local', authorizedPeerIds: ['a', 'b'] });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual(['admitted', 'complete']);

        const again = await fixture.service.acceptIncomingMessage(roomMessage(fixture.clock.nowMs), 'a');

        expect(again.right?.kind).toBe('duplicate');
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => [receipt.phase, receipt.confirmedRecipientPeerIds]))
            .toEqual([['admitted', []], ['complete', ['b']], ['complete', ['b']]]);
        expect(readSentReceipts(fixture.sockets.b)).toEqual([]);
        expect(readRoomMessageCopies(fixture.sockets.b)).toBe(1);
    });

    it('times the receipt out at the message deadline, naming a recipient that never acknowledged', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual(['admitted']);

        fixture.clock.nowMs += ROOM_MESSAGE_LIFETIME_MS;
        await fixture.engine.executeOnce();

        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual([
            'admitted',
            'timed-out'
        ]);
        expect((await readReceiptRows(fixture)).filter((receipt) => receipt.phase === 'timed-out')).toEqual([
            expect.objectContaining({ expectedRecipientPeerIds: ['b', 'c'], confirmedRecipientPeerIds: ['b'] })
        ]);
        await fixture.engine.executeOnce();
        expect(readSentReceipts(fixture.sockets.a)).toHaveLength(2);
    });

    it('keeps a complete receipt observed early deliverable until the message deadline plus the receipt grace', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        const admittedAtMs = fixture.clock.nowMs;
        await admitRoomMessage(fixture);
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual(['admitted']);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');

        const readComplete = async () =>
            (await readReceiptMessages(fixture)).find((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)).phase === 'complete');
        await expect.poll(readComplete).toBeDefined();
        const complete = await readComplete();
        expect(complete?.constraints?.expiresAtMs).toBe(admittedAtMs + ROOM_MESSAGE_LIFETIME_MS + AL_RECEIPT_DEADLINE_GRACE_MS);

        // The row is dispatched one second past the grace counted from the observed complete, as for an origin away that long.
        fixture.clock.nowMs += AL_RECEIPT_DEADLINE_GRACE_MS + 1_000;
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase);
        }).toEqual(['admitted', 'complete']);
    });

    it('sends the origin no acknowledgement of its own and never re-originates a receiver ACK under the origin name', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');
        await expect.poll(async () => (await readReceiptRows(fixture)).length).toBe(2);
        await settleQueueEngine(fixture.engine);

        const acknowledgementsToOrigin = fixture.sockets.a.sent
            .map((frame) => decodePersistedALMessage(frame))
            .filter((message) => message.payload.typeId === AL_CONTROL_ACK_TYPE_ID);
        expect(acknowledgementsToOrigin).toEqual([]);
    });

    it('aggregates a group-leader room send against the one leader its room authority admitted, as the receipt of that leader', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local', authorizedPeerIds: ['a', 'c'] });
        const leaderSend: ALMessage = { ...roomMessage(fixture.clock.nowMs), delivery: { reliability: 'at-least-once', ack: 'group-leader' } };

        expect((await fixture.service.acceptIncomingMessage(leaderSend, 'a')).right?.kind).toBe('admitted');
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => [receipt.phase, receipt.expectedRecipientPeerIds]))
            .toEqual([['admitted', ['c']]]);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');

        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => [receipt.phase, receipt.confirmedRecipientPeerIds]))
            .toEqual([['admitted', []], ['complete', ['c']]]);
        expect(readRoomMessageCopies(fixture.sockets.c)).toBe(1);
        expect(readRoomMessageCopies(fixture.sockets.b)).toBe(0);
        const acknowledgementsToOrigin = fixture.sockets.a.sent
            .map((frame) => decodePersistedALMessage(frame))
            .filter((message) => message.payload.typeId === AL_CONTROL_ACK_TYPE_ID);
        expect(acknowledgementsToOrigin).toEqual([]);
    });

    it('acknowledges a receiver unicast addressed to the server as its logical recipient', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        const toServer: ALMessage = {
            ...roomMessage(fixture.clock.nowMs),
            id: { v: 4, msgId: 'to-server-1', ts: fixture.clock.nowMs, senderId: 'a', traceId: 'trace-ws-queue-box-server-receipt-aggregation' },
            route: { topicId: 'server.command', resourceId: 'resource', contextId: 'server' },
            targets: { mode: 'unicast', toPeerId: 'server' }
        };

        expect((await fixture.service.acceptIncomingMessage(toServer, 'a')).right?.kind).toBe('admitted');

        await expect.poll(() =>
            fixture.sockets.a.sent
                .map((frame) => decodePersistedALMessage(frame))
                .filter((message) => message.payload.typeId === AL_CONTROL_ACK_TYPE_ID)
                .map((message) => JSON.parse(message.payload.resource).logicalRecipientPeerId)
        ).toEqual(['server']);
        expect(readSentReceipts(fixture.sockets.a)).toEqual([]);
    });

    it('reaches an origin whose live session is on another instance with the admitted and the complete receipt', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'remote' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');

        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readSentReceipts(fixture.remoteOrigin!).map((receipt) => receipt.phase);
        }).toEqual(['admitted', 'complete']);
        expect(readSentReceipts(fixture.sockets.a)).toEqual([]);
    });

    it('answers an outbox-fanned receiver message with one complete row and never retransmits it once complete', async () => {
        const fixture = await createReceiptFixture({ fanout: 'outbox', origin: 'local' });
        await admitRoomMessage(fixture);
        await expect.poll(() => readRoomMessageCopies(fixture.sockets.c)).toBe(1);

        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');
        await settleQueueEngine(fixture.engine);

        const receipts = await readReceiptRows(fixture);
        expect(receipts.filter((receipt) => receipt.phase === 'complete')).toHaveLength(1);
        expect(receipts.map((receipt) => receipt.phase)).toEqual(['admitted', 'complete']);

        // Past the ack timeout a server still expecting b and c would send them the message again.
        fixture.clock.nowMs += ROOM_MESSAGE_ACK_TIMEOUT_MS + 1_000;
        for (let pass = 0; pass < 12; pass += 1) {
            await fixture.engine.executeOnce();
        }
        expect(readRoomMessageCopies(fixture.sockets.b)).toBe(1);
        expect(readRoomMessageCopies(fixture.sockets.c)).toBe(1);
    });

    it.each(['local', 'remote'] as const)(
        'records outside the audience a recipient a later row of the track already reached (%s origin)',
        async (origin) => {
            const fixture = await createReceiptFixture({ fanout: 'outbox', origin, admittedAudience: ['b', 'c'] });
            // A later row of `a`'s track reached `b` first, as another instance's dequeue of it would.
            const later = trackedRoomMessage('room-message-2', 2, fixture.clock.nowMs);
            await fixture.service.enqueueOutboxIfAbsent(later, toRouterAuthority(['b']));
            await expect.poll(() => fixture.sockets.b.sent.some((frame) => decodePersistedALMessage(frame).id.msgId === later.id.msgId))
                .toBe(true);

            const accepted = await fixture.service.acceptIncomingMessage(trackedRoomMessage('room-message-1', 1, fixture.clock.nowMs), 'a');
            await expect.poll(() => readRoomMessageCopies(fixture.sockets.c)).toBe(1);
            await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');

            expect(accepted.right?.kind).toBe('admitted');
            await expect.poll(async () => (await readReceiptRows(fixture)).find((receipt) => receipt.phase === 'complete')).toMatchObject({
                expectedRecipientPeerIds: ['b', 'c'],
                confirmedRecipientPeerIds: ['c'],
                outsideAudienceRecipientPeerIds: ['b']
            });
            expect(readRoomMessageCopies(fixture.sockets.b)).toBe(0);
        }
    );

    it('retains a terminal receipt the server pending row could not take as work, and completes the row when its replay commits', async () => {
        const fixture = await createReceiptFixture({ fanout: 'outbox', origin: 'local' });
        await admitRoomMessage(fixture);
        await expect.poll(() => readRoomMessageCopies(fixture.sockets.c)).toBe(1);
        const commitBundle = fixture.admissionStore.commitBundle.bind(fixture.admissionStore);
        let conflicts = 0;
        // Only the receipt admission writes the pending row with no work: its inline attempts all conflict.
        vi.spyOn(fixture.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
            const receiptOnly = bundle.durableEffects.length === 0 &&
                bundle.mutations.some((mutation) => mutation.kind === 'set-pending-ack');
            if (receiptOnly && conflicts < RECEIPT_ADMISSION_ATTEMPTS) {
                conflicts += 1;
                return 'conflict';
            }
            return await commitBundle(bundle);
        });

        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');

        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement' && settlement.complete);
        }).toEqual([expect.objectContaining({ msgId: 'room-message-1', confirmedRecipientPeerIds: ['b', 'c'] })]);
        // The terminal receipt's three inline attempts conflicted, so it was retained as work; its replay committed.
        expect(readReceiptConfirmationOutcomes(fixture, 'room-message-1')).toEqual([
            [1, 'conflict'],
            [2, 'conflict'],
            [3, 'conflict'],
            [1, 'committed']
        ]);
    });
});

describe('WS server receipt aggregation over the receipt record', () => {
    it.each([
        {
            name: 'a recipient outside the frozen audience',
            ack: { fromPeerId: 'd', logicalRecipientPeerId: 'd' },
            reason: 'AL acknowledgement confirms no recipient of the frozen audience'
        },
        {
            name: 'another message of the origin',
            ack: { fromPeerId: 'b', logicalRecipientPeerId: 'b', ackedMsgId: 'other-message' },
            reason: 'AL acknowledgement names no message its origin admitted to this sender'
        }
    ])('refuses $name as a typed rejection that counts nothing', async ({ ack, reason }) => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));

        expect(await readRuntimeRejection(fixture, aggregateAck(ack))).toEqual({ code: 'unauthorized', message: reason });
        await fixture.aggregation.acceptControlMessage(aggregateAckControl(aggregateAck(ack)));
        await fixture.aggregation.acceptControlMessage(aggregateAckControl(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' })));
        await runWorker(fixture);

        expect(readPhases(fixture)).toEqual(['admitted']);
        expect((await fixture.record.read(RECORD_REF)).right?.tally.confirmedRecipientPeerIds).toEqual(['b']);
    });

    // The count checks the sender, which the ingress hook leaves to the authority before it: a session's word is its own.
    it('counts nothing for a sender speaking for another recipient', async () => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));

        await fixture.aggregation.acceptControlMessage(aggregateAckControl(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'c' })));

        expect((await fixture.record.read(RECORD_REF)).right?.tally).toMatchObject({
            confirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: []
        });
    });

    // Pins an ACK addressed to the server that is no recipient's own word being refused by the record, which counts
    // only that word, instead of reaching the server's outbound owner, which judges every other control addressed to it.
    it('leaves to the outbound owner an ACK of a server publication that is no recipient\'s own word', async () => {
        const fixture = createAggregation();
        const relayed = aggregateAckControl(toTestALAckPayload({
            ackedMsgId: 'delta-1',
            fromPeerId: 'relay',
            toPeerId: 'server',
            originPeerId: 'server',
            logicalRecipientPeerId: 'b',
            carrier: 'rtc',
            status: 'delivered',
            observedAtEpochMs: 1_000
        }));

        await fixture.aggregation.acceptControlMessage(relayed);

        expect(fixture.ownerControls).toEqual([relayed]);
        expect((await fixture.record.read({ originPeerId: 'server', msgId: 'delta-1' })).left).toEqual({ kind: 'head-absent' });
    });

    it('counts a repeat once and answers complete exactly once', async () => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));
        const ackOf = (recipient: string) => aggregateAckControl(aggregateAck({ fromPeerId: recipient, logicalRecipientPeerId: recipient }));

        await fixture.aggregation.acceptControlMessage(ackOf('b'));
        expect(await readRuntimeRejection(fixture, aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' }))).toBeUndefined();
        await fixture.aggregation.acceptControlMessage(ackOf('b'));
        await fixture.aggregation.acceptControlMessage(ackOf('c'));
        await fixture.aggregation.acceptControlMessage(ackOf('c'));
        await runWorker(fixture);

        expect(readReceipts(fixture)).toMatchObject([{ phase: 'admitted' }, { phase: 'complete', confirmedRecipientPeerIds: ['b', 'c'] }]);
        expect(fixture.enqueued.map((message) => message.id.traceId)).toEqual([
            'trace-ws-queue-box-server-receipt-aggregation',
            'trace-ws-queue-box-server-receipt-aggregation'
        ]);
        expect((await readRuntimeRejection(fixture, aggregateAck({ fromPeerId: 'c', logicalRecipientPeerId: 'c' })))?.message)
            .toBe('AL acknowledgement names no receipt this server aggregates');
    });

    it('records a recipient whose ACK ends its hop delivering nothing outside the audience, never confirmed, and completes with it', async () => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));
        const notSubscribed = aggregateAck({ fromPeerId: 'c', logicalRecipientPeerId: 'c', status: 'subtree-complete-not-subscribed' });

        await fixture.aggregation.acceptControlMessage(aggregateAckControl(notSubscribed));
        await fixture.aggregation.acceptControlMessage(aggregateAckControl(aggregateAck({ fromPeerId: 'c', logicalRecipientPeerId: 'c' })));
        await fixture.aggregation.acceptControlMessage(aggregateAckControl(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' })));
        await runWorker(fixture);

        expect(readReceipts(fixture).at(-1)).toMatchObject({
            phase: 'complete',
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: ['b'],
            outsideAudienceRecipientPeerIds: ['c']
        });
    });

    it('records a session the server sent nothing outside the audience from the server own ACK, expected set unchanged', async () => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));

        await fixture.aggregation.acceptControlMessage(
            aggregateAckControl(aggregateAck({ fromPeerId: 'server', logicalRecipientPeerId: 'c', status: 'subtree-complete-not-subscribed' }))
        );
        await fixture.aggregation.acceptControlMessage(aggregateAckControl(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' })));
        await runWorker(fixture);

        expect(readReceipts(fixture).at(-1)).toMatchObject({
            phase: 'complete',
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: ['b'],
            outsideAudienceRecipientPeerIds: ['c']
        });
    });

    it('counts no server ACK that would confirm a recipient: the server speaks for one only to say it sent it nothing', async () => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));

        await fixture.aggregation.acceptControlMessage(aggregateAckControl(aggregateAck({ fromPeerId: 'server', logicalRecipientPeerId: 'c' })));
        await fixture.aggregation.acceptControlMessage(
            aggregateAckControl(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'c', status: 'subtree-complete-not-subscribed' }))
        );

        expect((await fixture.record.read(RECORD_REF)).right?.tally).toMatchObject({
            confirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: []
        });
    });

    it('keeps a receipt whose every recipient answered outside open until its deadline, as it confirmed nobody', async () => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt({
            ...admittedRoomMessage({ kind: 'admitted' }),
            roomAudience: { recipientPeerIds: ['a', 'c'], snapshotVersion: SNAPSHOT_VERSION }
        });

        await fixture.aggregation.acceptControlMessage(
            aggregateAckControl(aggregateAck({ fromPeerId: 'c', logicalRecipientPeerId: 'c', status: 'subtree-complete-not-subscribed' }))
        );
        await runWorker(fixture);
        expect(readPhases(fixture)).toEqual(['admitted']);

        fixture.clock.nowMs += ROOM_MESSAGE_LIFETIME_MS;
        await runWorker(fixture);

        expect(readReceipts(fixture).at(-1)).toMatchObject({
            phase: 'timed-out',
            confirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: ['c']
        });
    });

    // Its `readIngressAudience` answers `undefined`, as for a send no admission committed.
    it('starts no receipt for a message kept for admission', async () => {
        const fixture = createAggregation();

        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'pending-admission' }));

        expect(fixture.enqueued).toEqual([]);
        expect((await fixture.record.read(RECORD_REF)).left).toEqual({ kind: 'head-absent' });
        expect((await readRuntimeRejection(fixture, aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' })))?.message)
            .toBe('AL acknowledgement names no message its origin admitted to this sender');
    });

    it.each(['pending-admission', 'duplicate'] as const)(
        'answers a copy the runtime accepts %s while its head is open with admitted again, from the head it opened',
        async (kind) => {
            const fixture = createAggregation();
            const admitted = admittedRoomMessage({ kind: 'admitted' });

            await fixture.aggregation.writeAdmittedReceipt(admitted);
            await fixture.aggregation.writeAdmittedReceipt({ ...admitted, acceptance: { kind } });

            expect(readReceipts(fixture)).toMatchObject([
                { phase: 'admitted', expectedRecipientPeerIds: ['b', 'c'] },
                { phase: 'admitted', expectedRecipientPeerIds: ['b', 'c'] }
            ]);
            expect((await fixture.record.read(RECORD_REF)).right?.head.phase).toBe('open');
        }
    );

    // Pins a copy that finds its head open and complete, the count that completed it having lost its `end`, answering
    // `admitted` and leaving the head open until a window or its deadline ends it.
    it('ends a complete open head a re-sent copy finds, and its ended work delivers the complete receipt', async () => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));
        for (const recipientPeerId of ['b', 'c']) {
            expect((await fixture.record.count({ ...RECORD_REF, recipientPeerId, kind: 'confirmed' })).right?.disposition).toBe('counted');
        }

        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'duplicate' }));
        await runWorker(fixture);

        expect((await fixture.record.read(RECORD_REF)).right?.head.phase).toBe('complete');
        expect(readReceipts(fixture)).toMatchObject([
            { phase: 'admitted', confirmedRecipientPeerIds: [] },
            { phase: 'admitted', confirmedRecipientPeerIds: ['b', 'c'] },
            { phase: 'complete', confirmedRecipientPeerIds: ['b', 'c'] }
        ]);
    });

    it.each<{ readonly name: string; readonly acceptance: ALInboundMessageRuntime.Acceptance; }>([
        { name: 'not-admitted as expired', acceptance: { kind: 'not-admitted', reason: 'expired' } },
        { name: 'not-admitted as a terminated pending admission', acceptance: { kind: 'not-admitted', reason: 'pending admission has terminated' } },
        { name: 'resync-required', acceptance: { kind: 'resync-required' } },
        { name: 'admitted', acceptance: { kind: 'admitted' } },
        { name: 'as a control', acceptance: { kind: 'control', handled: true } },
        { name: 'by a disposed runtime', acceptance: { kind: 'disposed' } }
    ])('answers nothing for a copy accepted $name though its head is open, and leaves the head as it was', async ({ acceptance }) => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));
        const opened = (await fixture.record.read(RECORD_REF)).right;

        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage(acceptance));

        expect(readPhases(fixture)).toEqual(['admitted']);
        expect((await fixture.record.read(RECORD_REF)).right).toEqual(opened);
    });

    // A re-sent copy is answered with its receipt again on whichever instance it reaches: every instance reads the
    // record, so the one a copy reaches answers it, and opens nothing more.
    it('answers a duplicate on another instance from the record they share, and opens nothing more', async () => {
        const admitting = createAggregation();
        const other = createAggregation({ ingressAudience: undefined, recordStores: admitting.recordStores });
        await admitting.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));

        await other.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'duplicate' }));

        expect(readPhases(admitting)).toEqual(['admitted']);
        expect(readPhases(other)).toEqual(['admitted']);
        expect(readHeadKeys(admitting)).toHaveLength(1);
    });

    it('answers an empty audience admitted at once and opens nothing', async () => {
        const fixture = createAggregation();

        await fixture.aggregation.writeAdmittedReceipt({
            ...admittedRoomMessage({ kind: 'admitted' }),
            roomAudience: { recipientPeerIds: ['a'], snapshotVersion: SNAPSHOT_VERSION }
        });

        expect(readReceipts(fixture)).toMatchObject([{ phase: 'admitted', expectedRecipientPeerIds: [] }]);
        expect((await fixture.record.read(RECORD_REF)).left).toEqual({ kind: 'head-absent' });
    });
});

describe('WS server receipt aggregation of recipients never sent the message (D708)', () => {
    // Pins a never-sent recipient's own ACK being counted, or refused as anything but a typed `unauthorized` whose
    // observations name the guard and the refused count.
    it('refuses at the runtime check the own ACK of a recipient this server never sent the message, and counts nothing', async () => {
        const fixture = createAggregation();
        await fixture.aggregation.writeAdmittedReceipt({ ...admittedRoomMessage({ kind: 'admitted' }), neverSentRecipientPeerIds: ['c'] });
        const ack = aggregateAck({ fromPeerId: 'c', logicalRecipientPeerId: 'c' });
        const control = aggregateAckControl(ack);

        expect(await fixture.aggregation.readRelayedAckRejection(ack, { stage: 'runtime-protocol', controlIdentity: control.id })).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement comes from a recipient this server never sent the message'
        });
        await fixture.aggregation.acceptControlMessage(control);

        expect(fixture.observations.filter(({ kind }) => kind === 'ack-rejection' || kind === 'ack-count')).toMatchObject([
            { kind: 'ack-rejection', owner: 'receipt-aggregation', stage: 'runtime-protocol', failedGuards: ['never-sent'] },
            { kind: 'ack-count', outcome: 'rejected', rejectionCode: 'unauthorized' }
        ]);
        expect((await fixture.record.read(RECORD_REF)).right?.tally.confirmedRecipientPeerIds).toEqual([]);
    });

    // The record takes any `not-sent` as the owner's word, so a recipient's own ACK must never become one.
    it.each(['delivered', 'subtree-complete-not-subscribed'] as const)(
        'counts the server\'s not-sent for a never-sent recipient, never that recipient\'s own %s ACK',
        async (status) => {
            const fixture = createAggregation();
            await fixture.aggregation.writeAdmittedReceipt({ ...admittedRoomMessage({ kind: 'admitted' }), neverSentRecipientPeerIds: ['c'] });

            await fixture.aggregation.acceptControlMessage(aggregateAckControl(aggregateAck({ fromPeerId: 'c', logicalRecipientPeerId: 'c', status })));
            await fixture.aggregation.acceptControlMessage(aggregateAckControl(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' })));
            await runWorker(fixture);
            expect(readPhases(fixture)).toEqual(['admitted']);

            await fixture.aggregation.acceptControlMessage(
                aggregateAckControl(aggregateAck({ fromPeerId: 'server', logicalRecipientPeerId: 'c', status: 'subtree-complete-not-subscribed' }))
            );
            await runWorker(fixture);

            expect(readReceipts(fixture).at(-1)).toMatchObject({
                phase: 'complete',
                confirmedRecipientPeerIds: ['b'],
                outsideAudienceRecipientPeerIds: ['c']
            });
        }
    );
});

describe('WS server receipt aggregation of a re-sent copy whose admission opened no head', () => {
    // Pins a copy opening from its own room audience or never-sent list instead of the audience its admission row froze.
    it('opens the record for a copy whose admission row names recipients and whose head is absent', async () => {
        const fixture = createAggregation({ ingressAudience: ['a', 'b', 'c'], recordStores: undefined });

        await fixture.aggregation.writeAdmittedReceipt({
            ...admittedRoomMessage({ kind: 'duplicate' }),
            roomAudience: { recipientPeerIds: ['a', 'b'], snapshotVersion: SNAPSHOT_VERSION + 2 }
        });

        expect(readReceipts(fixture)).toMatchObject([
            { phase: 'admitted', expectedRecipientPeerIds: ['b', 'c'], snapshotVersion: SNAPSHOT_VERSION + 2 }
        ]);
        expect((await fixture.record.read(RECORD_REF)).right?.head.opening).toMatchObject({
            expectedRecipientPeerIds: ['b', 'c'],
            neverSentRecipientPeerIds: [],
            snapshotVersion: SNAPSHOT_VERSION + 2
        });
    });

    // Pins a copy opening a head, or answering, for an admission whose audience leaves nobody to expect.
    it('opens nothing for a copy whose admission row freezes to nobody', async () => {
        const fixture = createAggregation({ ingressAudience: ['a'], recordStores: undefined });

        await fixture.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'duplicate' }));

        expect(fixture.enqueued).toEqual([]);
        expect((await fixture.record.read(RECORD_REF)).left).toEqual({ kind: 'head-absent' });
    });

    // Pins a copy giving a second life to a receipt whose first head may already have ended and expired.
    it.each([
        { name: 'names no deadline', toMessage: (message: ALMessage): ALMessage => ({ ...message, constraints: undefined }) },
        {
            name: 'names a deadline beyond the window',
            toMessage: (message: ALMessage): ALMessage => ({ ...message, constraints: { expiresAtMs: 1_000 + AL_RECEIPT_RECORD_WINDOW_MS + 1 } })
        },
        {
            name: 'is as old as the window by its own stamp',
            toMessage: (message: ALMessage): ALMessage => ({ ...message, id: { ...message.id, ts: 1_000 - AL_RECEIPT_RECORD_WINDOW_MS } })
        }
    ])('opens nothing for a copy of a message that $name', async ({ toMessage }) => {
        const fixture = createAggregation({ ingressAudience: ['a', 'b', 'c'], recordStores: undefined });
        const copy = admittedRoomMessage({ kind: 'duplicate' });

        await fixture.aggregation.writeAdmittedReceipt({ ...copy, message: toMessage(copy.message) });

        expect(fixture.enqueued).toEqual([]);
        expect((await fixture.record.read(RECORD_REF)).left).toEqual({ kind: 'head-absent' });
    });

    // Pins a copy that loses its `open` to another instance answering nothing instead of the winner's head.
    it('answers from the record when the copy\'s open loses to another instance\'s', async () => {
        const hold = createWorkerHold();
        const recordStores = createInMemoryALReceiptRecordStores('server-ws-qbox:test', () => 1_000);
        const copying = createAggregation({
            ingressAudience: ['a', 'b', 'c'],
            recordStores: { ...recordStores, backend: holdALAdmissionWrite(recordStores.backend, hold) }
        });
        const admitting = createAggregation({ ingressAudience: undefined, recordStores });

        const answering = copying.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'duplicate' }));
        await hold.arrived;
        await admitting.aggregation.writeAdmittedReceipt(admittedRoomMessage({ kind: 'admitted' }));
        hold.release();
        await answering;

        expect(readReceipts(copying)).toMatchObject([{ phase: 'admitted', expectedRecipientPeerIds: ['b', 'c'] }]);
        expect(readHeadKeys(admitting)).toHaveLength(1);
    });
});

const RECORD_REF = { originPeerId: 'a', msgId: 'room-message-1' };

interface AggregationFixture {
    readonly aggregation: WsQueueBoxServerReceiptAggregation;
    readonly engine: InboxOutboxEngine;
    readonly enqueued: ALMessage[];
    /** The controls the aggregation handed to the server's own outbound owner. */
    readonly ownerControls: ALMessage[];
    readonly clock: { nowMs: number; };
    readonly recordStores: ALReceiptRecordStores;
    /** The test's own reader of the record the aggregation counts in. */
    readonly record: ALReceiptRecord;
    /** What the aggregation recorded through its receipt observer. */
    readonly observations: WsQueueBoxServerReceiptObservation[];
}

interface AggregationFixtureOptions {
    /** The audience the admission row holds; `undefined`, no admission of the message committed. */
    readonly ingressAudience: readonly string[] | undefined;
    /** Stores another aggregation already counts in; `undefined`, a record of its own. */
    readonly recordStores: ALReceiptRecordStores | undefined;
}

function createAggregation(
    options: AggregationFixtureOptions = { ingressAudience: undefined, recordStores: undefined }
): AggregationFixture {
    const clock = { nowMs: 1_000 };
    const engine = new InboxOutboxEngine({ nowEpochMs: () => clock.nowMs, random: () => 0, reportTaskFailure: () => undefined });
    const enqueued: ALMessage[] = [];
    const ownerControls: ALMessage[] = [];
    const observations: WsQueueBoxServerReceiptObservation[] = [];
    const recordStores = options.recordStores ?? createInMemoryALReceiptRecordStores('server-ws-qbox:test', () => clock.nowMs);
    const aggregation = new WsQueueBoxServerReceiptAggregation({
        serverPeerId: 'server',
        receiptObserver: (observation) => observations.push(observation),
        clock: { nowMs: () => clock.nowMs },
        random: () => 0,
        newControlId: () => `receipt-${enqueued.length + 1}`,
        qosProvider: undefined,
        queueEngine: engine,
        recordStores,
        readIngressAudience: async () => options.ingressAudience,
        enqueueOutbox: async (message) => {
            enqueued.push(message);
            return { verdict: { kind: 'admitted', durable: true, queuedAttempts: 0 }, message, entries: [], trackedReceiptAlgo: 'receiver' };
        },
        acceptServerControl: async (message) => {
            ownerControls.push(message);
            return { kind: 'not-handled' };
        },
        acceptServerReceipt: async () => ({ kind: 'not-handled' }),
        readOwnPendingReceipt: async () => undefined,
        readOwnPendingAck: async () => undefined
    });
    onTestFinished(() => aggregation.dispose());
    const record = new ALReceiptRecord({ ...recordStores, nowMs: () => clock.nowMs });
    return { aggregation, engine, enqueued, ownerControls, clock, recordStores, record, observations };
}

/** Drives the record's worker as its own tests do: `executeOnce` starts a batch it does not wait for. */
async function runWorker(fixture: AggregationFixture): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
        await fixture.engine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function readRuntimeRejection(fixture: AggregationFixture, ack: ALAckPayload): Promise<ALMessageRejection | undefined> {
    return await fixture.aggregation.readRelayedAckRejection(ack, { stage: 'runtime-protocol', controlIdentity: undefined });
}

function readReceipts(fixture: AggregationFixture): readonly ALReceiptPayload[] {
    return fixture.enqueued.map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
}

function readPhases(fixture: AggregationFixture): readonly ALReceiptPayload['phase'][] {
    return readReceipts(fixture).map((receipt) => receipt.phase);
}

function readHeadKeys(fixture: AggregationFixture): readonly string[] {
    const backend = fixture.recordStores.backend;
    return backend instanceof InMemoryAdmissionBackend
        ? backend.peekKeys().filter((key) => key === toALReceiptRecordHeadKey(fixture.recordStores.namespace, RECORD_REF))
        : [];
}

/** `a`'s room message as ingress hands it over: authorized to the whole room, accepted as `acceptance`. */
function admittedRoomMessage(
    acceptance: ALInboundMessageRuntime.Acceptance
): WsQueueBoxServerReceiptAggregation.AdmittedMessage {
    return {
        message: roomMessage(1_000),
        originPeerId: 'a',
        roomAudience: { recipientPeerIds: ['a', 'b', 'c'], snapshotVersion: SNAPSHOT_VERSION },
        acceptance,
        neverSentRecipientPeerIds: []
    };
}

function aggregateAck(
    ack: Readonly<{ fromPeerId: string; logicalRecipientPeerId: string; ackedMsgId?: string; status?: ALAckStatus; }>
): ALAckPayload {
    return toTestALAckPayload({
        ackedMsgId: ack.ackedMsgId ?? 'room-message-1',
        fromPeerId: ack.fromPeerId,
        toPeerId: 'a',
        originPeerId: 'a',
        logicalRecipientPeerId: ack.logicalRecipientPeerId,
        carrier: 'ws',
        status: ack.status ?? 'delivered',
        observedAtEpochMs: 1_000
    });
}

/** The receiver ACK as the control message the server counts, under the subject's trace. */
function aggregateAckControl(ack: ALAckPayload): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${ack.fromPeerId}`, senderId: ack.fromPeerId, ts: 1_000, traceId: 'trace-room-message-1' },
        ack
    );
}

async function createReceiptFixture(options: ReceiptFixtureOptions): Promise<ReceiptFixture> {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    const server = new JsonWebSocketServer();
    const sockets = { a: new SimulatedWebSocket('ws://a'), b: new SimulatedWebSocket('ws://b'), c: new SimulatedWebSocket('ws://c') };
    for (const [peerId, socket] of Object.entries(sockets)) {
        await socket.open();
        attachTestWebSocket(server, new ConnectionContext({ id: peerId, socket }));
    }
    const engine = new InboxOutboxEngine();
    engine.start();
    const outbox = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    const admission = createInMemoryALAdmissionState(new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs)));
    const settlements: ALDeliverySettlement[] = [];
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const nowMs = () => clock.nowMs;
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        nowMs,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        outboundBackend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), nowMs)
    });
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        outbox,
        socket: server,
        readAuthenticatedConnectionScope: (connection) =>
            server.connections.get(connection.id) === connection
                ? { scope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId }, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        name: 'server',
        queueEngine: engine,
        forwardsRoomScopedMessages: options.fanout === 'forward',
        targetResolver: {
            requiresFrozenAudience: () => false,
            resolvePeerRecipients: (peerId) => options.origin === 'remote' && peerId === 'a' ? [] : [{ peerId, connectionId: peerId }],
            resolveBroadcastRecipients: () => [...server.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }))
        },
        inboundStores: { admissionStore: createTestInboundStore(admission, clock), workQueue: admission.workQueue },
        outboundStores,
        outboundSettlements: (settlement) => settlements.push(settlement),
        outboundDiagnostics: (event) => diagnostics.push(event)
    });
    const remoteOrigin = options.origin === 'remote'
        ? await createRemoteOriginInstance(service, outbox, outboundStores)
        : undefined;
    registerReceiptFixtureRouting(service, options);
    onTestFinished(async () => {
        await service.dispose();
        await engine.stop();
        vi.restoreAllMocks();
    });
    return {
        service,
        engine,
        outbox,
        sockets,
        clock,
        remoteOrigin,
        settlements,
        diagnostics,
        admissionStore: outboundStores.admissionStore
    };
}

/** Each attempt of the server's own row to take a terminal receipt of `msgId`, with its commit's outcome. */
function readReceiptConfirmationOutcomes(fixture: ReceiptFixture, msgId: string): readonly (readonly [number, string])[] {
    return fixture.diagnostics.flatMap((event) =>
        event.kind === 'receipt-confirmation' && event.targetMsgId === msgId && event.phase !== 'admitted'
            ? [[event.attempt, event.commitOutcome] as const]
            : []
    );
}

function registerReceiptFixtureRouting(service: WsQueueBoxServerService, options: ReceiptFixtureOptions): void {
    service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? {
                    authorized: true,
                    roomAudience: { recipientPeerIds: options.authorizedPeerIds ?? ['a', 'b', 'c'], snapshotVersion: SNAPSHOT_VERSION }
                }
                : { authorized: true }
    });
    service.onAnyInboxMessageDo('router', {
        onMessage: async (message) => {
            if (options.fanout === 'outbox') {
                await service.enqueueOutboxIfAbsent(message, toRouterAuthority(options.admittedAudience));
            }
        }
    });
}

function toRouterAuthority(
    admittedAudience: readonly string[] | undefined
): WsQueueBoxServerService.EnqueueAuthority | undefined {
    return admittedAudience === undefined
        ? undefined
        : { admittedAudience, admittedConnectionGenerationIds: undefined, recipientScope: undefined };
}

/** `a`'s room message at a sequence of its `game-1` track. */
function trackedRoomMessage(msgId: string, seq: number, nowMs: number): ALMessage {
    const message = roomMessage(nowMs);
    return { ...message, id: { ...message.id, msgId }, ordering: { orderingKey: 'game-1', epoch: 1, seq } };
}

/** A second instance holding the origin's live socket; both instances share durable outbox and admission state. */
async function createRemoteOriginInstance(
    local: WsQueueBoxServerService,
    outbox: InMemoryQueueBox,
    outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>
): Promise<SimulatedWebSocket> {
    const server = new JsonWebSocketServer();
    const origin = new SimulatedWebSocket('ws://a-on-remote');
    await origin.open();
    attachTestWebSocket(server, new ConnectionContext({ id: 'a', socket: origin }));
    const engine = new InboxOutboxEngine();
    engine.start();
    const remote = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        outbox,
        socket: server,
        readAuthenticatedConnectionScope: (connection) =>
            server.connections.get(connection.id) === connection
                ? { scope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId }, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        name: 'remote-server',
        queueEngine: engine,
        outboundStores,
        targetResolver: { requiresFrozenAudience: () => false, resolvePeerRecipients: (peerId) => peerId === 'a' ? [{ peerId, connectionId: 'a' }] : [] }
    });
    onTestFinished(async () => {
        await remote.dispose();
        await engine.stop();
    });
    const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
    const bus: QueueBoxPubSubBridge = {
        subscribe: async (_channel, subscriber) => {
            subscribers.push(subscriber);
        },
        publish: async (_channel, message) => {
            await Promise.all(subscribers.map(async (subscriber) => await subscriber(message)));
        }
    };
    await installQueueBoxPubSubBridge({ wsQBoxServerService: local, bridge: bus, channel: 'ws', publisherId: 'local' });
    await installQueueBoxPubSubBridge({ wsQBoxServerService: remote, bridge: bus, channel: 'ws', publisherId: 'remote' });
    return origin;
}

function createTestInboundStore(admission: ALAdmissionMemoryState, clock: { nowMs: number; }): ALInboundAdmissionStore {
    const nowMs = () => clock.nowMs;
    return createALInboundAdmissionStore({
        namespace: 'ws-server-receipts',
        nowMs,
        backend: new InMemoryAdmissionBackend(admission, nowMs),
        orderingTrackTtlMs: 300000,
        supersedenceTrackTtlMs: 300000,
        retention: normalizeALRuntimeStoreRetention(),
        maxOrderingTracks: undefined,
        maxDeliveredMarkers: undefined
    });
}

async function admitRoomMessage(fixture: ReceiptFixture): Promise<void> {
    const accepted = await fixture.service.acceptIncomingMessage(roomMessage(fixture.clock.nowMs), 'a');
    expect(accepted.right?.kind).toBe('admitted');
    await expect.poll(() => fixture.sockets.b.sent.length).toBeGreaterThan(0);
}

function roomMessage(nowMs: number): ALMessage {
    return {
        id: { v: 4, msgId: 'room-message-1', ts: nowMs, senderId: 'a', traceId: 'trace-ws-queue-box-server-receipt-aggregation' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: nowMs + ROOM_MESSAGE_LIFETIME_MS },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

function receiverAck(fixture: ReceiptFixture, recipient: 'b' | 'c'): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${recipient}`, senderId: recipient, ts: fixture.clock.nowMs, traceId: 'trace-ws-queue-box-server-receipt-aggregation' },
        toTestALAckPayload({
            ackedMsgId: 'room-message-1',
            fromPeerId: recipient,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: fixture.clock.nowMs
        })
    );
}

/** Every receipt row the service wrote to its outbox, oldest first. */
async function readReceiptRows(fixture: ReceiptFixture): Promise<readonly ALReceiptPayload[]> {
    return (await readReceiptMessages(fixture)).map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
}

async function readReceiptMessages(fixture: ReceiptFixture): Promise<readonly ALMessage[]> {
    const entries = await Promise.all((await fixture.outbox.getAllKeys()).map((key) => fixture.outbox.getItem(key)));
    return entries
        .flatMap((entry) => entry?.typeId === EnqueuedType.WS_OUTBOX ? [decodePersistedALMessage(entry.resource)] : [])
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .sort((left, right) => toPhaseOrder(left) - toPhaseOrder(right));
}

function readRoomMessageCopies(socket: SimulatedWebSocket): number {
    return socket.sent.filter((frame) => decodePersistedALMessage(frame).id.msgId === 'room-message-1').length;
}

function toPhaseOrder(message: ALMessage): number {
    const phase = decodeALReceiptPayload(JSON.parse(message.payload.resource)).phase;
    return phase === 'admitted' ? 0 : 1;
}
