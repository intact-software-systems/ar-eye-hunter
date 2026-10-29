import { describe, expect, it } from 'vitest';

import { createRallarAlmReceiptDiagnosticsRecorder } from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState } from '@shared/alm/al-admission-backend.ts';

import {
    countCopies,
    createBridgeBus,
    createReceiptOutbox,
    createReceiptServer,
    installClock,
    RECEIPT_SERVER_PEER_ID,
    type ReceiptServerInstance
} from './ws-queue-box-server-receipt-fixture.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'room-1' };
/** Long enough that the receipt budget (four 2 s windows) ends first. */
const NOTIFICATION_TTL_MS = 60_000;
const CLOCK_STEP_MS = 1_000;

describe('receipts of the server\'s own room notifications', () => {
    it('sends only to the audience frozen at publish and records who confirmed, then that the rest never did', async () => {
        const clock = installClock();
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => clock.nowMs,
            capacity: 256
        });
        const outbox = createReceiptOutbox(clock);
        const local = await createReceiptServer({
            outbox,
            state: createInMemoryALAdmissionState(outbox),
            peerIds: ['a', 'b', 'c'],
            recorder,
            nowMs: () => clock.nowMs
        });

        const enqueued = await local.service.enqueueOutboxIfAbsent(
            serverNotification('snapshot-1'),
            { admittedAudience: ['a', 'b'], recipientScope: undefined }
        );

        expect(enqueued.verdict.kind).toBe('admitted');
        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [
                countCopies(local.sockets.a, 'snapshot-1'),
                countCopies(local.sockets.b, 'snapshot-1')
            ];
        }).toEqual([1, 1]);
        expect(countCopies(local.sockets.c, 'snapshot-1')).toBe(0);

        await local.service.acceptIncomingMessage(sessionAck('snapshot-1', 'a'), 'a');
        expect(recorder.readDiagnostics().messages).toEqual([expect.objectContaining({
            msgId: 'snapshot-1',
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            receiptExhausted: false
        })]);

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.receiptExhausted;
        }, { timeout: 5_000 }).toBe(true);
        expect(recorder.readDiagnostics().messages[0]).toMatchObject({
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'receipt-exhausted'
        });
    });

    it('keeps a session that left in the receipt, where it reads unconfirmed, while the retries reach the rest', async () => {
        const clock = installClock();
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => clock.nowMs,
            capacity: 256
        });
        const outbox = createReceiptOutbox(clock);
        const local = await createReceiptServer({
            outbox,
            state: createInMemoryALAdmissionState(outbox),
            peerIds: ['a', 'b', 'c'],
            recorder,
            nowMs: () => clock.nowMs
        });

        await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-3'), { admittedAudience: ['a', 'b', 'c'], recipientScope: undefined });
        await expect.poll(async () => {
            await local.engine.executeOnce();
            return ['a', 'b', 'c'].map((peerId) => countCopies(local.sockets[peerId], 'snapshot-3'));
        }).toEqual([1, 1, 1]);
        await local.sockets.c.receiveClose(1000, 'left');
        await local.service.acceptIncomingMessage(sessionAck('snapshot-3', 'a'), 'a');

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.receiptExhausted;
        }, { timeout: 5_000 }).toBe(true);
        expect(countCopies(local.sockets.b, 'snapshot-3')).toBeGreaterThan(1);
        expect(recorder.readDiagnostics().messages[0]).toMatchObject({
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b', 'c']
        });
    });

    it.each(['hop', 'subtree'] as const)(
        'keeps the hop that confirmed a %s receipt across the retries to the rest, which never re-route',
        async (ack) => {
            const clock = installClock();
            const recorder = createRallarAlmReceiptDiagnosticsRecorder({
                nowEpochMs: () => clock.nowMs,
                capacity: 256
            });
            const outbox = createReceiptOutbox(clock);
            const local = await createReceiptServer({
                outbox,
                state: createInMemoryALAdmissionState(outbox),
                peerIds: ['a', 'b'],
                recorder,
                nowMs: () => clock.nowMs
            });
            const msgId = `snapshot-${ack}`;

            await local.service.enqueueOutboxIfAbsent(serverNotification(msgId, ack), { admittedAudience: ['a', 'b'], recipientScope: undefined });
            await expect.poll(async () => {
                await local.engine.executeOnce();
                return [countCopies(local.sockets.a, msgId), countCopies(local.sockets.b, msgId)];
            }).toEqual([1, 1]);
            await local.service.acceptIncomingMessage(sessionAck(msgId, 'a'), 'a');

            await expect.poll(async () => {
                clock.nowMs += CLOCK_STEP_MS;
                await local.engine.executeOnce();
                return recorder.readDiagnostics().messages[0]?.receiptExhausted;
            }, { timeout: 5_000 }).toBe(true);
            expect(countCopies(local.sockets.b, msgId)).toBeGreaterThan(1);
            expect(countCopies(local.sockets.a, msgId)).toBe(1);
            expect(recorder.readDiagnostics().messages[0]).toMatchObject({
                mode: ack,
                confirmedPeerIds: ['a'],
                unconfirmedPeerIds: ['b']
            });
        }
    );

    it('completes a notification to an empty room at admission: nothing is sent and nothing is recorded', async () => {
        const clock = installClock();
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => clock.nowMs,
            capacity: 256
        });
        const outbox = createReceiptOutbox(clock);
        const state = createInMemoryALAdmissionState(outbox);
        const local = await createReceiptServer({ outbox, state, peerIds: ['a'], recorder, nowMs: () => clock.nowMs });
        const remote = await createReceiptServer({ outbox, state, peerIds: ['c'], recorder: undefined, nowMs: () => clock.nowMs });
        await joinCluster(local, remote);

        const enqueued = await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-empty'), { admittedAudience: [], recipientScope: undefined });
        for (let step = 0; step < 5; step += 1) {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            await remote.engine.executeOnce();
        }

        expect(enqueued.verdict.kind).toBe('admitted');
        expect(countCopies(local.sockets.a, 'snapshot-empty')).toBe(0);
        expect(countCopies(remote.sockets.c, 'snapshot-empty')).toBe(0);
        expect(recorder.readDiagnostics().messages).toEqual([]);
    });

    it('sends a row with no captured audience to every current session, on the publishing instance and on every other one', async () => {
        const clock = installClock();
        const outbox = createReceiptOutbox(clock);
        const state = createInMemoryALAdmissionState(outbox);
        const nowMs = () => clock.nowMs;
        const local = await createReceiptServer({ outbox, state, peerIds: ['a', 'b'], recorder: undefined, nowMs });
        const remote = await createReceiptServer({ outbox, state, peerIds: ['c', 'd'], recorder: undefined, nowMs });
        await joinCluster(local, remote);

        await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-uncaptured'));

        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [
                countCopies(local.sockets.a, 'snapshot-uncaptured'),
                countCopies(local.sockets.b, 'snapshot-uncaptured'),
                countCopies(remote.sockets.c, 'snapshot-uncaptured'),
                countCopies(remote.sockets.d, 'snapshot-uncaptured')
            ];
        }).toEqual([1, 1, 1, 1]);
    });

    it('sends the frozen audience only, on the publishing instance and on every other one', async () => {
        const clock = installClock();
        const outbox = createReceiptOutbox(clock);
        const state = createInMemoryALAdmissionState(outbox);
        const nowMs = () => clock.nowMs;
        const local = await createReceiptServer({
            outbox,
            state,
            peerIds: ['a', 'b'],
            recorder: undefined,
            nowMs
        });
        const remote = await createReceiptServer({
            outbox,
            state,
            peerIds: ['c', 'd'],
            recorder: undefined,
            nowMs
        });
        await joinCluster(local, remote);

        await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-2'), { admittedAudience: ['a', 'c'], recipientScope: undefined });

        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [
                countCopies(local.sockets.a, 'snapshot-2'),
                countCopies(remote.sockets.c, 'snapshot-2')
            ];
        }).toEqual([1, 1]);
        expect(countCopies(local.sockets.b, 'snapshot-2')).toBe(0);
        expect(countCopies(remote.sockets.d, 'snapshot-2')).toBe(0);
    });
});

async function joinCluster(local: ReceiptServerInstance, remote: ReceiptServerInstance): Promise<void> {
    const bus = createBridgeBus();
    await installQueueBoxPubSubBridge({ wsQBoxServerService: local.service, bridge: bus, channel: 'ws', publisherId: 'local' });
    await installQueueBoxPubSubBridge({ wsQBoxServerService: remote.service, bridge: bus, channel: 'ws', publisherId: 'remote' });
}

function serverNotification(msgId: string, ack: 'receiver' | 'hop' | 'subtree' = 'receiver'): ALMessage {
    const message = newALBroadcastMessage(
        RECEIPT_SERVER_PEER_ID,
        newALRoute('room.snapshot', ROOM.groupId, msgId),
        'room',
        'snapshot.v1',
        { msgId },
        {
            groupRef: ROOM,
            reliability: 'at-least-once',
            qos: { ack: { algo: ack } },
            ttlMs: NOTIFICATION_TTL_MS
        }
    );
    return { ...message, id: { ...message.id, msgId } };
}

function sessionAck(ackedMsgId: string, recipient: string): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${ackedMsgId}-${recipient}`, senderId: recipient, ts: Date.now(), traceId: 'trace-ws-queue-box-server-originated-receipt' },
        {
            ackedMsgId,
            fromPeerId: recipient,
            toPeerId: RECEIPT_SERVER_PEER_ID,
            originPeerId: RECEIPT_SERVER_PEER_ID,
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}
