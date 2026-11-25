import { describe, expect, it } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores, createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALReceiptRecordConfirmationPrefix, toALReceiptRecordHeadKey, type ALReceiptRecordRef } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import type { ALReceiptRecordStores } from '@shared/alm/receipt-record/al-receipt-record-stores.ts';
import { computeALReceiptRecordWorkEntry, toALReceiptRecordWorkKey } from '@shared/alm/receipt-record/al-receipt-record-work-entry.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import { AL_WORK_READINESS_MEMORY_MS } from '@shared/alm/work/al-work-handler.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { toWsQueueBoxServerEndedReceiptControlId } from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-receipt-control.ts';
import type { WsQueueBoxServerReceiptObservation } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';

import type { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import {
    connect,
    createBridgeBus,
    createClusterInstance,
    createReceiptClusterState,
    createReceiptInstanceStores,
    installClock,
    readOriginReceiptPhases,
    readOriginReceipts,
    readOriginTerminalReceipt,
    readReceiptAggregationVerdicts,
    readSocketReceipts,
    readTerminalReceiptIdentities,
    RECEIPT_SERVER_PEER_ID,
    receiverAck,
    roomMessage,
    toReceiptSets,
    type ClusterInstance,
    type ReceiptAggregationVerdict,
    type ReceiptClock,
    type ReceiptClusterState,
    type ReceiptRoomView
} from './ws-queue-box-server-receipt-fixture.ts';

import { AL_RECEIPT_RECORD_WINDOW_MS } from '@shared/alm/receipt-record/validate-al-receipt-record-opening.ts';
import { createDelegatingALAdmissionWorkBackend } from '../alm/create-delegating-al-admission-work-backend.ts';
import { createWorkerHold, type WorkerHold } from '../alm/create-worker-hold.ts';
import { holdALAdmissionWrite } from '../alm/hold-al-admission-write.ts';

const MSG_ID = 'room-message-record';
const ORIGIN = 'o';
const LIFETIME_MS = 30_000;
const ROOM = ['o', 'r1', 'r2'];
const ref: ALReceiptRecordRef = { originPeerId: ORIGIN, msgId: MSG_ID };

interface RecordCluster {
    readonly clock: ReceiptClock;
    /** When the origin sent the message: every copy it sends again is the same message. */
    readonly sentAtMs: number;
    readonly state: ReceiptClusterState;
    readonly outbound: ReturnType<typeof createInMemoryALAdmissionState>;
    readonly bus: ReturnType<typeof createBridgeBus>;
    readonly roomView: ReceiptRoomView;
    readonly observations: WsQueueBoxServerReceiptObservation[];
    readonly originSockets: SimulatedWebSocket[];
    /** The test's own reader of the record every instance shares. */
    readonly record: ALReceiptRecord;
    readonly recordBackend: InMemoryAdmissionBackend;
    readonly recordNamespace: string;
}

interface StartInstanceInput {
    /** The instance's cluster publisher id. */
    readonly name: string;
    readonly roomPeerIds: readonly string[];
    /** The instance's record stores as built over the shared state; a case may wrap their backend. */
    readonly toRecordStores: (stores: ALReceiptRecordStores) => ALReceiptRecordStores;
    /** The instance's inbound stores as built over the shared state; a case may wrap their admission store. */
    readonly toInboundStores: (stores: ALInboundRuntimeStores) => ALInboundRuntimeStores;
    readonly volatile: boolean;
    readonly starts: boolean;
}

type AckVerdict =
    | { readonly refused: readonly string[]; }
    | { readonly recipient: string; readonly outcome: string; readonly after: boolean; };

describe('the WS server counts a receipt through the record every instance shares', () => {
    // Pins an instance refusing or not counting an ACK for a receipt another instance admitted.
    it('completes a receipt admitted on one instance from ACKs counted on two others', async () => {
        const cluster = createRecordCluster();
        const { a, b, c } = await startThree(cluster);
        await connectOrigin(cluster, a);

        expect((await a.service.acceptIncomingMessage(message(cluster), ORIGIN)).right?.kind).toBe('admitted');
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted']);
        expect((await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).left).toBeUndefined();
        expect((await c.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2')).left).toBeUndefined();

        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
        expect(readOriginTerminalReceipt(cluster.originSockets, MSG_ID)).toMatchObject({ confirmedRecipientPeerIds: ['r1', 'r2'] });
    });

    // Pins a receipt that dies with the instance that admitted it.
    it('completes a receipt after the instance that admitted it is disposed', async () => {
        const cluster = createRecordCluster();
        const { a, b, c } = await startThree(cluster);
        await connectOrigin(cluster, a);
        await a.service.acceptIncomingMessage(message(cluster), ORIGIN);
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted']);

        await a.service.dispose();
        const onB = await connectOrigin(cluster, b);
        await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1');
        await c.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2');

        await expect.poll(() => readSocketReceipts([onB], MSG_ID).filter(({ receipt }) => receipt.phase === 'complete')).toHaveLength(1);
        expect(readSocketReceipts([onB], MSG_ID).find(({ receipt }) => receipt.phase === 'complete')?.receipt.confirmedRecipientPeerIds)
            .toEqual(['r1', 'r2']);
    });

    // Pins a receipt that is never ended when the instance that admitted it is gone at its deadline.
    it('a surviving instance ends the receipt timed-out at its deadline', async () => {
        const cluster = createRecordCluster();
        const { a, b } = await startThree(cluster);
        await connectOrigin(cluster, a);
        await a.service.acceptIncomingMessage(message(cluster), ORIGIN);
        await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1');
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted']);

        await a.service.dispose();
        await connectOrigin(cluster, b);
        cluster.clock.nowMs += LIFETIME_MS;

        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'timed-out']);
        expect(readOriginTerminalReceipt(cluster.originSockets, MSG_ID)).toMatchObject({
            expectedRecipientPeerIds: ['r1', 'r2'],
            confirmedRecipientPeerIds: ['r1']
        });
    });

    // Pins a copy re-sent to another instance going unanswered, or answered under a control id already used.
    it('answers a re-sent copy on another instance from the record', async () => {
        const cluster = createRecordCluster();
        const { a, b, c } = await startThree(cluster);
        await connectOrigin(cluster, a);
        await connectOrigin(cluster, c);
        await a.service.acceptIncomingMessage(message(cluster), ORIGIN);
        await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1');
        cluster.clock.nowMs += 1;

        expect((await c.service.acceptIncomingMessage(message(cluster), ORIGIN)).right?.kind).toBe('duplicate');
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'admitted']);
        const [first, second] = readOriginReceipts(cluster.originSockets, MSG_ID);
        expect(second!.receipt.confirmedRecipientPeerIds).toEqual(['r1']);
        expect(second!.controlId).not.toBe(first!.controlId);

        await c.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2');
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'admitted', 'complete']);
        cluster.clock.nowMs += 1;
        await c.service.acceptIncomingMessage(message(cluster), ORIGIN);

        // A re-sent copy after the end is answered with the terminal receipt again, from the head's own sets.
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'admitted', 'complete', 'complete']);
        const [ended, again] = readOriginReceipts(cluster.originSockets, MSG_ID).filter(({ receipt }) => receipt.phase === 'complete');
        expect(again!.controlId).not.toBe(ended!.controlId);
        expect(toReceiptSets(again!.receipt)).toEqual(toReceiptSets(ended!.receipt));
    });

    // Pins an ACK that overtakes its head being refused or lost instead of counted ahead.
    it('counts an ACK that arrives before its head', async () => {
        const cluster = createRecordCluster();
        const hold = createWorkerHold();
        const a = await startInstance(cluster, { ...instanceInput('a', ['o', 'r1']), toRecordStores: holding(hold) });
        const b = await startInstance(cluster, instanceInput('b', ['o', 'r1']));
        await connectOrigin(cluster, a);
        await connect(b, 'r1');

        const admitting = a.service.acceptIncomingMessage(message(cluster), ORIGIN);
        await hold.arrived;
        expect((await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).left).toBeUndefined();
        hold.release();

        expect((await admitting).right?.kind).toBe('admitted');
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
        expect(readOriginReceipts(cluster.originSockets, MSG_ID)[0]!.receipt.confirmedRecipientPeerIds).toEqual(['r1']);
    });

    // Pins a headless ACK counted from a sender the origin's admission row does not hold.
    it('refuses an ACK for a message its sender was never admitted to', async () => {
        const cluster = createRecordCluster();
        const a = await startInstance(cluster, { ...instanceInput('a', ROOM), toRecordStores: failingFirstWrite });
        const b = await startInstance(cluster, instanceInput('b', ROOM));
        await connectOrigin(cluster, a);
        await connect(b, 'stranger');
        await expect(a.service.acceptIncomingMessage(message(cluster), ORIGIN)).rejects.toThrow('storage down');

        const refused = await b.service.acceptIncomingMessage(ackOf(cluster, 'stranger'), 'stranger');

        expect(refused.left?.message).toBe('AL acknowledgement names no message its origin admitted to this sender');
        expect(readConfirmationKeys(cluster)).toEqual([]);
    });

    // Pins a repeated ACK on another instance writing a second confirmation or a second terminal receipt.
    it('counts a repeated ACK once', async () => {
        const cluster = createRecordCluster();
        const { a, b, c } = await startThree(cluster);
        await connectOrigin(cluster, a);
        await a.service.acceptIncomingMessage(message(cluster), ORIGIN);
        await connect(c, 'r1');

        expect((await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).left).toBeUndefined();
        expect((await c.service.acceptIncomingMessage(renamed(ackOf(cluster, 'r1'), 'ack-r1-again'), 'r1')).left).toBeUndefined();
        expect(readConfirmationKeys(cluster)).toHaveLength(1);
        await c.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2');

        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
        await settleEngines([a, b, c]);
        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual(['admitted', 'complete']);
        expect(readTerminalReceiptIdentities(cluster.originSockets, MSG_ID)).toHaveLength(1);
    });

    // Pins the server's own `not-sent` from another instance being lost instead of recorded outside the audience.
    it('records a session the server sent nothing outside the audience, from any instance', async () => {
        const cluster = createRecordCluster();
        const { a, b, c } = await startThree(cluster);
        await connectOrigin(cluster, a);
        await a.service.acceptIncomingMessage(message(cluster), ORIGIN);

        await c.service.writeOutsideAudience(message(cluster), ['r2'], 'durable');
        await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1');

        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
        expect(readOriginTerminalReceipt(cluster.originSockets, MSG_ID)).toMatchObject({
            confirmedRecipientPeerIds: ['r1'],
            outsideAudienceRecipientPeerIds: ['r2']
        });
    });

    // Review Focus 1: an ACK for a message the volatile pair admitted is proven from that pair, not the durable store.
    it('counts an ACK ahead of its head for a message only the volatile inbound pair holds', async () => {
        const cluster = createRecordCluster();
        const hold = createWorkerHold();
        const a = await startInstance(cluster, {
            ...instanceInput('a', ['o', 'r1']),
            toRecordStores: holding(hold),
            volatile: true
        });
        await connectOrigin(cluster, a);
        await connect(a, 'r1');

        const admitting = a.service.acceptIncomingMessage(volatileMessage(cluster), ORIGIN);
        await hold.arrived;
        expect(await a.inboundStores.admissionStore.readIngressAudience(MSG_ID, ORIGIN)).toBeUndefined();
        expect((await a.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).left).toBeUndefined();
        hold.release();

        expect((await admitting).right?.kind).toBe('admitted');
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
    });

    // Pins the hook stopping at the volatile pair's `undefined` instead of falling back to the durable admission row.
    it('counts an ACK ahead of its head for a durable message while a volatile inbound pair is configured', async () => {
        const cluster = createRecordCluster();
        const hold = createWorkerHold();
        const a = await startInstance(cluster, {
            ...instanceInput('a', ['o', 'r1']),
            toRecordStores: holding(hold),
            volatile: true
        });
        await connectOrigin(cluster, a);
        await connect(a, 'r1');

        const admitting = a.service.acceptIncomingMessage(durableMessage(cluster), ORIGIN);
        await hold.arrived;
        expect(await a.inboundStores.admissionStore.readIngressAudience(MSG_ID, ORIGIN)).toEqual(['o', 'r1']);
        expect((await a.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).left).toBeUndefined();
        hold.release();

        expect((await admitting).right?.kind).toBe('admitted');
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
    });

    // Review Focus 2: a receipt control carries at most 256 recipients, so a larger audience opens no receipt.
    it('admits a room message of 257 recipients and starts no receipt for it', async () => {
        const cluster = createRecordCluster();
        const recipients = Array.from({ length: 257 }, (_unused, index) => `r${index + 1}`);
        const a = await startInstance(cluster, instanceInput('a', [ORIGIN, ...recipients]));
        await connectOrigin(cluster, a);

        expect((await a.service.acceptIncomingMessage(message(cluster), ORIGIN)).right).toEqual({ kind: 'admitted' });
        await settleEngines([a]);

        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual([]);
        expect((await cluster.record.read(ref)).left).toEqual({ kind: 'head-absent' });
    });

    // Pins a room member whose identity no receipt control can name opening a head whose answer throws.
    it('admits a room message whose audience holds an identity a receipt cannot name, and starts no receipt for it', async () => {
        const cluster = createRecordCluster();
        const unnameable = 'p'.repeat(AL_MESSAGE_RESOURCE_LIMITS.routeIdCharacters + 1);
        const a = await startInstance(cluster, instanceInput('a', [...ROOM, unnameable]));
        await connectOrigin(cluster, a);

        expect((await a.service.acceptIncomingMessage(message(cluster), ORIGIN)).right).toEqual({ kind: 'admitted' });
        await settleEngines([a]);

        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual([]);
        expect(cluster.observations.filter((observation) => observation.kind === 'receipt-outbox')).toEqual([]);
        expect((await cluster.record.read(ref)).left).toEqual({ kind: 'head-absent' });
    });

    // Pins a receipt opened for an audience whose terminal receipt no control can encode, whose ended work
    // would then throw on every delivery. With ids of 128 characters, 249 recipients encode and 250 do not.
    it.each([250, 256])(
        'admits a room message of %i recipients whose terminal receipt cannot be encoded, and opens nothing',
        async (count) => {
            const cluster = createRecordCluster();
            const a = await startInstance(cluster, instanceInput('a', [ORIGIN, ...toLongRecipientPeerIds(count)]));
            await connectOrigin(cluster, a);

            expect((await a.service.acceptIncomingMessage(message(cluster), ORIGIN)).right).toEqual({ kind: 'admitted' });
            await settleEngines([a]);

            expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual([]);
            expect(cluster.observations.filter((observation) => observation.kind === 'receipt-outbox')).toEqual([]);
            expect((await cluster.record.read(ref)).left).toEqual({ kind: 'head-absent' });
            expect(await cluster.state.record.workQueue.getItem(toALReceiptRecordWorkKey(cluster.recordNamespace, 'deadline', ref)))
                .toBeUndefined();
        }
    );

    // Pins the encodability rule refusing an audience whose largest receipt still encodes.
    it('opens a receipt for 249 recipients of 128 characters and delivers its terminal receipt', async () => {
        const cluster = createRecordCluster();
        const recipients = toLongRecipientPeerIds(249);
        const a = await startInstance(cluster, instanceInput('a', [ORIGIN, ...recipients]));
        await connectOrigin(cluster, a);

        const last = recipients.at(-1)!;
        await connect(a, last);

        expect((await a.service.acceptIncomingMessage(message(cluster), ORIGIN)).right).toEqual({ kind: 'admitted' });
        // A receipt nobody confirmed never completes, so one recipient confirms and every other is recorded outside.
        await a.service.writeOutsideAudience(message(cluster), recipients.slice(0, -1), 'durable');
        expect((await a.service.acceptIncomingMessage(ackOf(cluster, last), last)).left).toBeUndefined();

        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
        expect(readOriginTerminalReceipt(cluster.originSockets, MSG_ID)).toMatchObject({ confirmedRecipientPeerIds: [last] });
        expect(readOriginTerminalReceipt(cluster.originSockets, MSG_ID)?.outsideAudienceRecipientPeerIds).toHaveLength(248);
    });

    // Pins a message whose own id no receipt control can name, admitted to nobody, throwing from its answer.
    it('admits a message whose own id a receipt cannot name to a room of its origin alone, and answers nothing', async () => {
        const cluster = createRecordCluster();
        const a = await startInstance(cluster, instanceInput('a', [ORIGIN]));
        await connectOrigin(cluster, a);
        const longId = roomMessage({
            msgId: 'm'.repeat(AL_MESSAGE_RESOURCE_LIMITS.payloadBytes + 1),
            originPeerId: ORIGIN,
            nowMs: cluster.sentAtMs,
            lifetimeMs: LIFETIME_MS
        });

        expect((await a.service.acceptIncomingMessage(longId, ORIGIN)).right).toEqual({ kind: 'admitted' });
        await settleEngines([a]);

        expect(cluster.observations.filter((observation) => observation.kind === 'receipt-outbox')).toEqual([]);
    });

    // Review Focus 3: a store failure is an operational exception, never a refusal and never a count.
    it('rejects an ACK whose count the record store fails, and observes no refused count', async () => {
        const cluster = createRecordCluster();
        const b = await startInstance(cluster, instanceInput('b', ROOM));
        const a = await startInstance(cluster, { ...instanceInput('a', ROOM), toRecordStores: failingWrites });
        await connectOrigin(cluster, b);
        await b.service.acceptIncomingMessage(message(cluster), ORIGIN);
        await connect(a, 'r1');

        await expect(a.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).rejects.toThrow('storage down');

        expect(readAckVerdicts(cluster)).toEqual([]);
    });

    // Pins a store failure in the hook's record read turned into a refusal, or into "no rejection" and a count.
    it.each(['read', 'list'] as const)(
        'rejects an ACK whose hook read of the record fails at its %s, and observes no refusal and no count',
        async (failing) => {
            const cluster = createRecordCluster();
            const b = await startInstance(cluster, instanceInput('b', ROOM));
            const a = await startInstance(cluster, { ...instanceInput('a', ROOM), toRecordStores: failingRecordReads(failing) });
            await connectOrigin(cluster, b);
            await b.service.acceptIncomingMessage(message(cluster), ORIGIN);
            await connect(a, 'r1');

            await expect(a.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).rejects.toThrow('storage down');

            expect(readAckVerdicts(cluster)).toEqual([]);
            expect(readConfirmationKeys(cluster)).toEqual([]);
        }
    );

    // Pins a store failure in the admission row's read, on the no-head path, turned into a refusal or a count.
    it('rejects a headless ACK whose ingress audience read fails, and observes no refusal and no count', async () => {
        const cluster = createRecordCluster();
        const a = await startInstance(cluster, { ...instanceInput('a', ROOM), toInboundStores: failingIngressAudience });
        await connect(a, 'r1');

        await expect(a.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).rejects.toThrow('storage down');

        expect(readAckVerdicts(cluster)).toEqual([]);
        expect(readConfirmationKeys(cluster)).toEqual([]);
    });

    // Pins a store failure in the record's read, while a re-sent copy is answered, swallowed into silence or an answer.
    it('rejects a re-sent copy whose record read fails, and answers nothing', async () => {
        const cluster = createRecordCluster();
        const a = await startInstance(cluster, instanceInput('a', ROOM));
        const c = await startInstance(cluster, { ...instanceInput('c', ROOM), toRecordStores: failingRecordReads('read') });
        await connectOrigin(cluster, a);
        await connectOrigin(cluster, c);
        await a.service.acceptIncomingMessage(message(cluster), ORIGIN);
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted']);
        const answered = cluster.observations.length;

        await expect(c.service.acceptIncomingMessage(message(cluster), ORIGIN)).rejects.toThrow('storage down');
        await settleEngines([a, c]);

        expect(cluster.observations.slice(answered)).toEqual([]);
        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual(['admitted']);
    });

    // Review Focus 5: a count that starts after another instance ended the receipt never turns it complete. Memory
    // serialises writes, so it cannot hold a count that read an open head until after `end`; PostgreSQL's task does.
    it('a count that starts after another instance ended the receipt cannot complete it', async () => {
        const cluster = createRecordCluster();
        const hold = createWorkerHold();
        const b = await startInstance(cluster, instanceInput('b', ROOM));
        const a = await startInstance(cluster, { ...instanceInput('a', ROOM), toRecordStores: holding(hold) });
        await connectOrigin(cluster, b);
        await connect(b, 'r1');
        await b.service.acceptIncomingMessage(message(cluster), ORIGIN);
        expect((await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).left).toBeUndefined();
        await connect(a, 'r2');

        const counting = a.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2');
        await hold.arrived;
        cluster.clock.nowMs += LIFETIME_MS;
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'timed-out']);
        hold.release();
        expect((await counting).left).toBeUndefined();
        await settleEngines([a, b]);

        expect(readAckVerdicts(cluster).at(-1)).toEqual({ recipient: 'r2', outcome: 'rejected', after: false });
        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual(['admitted', 'timed-out']);
        expect(readOriginTerminalReceipt(cluster.originSockets, MSG_ID)).toMatchObject({ confirmedRecipientPeerIds: ['r1'] });
    });

    // Ended work delivers at least once, so a second delivery must enqueue nothing new and end quietly.
    it('enqueues one terminal receipt for an ended work row claimed twice', async () => {
        const cluster = createRecordCluster();
        const instances = await startThree(cluster);
        const origin = await completeOneReceipt(cluster, instances);
        const controlId = toWsQueueBoxServerEndedReceiptControlId(ref);
        const workKey = toALReceiptRecordWorkKey(cluster.recordNamespace, 'ended', ref);
        await expect.poll(async () => (await cluster.state.record.workQueue.getItem(workKey))?.status).toBe(EntityStatus.COMPLETED);

        await writeWorkAgain(cluster, 'ended');
        cluster.clock.nowMs += AL_WORK_READINESS_MEMORY_MS + 1;

        await expect.poll(() => readEndedOutboxVerdicts(cluster, controlId)).toEqual(['admitted', 'duplicate']);
        await expect.poll(async () => (await cluster.state.record.workQueue.getItem(workKey))?.status).toBe(EntityStatus.COMPLETED);
        await settleEngines(Object.values(instances));
        expect(new Set(readSocketReceipts([origin], MSG_ID).filter(({ receipt }) => receipt.phase === 'complete').map((sent) => sent.controlId)))
            .toEqual(new Set([controlId]));
        expect(readTerminalReceiptIdentities([origin], MSG_ID)).toHaveLength(1);
        expect(toWsQueueBoxServerEndedReceiptControlId({ originPeerId: 'o', msgId: 'm:x' }))
            .not.toBe(toWsQueueBoxServerEndedReceiptControlId({ originPeerId: 'o:m', msgId: 'x' }));
    });

    // Pins a restarted instance that counts from receipt state of its own, so it misses what was counted before it.
    it('keeps no receipt state on the instance', async () => {
        const cluster = createRecordCluster();
        const { a, b } = await startThree(cluster);
        await connectOrigin(cluster, a);
        await a.service.acceptIncomingMessage(message(cluster), ORIGIN);
        expect((await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).left).toBeUndefined();
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted']);

        await a.service.dispose();
        const restarted = await startInstance(cluster, instanceInput('a', ROOM));
        await connectOrigin(cluster, restarted);
        await connect(restarted, 'r2');
        expect((await restarted.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2')).left).toBeUndefined();

        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
        expect(readOriginTerminalReceipt(cluster.originSockets, MSG_ID)).toMatchObject({ confirmedRecipientPeerIds: ['r1', 'r2'] });
        expect(readAckVerdicts(cluster).at(-1)).toEqual({ recipient: 'r2', outcome: 'complete', after: true });
    });

    // Pins a receipt never started when the admission committed and its `open` was lost.
    it.each(['the store failed at its open', 'its instance was disposed inside its open'] as const)(
        'a re-sent copy opens the record its admission never opened: %s',
        async (lost) => {
            const cluster = createRecordCluster();
            const hold = createWorkerHold();
            const a = await startInstance(cluster, {
                ...instanceInput('a', ROOM),
                toRecordStores: lost === 'the store failed at its open' ? failingFirstWrite : holding(hold)
            });
            const b = await startInstance(cluster, instanceInput('b', ROOM));
            const c = await startInstance(cluster, instanceInput('c', ROOM));
            await connectOrigin(cluster, a);
            await connectOrigin(cluster, c);
            await connect(b, 'r1');
            await connect(c, 'r2');
            await loseOpen(cluster, a, lost === 'the store failed at its open' ? undefined : hold);

            expect((await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1')).left).toBeUndefined();
            expect((await c.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2')).left).toBeUndefined();
            expect((await c.service.acceptIncomingMessage(message(cluster), ORIGIN)).right?.kind).toBe('duplicate');

            await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
            const [admitted, complete] = readOriginReceipts(cluster.originSockets, MSG_ID);
            expect(admitted!.receipt).toMatchObject({ expectedRecipientPeerIds: ['r1', 'r2'], confirmedRecipientPeerIds: ['r1', 'r2'] });
            expect(complete!.receipt.confirmedRecipientPeerIds).toEqual(['r1', 'r2']);
            expect(readHeadKeys(cluster)).toHaveLength(1);
        }
    );

    // Pins a copy after the end reopening the ended head or giving it new deadline work.
    it('a re-sent copy after the end does not reopen it', async () => {
        const cluster = createRecordCluster();
        const instances = await startThree(cluster);
        await connectOrigin(cluster, instances.c);
        await completeOneReceipt(cluster, instances);
        const ended = (await cluster.record.read(ref)).right?.head;
        const deadlineKey = toALReceiptRecordWorkKey(cluster.recordNamespace, 'deadline', ref);
        const deadlineWork = await cluster.state.record.workQueue.getItem(deadlineKey);

        await instances.c.service.acceptIncomingMessage(message(cluster), ORIGIN);

        await expect.poll(() => tickPhases(cluster), { timeout: 2_000 }).toEqual(['admitted', 'complete', 'complete']);
        const [first, again] = readOriginReceipts(cluster.originSockets, MSG_ID).filter(({ receipt }) => receipt.phase === 'complete');
        expect(toReceiptSets(again!.receipt)).toEqual(toReceiptSets(first!.receipt));
        expect((await cluster.record.read(ref)).right?.head).toEqual(ended);
        expect([deadlineWork, undefined]).toContainEqual(await cluster.state.record.workQueue.getItem(deadlineKey));

        cluster.clock.nowMs += LIFETIME_MS + 30_001;
        // Past its own lifetime the copy is not admitted at all, so nothing reaches the record.
        expect((await instances.c.service.acceptIncomingMessage(message(cluster), ORIGIN)).right?.kind).toBe('not-admitted');
        await settleEngines(Object.values(instances));

        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual(['admitted', 'complete', 'complete']);
        expect((await cluster.record.read(ref)).left).toEqual({ kind: 'head-absent' });
        expect(await cluster.state.record.workQueue.getItem(deadlineKey)).toBeUndefined();
    });

    // Pins a copy of a kept send opening a head before the replay admits the message.
    it('a copy of a send still kept for admission opens nothing', async () => {
        const cluster = createRecordCluster();
        const a = await startInstance(cluster, { ...instanceInput('a', ROOM), starts: false });
        await connectOrigin(cluster, a);
        cluster.roomView.inSync = false;
        expect((await a.service.acceptIncomingMessage(message(cluster), ORIGIN)).right?.kind).toBe('pending-admission');
        expect(await a.inboundStores.admissionStore.readIngressAudience(MSG_ID, ORIGIN)).toBeUndefined();

        expect((await a.service.acceptIncomingMessage(message(cluster), ORIGIN)).right?.kind).toBe('pending-admission');
        await settleEngines([a]);
        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual([]);
        expect((await cluster.record.read(ref)).left).toEqual({ kind: 'head-absent' });

        cluster.roomView.inSync = true;
        a.engine.start();
        cluster.clock.nowMs += 1_000;
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted']);
        expect(readOriginReceipts(cluster.originSockets, MSG_ID)[0]!.receipt.expectedRecipientPeerIds).toEqual(['r1', 'r2']);
    });

    // Pins a copy opening a head whose deadline the record's window cannot hold.
    it('a re-sent copy of a send whose deadline lies beyond the window opens nothing', async () => {
        const cluster = createRecordCluster();
        const a = await startInstance(cluster, { ...instanceInput('a', ROOM), toRecordStores: failingFirstWrite });
        const c = await startInstance(cluster, instanceInput('c', ROOM));
        await connectOrigin(cluster, a);
        await connectOrigin(cluster, c);
        const longLived = message(cluster, 45 * 60_000);
        await expect(a.service.acceptIncomingMessage(longLived, ORIGIN)).rejects.toThrow('storage down');

        expect((await c.service.acceptIncomingMessage(longLived, ORIGIN)).right?.kind).toBe('duplicate');
        await settleEngines([a, c]);

        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual([]);
        expect((await cluster.record.read(ref)).left).toEqual({ kind: 'head-absent' });
        expect(await cluster.state.record.workQueue.getItem(toALReceiptRecordWorkKey(cluster.recordNamespace, 'deadline', ref)))
            .toBeUndefined();
    });

    // Pins a copy reopening a receipt whose ended head expired while its admission row lives on.
    it('a re-sent copy as old as the window gives an ended receipt no second life', async () => {
        const cluster = createRecordCluster();
        const instances = await startThree(cluster);
        const longLived = message(cluster, 45 * 60_000);
        await connectOrigin(cluster, instances.a);
        await connectOrigin(cluster, instances.c);
        await instances.a.service.acceptIncomingMessage(longLived, ORIGIN);
        await instances.b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1');
        await instances.c.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2');
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);

        // The head, clamped to the window, and its rows expire; the admission row lives on.
        cluster.clock.nowMs += 31 * 60_000 + 1_000;
        expect(await instances.c.inboundStores.admissionStore.readIngressAudience(MSG_ID, ORIGIN)).toEqual(ROOM);
        expect((await instances.c.service.acceptIncomingMessage(longLived, ORIGIN)).right?.kind).toBe('duplicate');
        await settleEngines(Object.values(instances));

        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual(['admitted', 'complete']);
        expect(readTerminalReceiptIdentities(cluster.originSockets, MSG_ID)).toHaveLength(1);
        expect((await cluster.record.read(ref)).left).toEqual({ kind: 'head-absent' });
        expect(await cluster.state.record.workQueue.getItem(toALReceiptRecordWorkKey(cluster.recordNamespace, 'deadline', ref)))
            .toBeUndefined();
    });

    // Pins a losing `end` recording a failure, delivering a second terminal receipt, or changing its count's outcome.
    it('a losing end is silent', async () => {
        const cluster = createRecordCluster();
        const counted = Promise.withResolvers<void>();
        const views = createViewGate(counted.promise);
        const a = await startInstance(cluster, instanceInput('a', ROOM));
        const b = await startInstance(cluster, { ...instanceInput('b', ROOM), toRecordStores: views.gate('b') });
        const c = await startInstance(cluster, { ...instanceInput('c', ROOM), toRecordStores: views.gate('c') });
        await connectOrigin(cluster, a);
        await connect(b, 'r1');
        await connect(c, 'r2');
        await a.service.acceptIncomingMessage(message(cluster), ORIGIN);
        void views.bothWritten.then(() => counted.resolve());

        const results = await Promise.all([
            b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1'),
            c.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2')
        ]);

        expect(results.map((result) => result.left)).toEqual([undefined, undefined]);
        await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
        await settleEngines([a, b, c]);
        expect(readOriginReceipts(cluster.originSockets, MSG_ID).filter(({ receipt }) => receipt.phase === 'complete')).toHaveLength(1);
        expect(readTerminalReceiptIdentities(cluster.originSockets, MSG_ID)).toHaveLength(1);
        expect(readOriginTerminalReceipt(cluster.originSockets, MSG_ID)).toMatchObject({ confirmedRecipientPeerIds: ['r1', 'r2'] });
        expect(new Set(readAckVerdicts(cluster))).toEqual(
            new Set([{ recipient: 'r1', outcome: 'complete', after: true }, { recipient: 'r2', outcome: 'complete', after: true }])
        );
        expect(readAckVerdicts(cluster)).toHaveLength(2);
        expect(
            cluster.observations.filter((observation) => observation.kind === 'receipt-outbox' && observation.receipt.phase === 'complete')
        ).toHaveLength(1);
        // The losing `end` records no refusal, no further count and no failed receipt.
        expect(readReceiptAggregationVerdicts(cluster.observations, MSG_ID)).toEqual<readonly ReceiptAggregationVerdict[]>([
            'ack-count:complete',
            'ack-count:complete',
            'receipt-outbox:admitted:admitted',
            'receipt-outbox:complete:admitted'
        ]);
    });

    // Pins a copy opening a record whose terminal receipt can never be delivered, so its ended work throws.
    it('a re-sent copy of a send whose receipt could not be encoded opens nothing', async () => {
        const cluster = createRecordCluster();
        const room = [ORIGIN, ...toLongRecipientPeerIds(250)];
        const a = await startInstance(cluster, instanceInput('a', room));
        const c = await startInstance(cluster, instanceInput('c', room));
        await connectOrigin(cluster, a);
        await connectOrigin(cluster, c);
        expect((await a.service.acceptIncomingMessage(message(cluster), ORIGIN)).right).toEqual({ kind: 'admitted' });

        expect((await c.service.acceptIncomingMessage(message(cluster), ORIGIN)).right?.kind).toBe('duplicate');
        await settleEngines([a, c]);

        expect(readHeadKeys(cluster)).toEqual([]);
        expect(await cluster.state.record.workQueue.getItem(toALReceiptRecordWorkKey(cluster.recordNamespace, 'deadline', ref)))
            .toBeUndefined();
        expect(cluster.observations.filter((observation) => observation.kind === 'receipt-outbox')).toEqual([]);
        expect(readOriginReceiptPhases(cluster.originSockets, MSG_ID)).toEqual([]);
    });
});

function createRecordCluster(): RecordCluster {
    const clock = installClock();
    const nowMs = () => clock.nowMs;
    const state = createReceiptClusterState(nowMs);
    const { receiptRecordStores } = createReceiptInstanceStores(state, nowMs);
    const recordBackend = new InMemoryAdmissionBackend(state.record, nowMs);
    return {
        clock,
        sentAtMs: clock.nowMs,
        state,
        outbound: createInMemoryALAdmissionState(new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs))),
        bus: createBridgeBus(),
        roomView: { inSync: true },
        observations: [],
        originSockets: [],
        record: new ALReceiptRecord({ backend: recordBackend, namespace: receiptRecordStores.namespace, nowMs }),
        recordBackend,
        recordNamespace: receiptRecordStores.namespace
    };
}

function instanceInput(name: string, roomPeerIds: readonly string[]): StartInstanceInput {
    return { name, roomPeerIds, toRecordStores: (stores) => stores, toInboundStores: (stores) => stores, volatile: false, starts: true };
}

type RecordInstance = ClusterInstance & ReturnType<typeof createReceiptInstanceStores>;

async function startInstance(cluster: RecordCluster, input: StartInstanceInput): Promise<RecordInstance> {
    const nowMs = () => cluster.clock.nowMs;
    const stores = createReceiptInstanceStores(cluster.state, nowMs);
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        nowMs,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        outboundBackend: new InMemoryAdmissionBackend(cluster.outbound, nowMs)
    });
    // Every instance of one deployment shares the server's name, as api-v1's instances share `wsRuntimeName`.
    const instance = await createClusterInstance({
        name: RECEIPT_SERVER_PEER_ID,
        outboundStores,
        inboundStores: input.toInboundStores(stores.inboundStores),
        inboundVolatileStores: input.volatile ? createVolatileALInboundRuntimeStores({ nowMs }, undefined) : undefined,
        receiptRecordStores: input.toRecordStores(stores.receiptRecordStores),
        receiptObserver: (observation) => cluster.observations.push(observation),
        roomView: cluster.roomView,
        bus: cluster.bus,
        publisherId: input.name,
        engine: new InboxOutboxEngine(),
        roomPeerIds: input.roomPeerIds
    });
    if (input.starts) {
        instance.engine.start();
    }
    return { ...instance, ...stores };
}

async function startThree(cluster: RecordCluster): Promise<Readonly<Record<'a' | 'b' | 'c', RecordInstance>>> {
    const a = await startInstance(cluster, instanceInput('a', ROOM));
    const b = await startInstance(cluster, instanceInput('b', ROOM));
    const c = await startInstance(cluster, instanceInput('c', ROOM));
    await connect(b, 'r1');
    await connect(c, 'r2');
    return { a, b, c };
}

async function connectOrigin(cluster: RecordCluster, instance: ClusterInstance): Promise<SimulatedWebSocket> {
    const socket = await connect(instance, ORIGIN);
    cluster.originSockets.push(socket);
    return socket;
}

/** Case 1's flow: admitted on `a`, r1 counted on `b` and r2 on `c`, its complete receipt read by the origin on `a`. */
async function completeOneReceipt(
    cluster: RecordCluster,
    { a, b, c }: Readonly<Record<'a' | 'b' | 'c', RecordInstance>>
): Promise<SimulatedWebSocket> {
    const origin = await connectOrigin(cluster, a);
    await a.service.acceptIncomingMessage(message(cluster), ORIGIN);
    await b.service.acceptIncomingMessage(ackOf(cluster, 'r1'), 'r1');
    await c.service.acceptIncomingMessage(ackOf(cluster, 'r2'), 'r2');
    await expect.poll(() => tickPhases(cluster)).toEqual(['admitted', 'complete']);
    return origin;
}

/** The admission commits and its `open` never does: the store fails it, or its instance is disposed inside it. */
async function loseOpen(cluster: RecordCluster, a: RecordInstance, hold: WorkerHold | undefined): Promise<void> {
    if (hold === undefined) {
        await expect(a.service.acceptIncomingMessage(message(cluster), ORIGIN)).rejects.toThrow('storage down');
        return;
    }
    void a.service.acceptIncomingMessage(message(cluster), ORIGIN);
    await hold.arrived;
    await a.service.dispose();
}

function message(cluster: RecordCluster, lifetimeMs = LIFETIME_MS): ALMessage {
    return roomMessage({ msgId: MSG_ID, originPeerId: ORIGIN, nowMs: cluster.sentAtMs, lifetimeMs });
}

function volatileMessage(cluster: RecordCluster): ALMessage {
    return { ...message(cluster), qos: { durability: { algo: 'volatile' } } };
}

/** Recipients whose ids each fill the 128 characters a receipt control names. */
function toLongRecipientPeerIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `r${index + 1}-`.padEnd(AL_MESSAGE_RESOURCE_LIMITS.routeIdCharacters, 'p'));
}

function durableMessage(cluster: RecordCluster): ALMessage {
    return { ...message(cluster), qos: { durability: { algo: 'local-inbox' } } };
}

function ackOf(cluster: RecordCluster, recipient: string): ALMessage {
    return receiverAck({ msgId: MSG_ID, originPeerId: ORIGIN, recipient, nowMs: cluster.clock.nowMs });
}

function renamed(control: ALMessage, msgId: string): ALMessage {
    return { ...control, id: { ...control.id, msgId } };
}

function holding(hold: WorkerHold): (stores: ALReceiptRecordStores) => ALReceiptRecordStores {
    return (stores) => ({ ...stores, backend: holdALAdmissionWrite(stores.backend, hold) });
}

function failingWrites(stores: ALReceiptRecordStores): ALReceiptRecordStores {
    return { ...stores, backend: withFailingWrites(stores.backend, Number.POSITIVE_INFINITY) };
}

function failingFirstWrite(stores: ALReceiptRecordStores): ALReceiptRecordStores {
    return { ...stores, backend: withFailingWrites(stores.backend, 1) };
}

function withFailingWrites(backend: ALAdmissionWorkBackend, failures: number): ALAdmissionWorkBackend {
    let failed = 0;
    return createDelegatingALAdmissionWorkBackend(backend, {
        write: async (operation, executionExpiresAtMs) => {
            if (failed < failures) {
                failed += 1;
                throw new Error('storage down');
            }
            return await backend.write(operation, executionExpiresAtMs);
        }
    });
}

function failingRecordReads(failing: 'read' | 'list'): (stores: ALReceiptRecordStores) => ALReceiptRecordStores {
    const fail = async (): Promise<never> => {
        throw new Error('storage down');
    };
    return (stores) => ({ ...stores, backend: createDelegatingALAdmissionWorkBackend(stores.backend, { [failing]: fail }) });
}

/** The instance's inbound stores, whose admission store fails every read of an admission row's audience. */
function failingIngressAudience(stores: ALInboundRuntimeStores): ALInboundRuntimeStores {
    const failing: ALInboundAdmissionStore = new Proxy(stores.admissionStore, {
        get: (target, property, receiver) =>
            property === 'readIngressAudience'
                ? async () => {
                    throw new Error('storage down');
                }
                : Reflect.get(target, property, receiver)
    });
    return { ...stores, admissionStore: failing };
}

interface ViewGate {
    readonly bothWritten: Promise<void>;
    gate(name: 'b' | 'c'): (stores: ALReceiptRecordStores) => ALReceiptRecordStores;
}

/**
 * Two instances' counts both commit before either reads its view, so both read a complete set and both call `end`,
 * as the last two ACKs of most messages do at +5 ms per round trip.
 */
function createViewGate(released: Promise<void>): ViewGate {
    const written = { b: Promise.withResolvers<void>(), c: Promise.withResolvers<void>() };
    return {
        bothWritten: Promise.all([written.b.promise, written.c.promise]).then(() => undefined),
        gate: (name) => (stores) => {
            const { backend } = stores;
            let wrote = false;
            const afterWrite = async () => {
                if (wrote) {
                    await released;
                }
            };
            return {
                ...stores,
                backend: createDelegatingALAdmissionWorkBackend(backend, {
                    read: async (key, decode) => {
                        await afterWrite();
                        return await backend.read(key, decode);
                    },
                    list: async (prefix, decode) => {
                        await afterWrite();
                        return await backend.list(prefix, decode);
                    },
                    write: async (operation, executionExpiresAtMs) => {
                        const result = await backend.write(operation, executionExpiresAtMs);
                        wrote = true;
                        written[name].resolve();
                        return result;
                    }
                })
            };
        }
    };
}

/** Writes the record's `kind` work row of `ref` again, as a lease that ran out would leave it claimable. */
async function writeWorkAgain(cluster: RecordCluster, kind: 'ended'): Promise<void> {
    const nowMs = cluster.clock.nowMs;
    const entry = computeALReceiptRecordWorkEntry({
        namespace: cluster.recordNamespace,
        work: { kind, ref },
        observedAtMs: nowMs,
        readyAtMs: nowMs,
        expireAtTimestamp: nowMs + AL_RECEIPT_RECORD_WINDOW_MS
    });
    await cluster.recordBackend.write(async (transaction) => {
        await transaction.readWork(entry.key);
        transaction.writeWork(entry);
    });
}

async function settleEngines(instances: readonly ClusterInstance[]): Promise<void> {
    for (let round = 0; round < 6; round += 1) {
        for (const { engine } of instances) {
            await engine.executeOnce();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

/** Every refusal and every count the server observed for an ACK: refusals by their guards, counts by their outcome. */
function readAckVerdicts(cluster: RecordCluster): readonly AckVerdict[] {
    return cluster.observations.flatMap((observation): AckVerdict[] => {
        if (observation.kind === 'ack-rejection') {
            return [{ refused: observation.failedGuards }];
        }
        return observation.kind === 'ack-count'
            ? [{ recipient: observation.ack.logicalRecipientPeerId, outcome: observation.outcome, after: observation.after !== undefined }]
            : [];
    });
}

/** The outbox verdict of each delivery of the ended work's terminal receipt. */
function readEndedOutboxVerdicts(cluster: RecordCluster, controlId: string): readonly string[] {
    return cluster.observations.flatMap((observation) =>
        observation.kind === 'receipt-outbox' && observation.receiptControlMsgId === controlId ? [observation.verdict.kind] : []
    );
}

/**
 * The phases a poll reads, a few milliseconds later each time: the test clock stands still, and a row released for
 * an immediate retry comes due only once it moves, as a real clock would.
 */
function tickPhases(cluster: RecordCluster): readonly ALReceiptPayload['phase'][] {
    cluster.clock.nowMs += 5;
    return readOriginReceiptPhases(cluster.originSockets, MSG_ID);
}

function readConfirmationKeys(cluster: RecordCluster): readonly string[] {
    const prefix = toALReceiptRecordConfirmationPrefix(cluster.recordNamespace, ref);
    return cluster.recordBackend.peekKeys().filter((key) => key.startsWith(prefix));
}

function readHeadKeys(cluster: RecordCluster): readonly string[] {
    return cluster.recordBackend.peekKeys().filter((key) => key === toALReceiptRecordHeadKey(cluster.recordNamespace, ref));
}
