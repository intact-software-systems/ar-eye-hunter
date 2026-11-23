import { describe, expect, it } from 'vitest';

import { createRallarAlmReceiptDiagnosticsRecorder } from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import { createInMemoryALAdmissionState } from '@shared/alm/al-admission-backend.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';

import {
    countCopies,
    createBridgeBus,
    createReceiptClusterState,
    createReceiptInstanceStores,
    createReceiptOutbox,
    createReceiptServer,
    installClock,
    RECEIPT_SERVER_PEER_ID,
    serverNotification,
    sessionAck,
    type ReceiptServerInstance
} from './ws-queue-box-server-receipt-fixture.ts';

/** Long enough that the receipt budget (four 2 s windows) ends first. */
const NOTIFICATION_TTL_MS = 60_000;
const CLOCK_STEP_MS = 1_000;

describe('receipts of the server\'s own room notifications', () => {
    it('sends only to the audience frozen at publish and records who confirmed, then that the rest never did', async () => {
        // Pins the receipt of a notification counting someone outside the audience it was frozen to, or the admin read
        // stating the row's own exhaustion for a receipt the record ended.
        const clock = installClock();
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => clock.nowMs,
            capacity: 256
        });
        const outbox = createReceiptOutbox(clock);
        const stores = createReceiptInstanceStores(createReceiptClusterState(() => clock.nowMs), () => clock.nowMs);
        const record = new ALReceiptRecord({ ...stores.receiptRecordStores, nowMs: () => clock.nowMs });
        const local = await createReceiptServer({
            ...stores,
            inboundVolatileStores: undefined,
            outboundBackend: undefined,
            capturedRecipientEligibilityFilters: undefined,
            receiptObserver: undefined,
            outbox,
            state: createInMemoryALAdmissionState(outbox),
            peerIds: ['a', 'b', 'c'],
            recorder,
            nowMs: () => clock.nowMs
        });

        const notification = serverNotification('snapshot-1', 'receiver', NOTIFICATION_TTL_MS);

        const enqueued = await local.service.enqueueOutboxIfAbsent(
            notification,
            { admittedAudience: ['a', 'b'], admittedConnectionGenerationIds: undefined, recipientScope: undefined }
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

        await local.service.acceptIncomingMessage(sessionAck(notification, 'a', 'delivered'), 'a');
        expect((await record.read({ originPeerId: RECEIPT_SERVER_PEER_ID, msgId: 'snapshot-1' })).right?.tally.confirmedRecipientPeerIds)
            .toEqual(['a']);
        expect(recorder.readDiagnostics().messages).toEqual([]);

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.lastSettlementKind;
        }, { timeout: 5_000 }).toBe('acknowledgement');
        expect(recorder.readDiagnostics().messages).toEqual([expect.objectContaining({
            msgId: 'snapshot-1',
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'acknowledgement',
            receiptExhausted: false
        })]);
    });

    it('keeps a session that left in the receipt, where it reads unconfirmed, while the retries reach the rest', async () => {
        const clock = installClock();
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => clock.nowMs,
            capacity: 256
        });
        const outbox = createReceiptOutbox(clock);
        const local = await createReceiptServer({
            ...createReceiptInstanceStores(createReceiptClusterState(() => clock.nowMs), () => clock.nowMs),
            inboundVolatileStores: undefined,
            outboundBackend: undefined,
            capturedRecipientEligibilityFilters: undefined,
            receiptObserver: undefined,
            outbox,
            state: createInMemoryALAdmissionState(outbox),
            peerIds: ['a', 'b', 'c'],
            recorder,
            nowMs: () => clock.nowMs
        });

        const notification = serverNotification('snapshot-3', 'receiver', NOTIFICATION_TTL_MS);
        await local.service.enqueueOutboxIfAbsent(notification, {
            admittedAudience: ['a', 'b', 'c'],
            admittedConnectionGenerationIds: undefined,
            recipientScope: undefined
        });
        await expect.poll(async () => {
            await local.engine.executeOnce();
            return ['a', 'b', 'c'].map((peerId) => countCopies(local.sockets[peerId], 'snapshot-3'));
        }).toEqual([1, 1, 1]);
        await local.sockets.c.receiveClose(1000, 'left');
        await local.service.acceptIncomingMessage(sessionAck(notification, 'a', 'delivered'), 'a');

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.lastSettlementKind;
        }, { timeout: 5_000 }).toBe('acknowledgement');
        expect(countCopies(local.sockets.b, 'snapshot-3')).toBeGreaterThan(1);
        expect(recorder.readDiagnostics().messages[0]).toMatchObject({
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b', 'c'],
            receiptExhausted: false
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
                ...createReceiptInstanceStores(createReceiptClusterState(() => clock.nowMs), () => clock.nowMs),
                inboundVolatileStores: undefined,
                outboundBackend: undefined,
                capturedRecipientEligibilityFilters: undefined,
                receiptObserver: undefined,
                outbox,
                state: createInMemoryALAdmissionState(outbox),
                peerIds: ['a', 'b'],
                recorder,
                nowMs: () => clock.nowMs
            });
            const msgId = `snapshot-${ack}`;
            const notification = serverNotification(msgId, ack, NOTIFICATION_TTL_MS);

            await local.service.enqueueOutboxIfAbsent(notification, {
                admittedAudience: ['a', 'b'],
                admittedConnectionGenerationIds: undefined,
                recipientScope: undefined
            });
            await expect.poll(async () => {
                await local.engine.executeOnce();
                return [countCopies(local.sockets.a, msgId), countCopies(local.sockets.b, msgId)];
            }).toEqual([1, 1]);
            await local.service.acceptIncomingMessage(sessionAck(notification, 'a', 'delivered'), 'a');

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
        const local = await createReceiptServer({
            ...createReceiptInstanceStores(createReceiptClusterState(() => clock.nowMs), () => clock.nowMs),
            inboundVolatileStores: undefined,
            outboundBackend: undefined,
            capturedRecipientEligibilityFilters: undefined,
            receiptObserver: undefined,
            outbox,
            state,
            peerIds: ['a'],
            recorder,
            nowMs: () => clock.nowMs
        });
        const remote = await createReceiptServer({
            ...createReceiptInstanceStores(createReceiptClusterState(() => clock.nowMs), () => clock.nowMs),
            inboundVolatileStores: undefined,
            outboundBackend: undefined,
            capturedRecipientEligibilityFilters: undefined,
            receiptObserver: undefined,
            outbox,
            state,
            peerIds: ['c'],
            recorder: undefined,
            nowMs: () => clock.nowMs
        });
        await joinCluster(local, remote);

        const enqueued = await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-empty', 'receiver', NOTIFICATION_TTL_MS), {
            admittedAudience: [],
            admittedConnectionGenerationIds: undefined,
            recipientScope: undefined
        });
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
        const local = await createReceiptServer({
            ...createReceiptInstanceStores(createReceiptClusterState(nowMs), nowMs),
            inboundVolatileStores: undefined,
            outboundBackend: undefined,
            capturedRecipientEligibilityFilters: undefined,
            receiptObserver: undefined,
            outbox,
            state,
            peerIds: ['a', 'b'],
            recorder: undefined,
            nowMs
        });
        const remote = await createReceiptServer({
            ...createReceiptInstanceStores(createReceiptClusterState(nowMs), nowMs),
            inboundVolatileStores: undefined,
            outboundBackend: undefined,
            capturedRecipientEligibilityFilters: undefined,
            receiptObserver: undefined,
            outbox,
            state,
            peerIds: ['c', 'd'],
            recorder: undefined,
            nowMs
        });
        await joinCluster(local, remote);

        await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-uncaptured', 'receiver', NOTIFICATION_TTL_MS));

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
            ...createReceiptInstanceStores(createReceiptClusterState(nowMs), nowMs),
            inboundVolatileStores: undefined,
            outboundBackend: undefined,
            capturedRecipientEligibilityFilters: undefined,
            receiptObserver: undefined,
            outbox,
            state,
            peerIds: ['a', 'b'],
            recorder: undefined,
            nowMs
        });
        const remote = await createReceiptServer({
            ...createReceiptInstanceStores(createReceiptClusterState(nowMs), nowMs),
            inboundVolatileStores: undefined,
            outboundBackend: undefined,
            capturedRecipientEligibilityFilters: undefined,
            receiptObserver: undefined,
            outbox,
            state,
            peerIds: ['c', 'd'],
            recorder: undefined,
            nowMs
        });
        await joinCluster(local, remote);

        await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-2', 'receiver', NOTIFICATION_TTL_MS), {
            admittedAudience: ['a', 'c'],
            admittedConnectionGenerationIds: undefined,
            recipientScope: undefined
        });

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
