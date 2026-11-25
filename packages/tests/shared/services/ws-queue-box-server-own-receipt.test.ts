import { describe, expect, it } from 'vitest';

import {
    createRallarAlmReceiptDiagnosticsRecorder,
    type RallarAlmReceiptDiagnosticsRecorder
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import type { QueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { computeGroupStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage, type ALNackReason } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALReceiptRecordConfirmationPrefix } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import { decodeALReceiptRecordConfirmation, type ALReceiptRecordConfirmation } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import { toALReceiptRecordWorkKey } from '@shared/alm/receipt-record/al-receipt-record-work-entry.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import type { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, NOT_COMPLETED_RETRYABLE_STATUSES, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import type { WsQueueBoxServerReceiptObservation } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';
import { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import { createGroupDeltaStateSync } from '../../shared-server/rallar-system/state-sync/create-state-sync-effect-fixture.ts';
import { createDelegatingALAdmissionWorkBackend } from '../alm/create-delegating-al-admission-work-backend.ts';
import { createWorkerHold, type WorkerHold } from '../alm/create-worker-hold.ts';
import { holdALAdmissionWrite } from '../alm/hold-al-admission-write.ts';
import type { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import {
    connect,
    countCopies,
    createBridgeBus,
    createClusterInstance,
    createReceiptClusterState,
    createReceiptInstanceStores,
    createReceiptOutbox,
    createReceiptServer,
    installClock,
    MEMORY_POLL_TIMEOUT_MS,
    pollRowEnded,
    readReceiptAggregationVerdicts,
    RECEIPT_SERVER_PEER_ID,
    serverNotification,
    sessionAck,
    toOwnReceiptRef,
    type ClusterInstance,
    type ReceiptClock,
    type ReceiptServerInstance,
    type RowEndedPoll
} from './ws-queue-box-server-receipt-fixture.ts';

import { toTestALAckPayload } from '../../al-control-test-payloads.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const DELTA_TRACE_ID = 'trace-own-receipt-delta';
/** The ACK timeout a delta resolves to: the server row's retry window. */
const ACK_TIMEOUT_MS = 2_000;
/** The head's deadline after the dequeue: the row's four windows less half of one. */
const HEAD_LIFETIME_MS = 7_000;
const CLOCK_STEP_MS = 1_000;
const NOTIFICATION_TTL_MS = 60_000;

/** A case's own backend over the base one the server would use. */
type BackendWrapper = (base: ALAdmissionWorkBackend) => ALAdmissionWorkBackend;

interface OwnReceiptServerOptions {
    readonly peerIds: readonly string[];
    /** Undefined: the receipt record writes through the base backend. */
    readonly recordBackend: BackendWrapper | undefined;
    /** Sessions durable presence no longer holds; undefined, no presence filter. */
    readonly left: ReadonlySet<string> | undefined;
}

interface OwnReceiptReaders {
    /** The test's own reader of the receipt record the server counts in. */
    readonly record: ALReceiptRecord;
    readonly recordBackend: InMemoryAdmissionBackend;
    readonly recordNamespace: string;
    /** The test's own reader of the server's outbound admission state, where its pending row lives. */
    readonly store: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>;
}

interface OwnReceiptServer extends ReceiptServerInstance, OwnReceiptReaders {
    readonly outbox: InMemoryQueueBox;
    readonly recorder: RallarAlmReceiptDiagnosticsRecorder;
    readonly observations: readonly WsQueueBoxServerReceiptObservation[];
}

interface OwnReceiptCluster extends OwnReceiptReaders {
    readonly instance: ClusterInstance;
    readonly outbox: InMemoryQueueBox;
    readonly sockets: Readonly<Record<'a' | 'b', SimulatedWebSocket>>;
}

interface FailedHookPublication {
    readonly cluster: OwnReceiptCluster;
    readonly delta: ALMessage;
    readonly failing: { readonly armed: boolean; };
}

describe('the receipt of a server publication is counted in the receipt record', () => {
    it('opens one head at the first dequeue, expecting the judged audience, and answers nobody', async () => {
        // Pins a head opened from the policy an enqueued publication committed, which expects nobody, so it opened
        // nothing; and an `admitted` receipt written for a publication nobody awaits.
        const clock = installClock();
        const server = await createOwnReceiptServer(clock, defaultOptions(['a', 'b']));

        const delta = await publishDelta(server, clock, ['a', 'b']);

        expect((await server.record.read(toOwnReceiptRef(delta))).right?.head).toMatchObject({
            phase: 'open',
            opening: { originPeerId: RECEIPT_SERVER_PEER_ID, expectedRecipientPeerIds: ['a', 'b'], snapshotVersion: 0 }
        });
        expect(server.observations.filter((observation) => observation.kind === 'receipt-outbox')).toEqual([]);
    });

    it('counts a session\'s ACK in the record and leaves the server\'s row and the publication\'s version as they were', async () => {
        // Pins every ACK of a server publication being one fenced commit on the publication's version row.
        const clock = installClock();
        const server = await createOwnReceiptServer(clock, defaultOptions(['a', 'b']));
        const delta = await publishDelta(server, clock, ['a', 'b']);
        const read = { msgId: delta.id.msgId, originPeerId: RECEIPT_SERVER_PEER_ID, phase: 'admitted', expectedRecipientPeerIds: ['a', 'b'] } as const;
        const before = await server.store.readReceiptAdmission(read);
        expect(typeof before.messageVersion?.version).toBe('number');

        await server.service.acceptIncomingMessage(sessionAck(delta, 'a', 'delivered'), 'a');

        const after = await server.store.readReceiptAdmission(read);
        expect((await server.record.read(toOwnReceiptRef(delta))).right?.tally.confirmedRecipientPeerIds).toEqual(['a']);
        expect(after.messageVersion?.version).toBe(before.messageVersion?.version);
        expect(after.pending?.ackedPeerIds).toEqual([]);
    });

    it('completes: the head ends complete, the row ends, and the admin read names every recipient confirmed', async () => {
        // Pins a complete record that never reached the server's row, which then retried and exhausted the receipt.
        const clock = installClock();
        const server = await createOwnReceiptServer(clock, defaultOptions(['a', 'b']));
        const delta = await publishDelta(server, clock, ['a', 'b']);

        await server.service.acceptIncomingMessage(sessionAck(delta, 'a', 'delivered'), 'a');
        await server.service.acceptIncomingMessage(sessionAck(delta, 'b', 'delivered'), 'b');
        await pollRowEnded(toRowEndedPoll(server, clock, delta));

        expect((await server.record.read(toOwnReceiptRef(delta))).right?.head.phase).toBe('complete');
        expect(server.recorder.readDiagnostics().messages).toEqual([expect.objectContaining({
            confirmedPeerIds: ['a', 'b'],
            unconfirmedPeerIds: [],
            lastSettlementKind: 'acknowledgement',
            receiptExhausted: false
        })]);
    });

    it('ends timed-out half a window before the row\'s budget, and the row states no exhaustion', async () => {
        // Pins the row's own budget ending the message from a row that counted nobody, naming `a` unconfirmed.
        const clock = installClock();
        const server = await createOwnReceiptServer(clock, defaultOptions(['a', 'b']));
        const delta = await publishDelta(server, clock, ['a', 'b']);
        const dequeuedAtMs = clock.nowMs;
        await server.service.acceptIncomingMessage(sessionAck(delta, 'a', 'delivered'), 'a');

        // The row's budget ends one ACK timeout after its third retry: the clock steps past it, and each step runs
        // every window, hint and send due by then.
        while (clock.nowMs < dequeuedAtMs + 4 * ACK_TIMEOUT_MS + CLOCK_STEP_MS) {
            clock.nowMs += CLOCK_STEP_MS;
            await settleDueWork(server, clock);
        }

        expect((await server.store.readStoredMessage(delta.id.msgId))?.ended).toBe(true);

        expect((await server.record.read(toOwnReceiptRef(delta))).right?.head).toMatchObject({ phase: 'timed-out', confirmedRecipientPeerIds: ['a'] });
        expect(server.recorder.readDiagnostics().messages).toEqual([expect.objectContaining({
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'acknowledgement',
            receiptExhausted: false
        })]);
        // b: the dequeue's copy and one for each of the row's three retries.
        expect(copiesOf(server.sockets, delta)).toEqual([1, 4]);
    });

    it('counts an ACK that overtakes the head, and the head that opens completes on it', async () => {
        // Pins an ACK that reached the server before its publication's head was open being lost, so a receipt every
        // recipient confirmed waited for its deadline.
        const clock = installClock();
        const hold = createWorkerHold();
        const server = await createOwnReceiptServer(clock, { ...defaultOptions(['a', 'b']), recordBackend: toHeldOnce(hold) });
        const delta = createDelta(clock);
        await server.service.enqueueOutboxIfAbsent(delta, audience(['a', 'b']));
        try {
            const dequeued = server.engine.executeOnce();
            await hold.arrived;
            await server.service.acceptIncomingMessage(sessionAck(delta, 'a', 'delivered'), 'a');
            await server.service.acceptIncomingMessage(sessionAck(delta, 'b', 'delivered'), 'b');
            expect((await server.record.read(toOwnReceiptRef(delta))).left).toEqual({ kind: 'head-absent' });
            hold.release();
            await dequeued;
        }
        finally {
            hold.release();
        }

        await pollRowEnded(toRowEndedPoll(server, clock, delta));
        expect((await server.record.read(toOwnReceiptRef(delta))).right?.head).toMatchObject({ phase: 'complete', confirmedRecipientPeerIds: ['a', 'b'] });
    });

    it('writes nothing for an ACK ahead of its head from a session the pending row does not expect', async () => {
        // Pins an ACK no pending row proves leaving a stray confirmation: a session confirming a publication it was
        // never sent.
        const clock = installClock();
        const hold = createWorkerHold();
        const server = await createOwnReceiptServer(clock, { ...defaultOptions(['a', 'b', 'c']), recordBackend: toHeldOnce(hold) });
        const delta = createDelta(clock);
        await server.service.enqueueOutboxIfAbsent(delta, audience(['a', 'b']));
        try {
            const dequeued = server.engine.executeOnce();
            await hold.arrived;
            await server.service.acceptIncomingMessage(sessionAck(delta, 'c', 'delivered'), 'c');

            expect(readReceiptAggregationVerdicts(server.observations, delta.id.msgId)).toEqual(['ack-count:rejected']);
            expect(await readConfirmations(server, delta)).toEqual([]);
            hold.release();
            await dequeued;
        }
        finally {
            hold.release();
        }
    });

    it('records a session a retry drops as outside; one dropped at the first dequeue writes nothing', async () => {
        // Pins a retry's drop being written where the record never reads it, and a first dequeue's drop, which
        // precedes the pending row that would prove it, being counted ahead as a row no head ever reads, or observed
        // as an unauthorized ACK with the server as its sender.
        const clock = installClock();
        const left = new Set(['c']);
        const server = await createOwnReceiptServer(clock, { ...defaultOptions(['a', 'b', 'c']), left });
        const delta = createDelta(clock);
        await server.service.enqueueOutboxIfAbsent(delta, audience(['a', 'b', 'c']));
        await expect.poll(async () => {
            await server.engine.executeOnce();
            return copiesOf(server.sockets, delta);
        }).toEqual([1, 1, 0]);
        expect(await readConfirmations(server, delta)).toEqual([]);
        expect(readReceiptAggregationVerdicts(server.observations, delta.id.msgId)).toEqual([]);
        expect((await server.record.read(toOwnReceiptRef(delta))).right?.head.opening.expectedRecipientPeerIds).toEqual(['a', 'b']);
        await server.service.acceptIncomingMessage(sessionAck(delta, 'a', 'delivered'), 'a');

        left.add('b');
        clock.nowMs += ACK_TIMEOUT_MS + 1;
        await pollRowEnded(toRowEndedPoll(server, clock, delta));

        expect((await server.record.read(toOwnReceiptRef(delta))).right?.head).toMatchObject({
            phase: 'complete',
            confirmedRecipientPeerIds: ['a'],
            outsideAudienceRecipientPeerIds: ['b']
        });
        expect(copiesOf(server.sockets, delta)).toEqual([1, 1, 0]);
    });

    it('leaves a hop-receipted server message to the outbound owner', async () => {
        // Pins an ACK of a receipt no record counts being written into the record, where nothing reads it.
        const clock = installClock();
        const server = await createOwnReceiptServer(clock, defaultOptions(['a', 'b']));
        const notification = serverNotification('snapshot-hop', 'hop', NOTIFICATION_TTL_MS);
        await server.service.enqueueOutboxIfAbsent(notification, audience(['a', 'b']));
        await expect.poll(async () => {
            await server.engine.executeOnce();
            return copiesOf(server.sockets, notification);
        }).toEqual([1, 1]);

        await server.service.acceptIncomingMessage(sessionAck(notification, 'a', 'delivered'), 'a');
        await server.service.acceptIncomingMessage(sessionAck(notification, 'b', 'delivered'), 'b');

        await pollRowEnded(toRowEndedPoll(server, clock, notification));
        expect((await server.record.read(toOwnReceiptRef(notification))).left).toEqual({ kind: 'head-absent' });
        expect(await readConfirmations(server, notification)).toEqual([]);
    });

    it('publishes the publication when the record cannot be written at the dequeue, and the failure propagates', async () => {
        // Pins a failed `open` stopping the dequeue hook: a cluster's copies all go out inside the hook, so the
        // publication went unsent. The failure propagates, so the attempt is dequeued again, and its retry opens the head.
        const clock = installClock();
        const { cluster, delta, failing } = await publishThroughFailedHook(clock);

        expect(failing.armed).toBe(false);
        expect(copiesOf(cluster.sockets, delta)).toEqual([1, 1]);
        expect(await cluster.store.readPendingAck(toOwnReceiptRef(delta))).toMatchObject({ expectedPeerIds: ['a', 'b'] });
        expect((await cluster.record.read(toOwnReceiptRef(delta))).left).toEqual({ kind: 'head-absent' });
        await expect.poll(async () => {
            clock.nowMs += 5;
            await cluster.instance.engine.executeOnce();
            return (await cluster.record.read(toOwnReceiptRef(delta))).right?.head.phase;
        }).toBe('open');
        expect((await readOutboxRow(cluster.outbox))?.dequeueAudit.attempts).toBe(2);
    });

    it('a dequeue retried after a failed hook sends every copy again', async () => {
        // Pins what a propagated record failure costs: the retry dispatches the row again, so each session holds the
        // copy of each attempt.
        const clock = installClock();
        const { cluster, delta } = await publishThroughFailedHook(clock);

        await expect.poll(async () => {
            clock.nowMs += 5;
            await cluster.instance.engine.executeOnce();
            return copiesOf(cluster.sockets, delta);
        }).toEqual([2, 2]);
    });

    it('a row dequeued again changes no head', async () => {
        // Pins a second dequeue of one row opening its head again, moving its deadline and its deadline row.
        const clock = installClock();
        const failing = { armed: false };
        const bus = createBridgeBus();
        const cluster = await createOwnReceiptCluster(clock, {
            recordBackend: (base) => base,
            bus: {
                subscribe: bus.subscribe,
                publish: async (channel, message) => {
                    if (failing.armed) {
                        failing.armed = false;
                        throw new Error('Cluster bus unavailable');
                    }
                    await bus.publish(channel, message);
                }
            }
        });
        const delta = createDelta(clock);
        await cluster.instance.service.enqueueOutboxIfAbsent(delta, audience(['a', 'b']));
        failing.armed = true;
        const firstDequeueAtMs = clock.nowMs;

        await expect.poll(async () => {
            await cluster.instance.engine.executeOnce();
            return failing.armed;
        }).toBe(false);
        expect((await cluster.record.read(toOwnReceiptRef(delta))).right?.head.opening.deadlineAtMs).toBe(firstDequeueAtMs + HEAD_LIFETIME_MS);
        await expect.poll(async () => {
            clock.nowMs += 5;
            await cluster.instance.engine.executeOnce();
            return copiesOf(cluster.sockets, delta);
        }).toEqual([1, 1]);

        expect((await cluster.store.readPendingAck(toOwnReceiptRef(delta)))?.deadlineAtMs).toBeGreaterThan(firstDequeueAtMs + ACK_TIMEOUT_MS);
        expect((await cluster.record.read(toOwnReceiptRef(delta))).right?.head).toMatchObject({
            phase: 'open',
            opening: { deadlineAtMs: firstDequeueAtMs + HEAD_LIFETIME_MS }
        });
        const deadlineRow = await cluster.recordBackend.workQueue.getItem(
            toALReceiptRecordWorkKey(cluster.recordNamespace, 'deadline', toOwnReceiptRef(delta))
        );
        expect(deadlineRow?.dequeueAudit.nextTs?.epochMilliseconds).toBe(firstDequeueAtMs + HEAD_LIFETIME_MS);
    });

    it.each(
        [
            ['before-entry', [(delta: ALMessage) => sessionNack(delta, 'b', 'before-entry')]],
            ['not-subscribed', [
                (delta: ALMessage) => sessionNack(delta, 'b', 'not-subscribed'),
                (delta: ALMessage) => sessionAck(delta, 'b', 'subtree-complete-not-subscribed')
            ]]
        ] as const
    )('completes a server publication a recipient answers outside its audience: %s', async (_reason, frames) => {
        // Pins a recipient outside the audience keeping the receipt open until its deadline: the server's row moves
        // it outside, and the record, which decides when the receipt ends, never heard. The frames are what a
        // recipient's inbound runtime sends for each reason: a `before-entry` NACK alone, or a `not-subscribed` NACK
        // and the hop-end ACK that confirms nobody.
        const clock = installClock();
        const server = await createOwnReceiptServer(clock, defaultOptions(['a', 'b']));
        const delta = await publishDelta(server, clock, ['a', 'b']);
        await server.service.acceptIncomingMessage(sessionAck(delta, 'a', 'delivered'), 'a');

        for (const frame of frames) {
            await server.service.acceptIncomingMessage(frame(delta), 'b');
        }

        await pollRowEnded(toRowEndedPoll(server, clock, delta));
        expect((await server.record.read(toOwnReceiptRef(delta))).right?.head).toMatchObject({
            phase: 'complete',
            confirmedRecipientPeerIds: ['a'],
            outsideAudienceRecipientPeerIds: ['b']
        });
    });

    it('opens at the first window a head its dequeue failed to open, and resends only to the unconfirmed', async () => {
        // Pins a record store that failed at the dequeue leaving the publication with no head, its ACKs counted ahead
        // and never read, and the retry resending to every recipient. Every attempt of the dequeue fails while armed;
        // each is dispatched again, so each session holds one copy per attempt.
        const clock = installClock();
        const failing = { armed: false };
        const server = await createOwnReceiptServer(clock, { ...defaultOptions(['a', 'b', 'c']), recordBackend: toFailingWhileArmed(failing) });
        const delta = await publishWithFailedOpens(server, clock, failing);
        await server.service.acceptIncomingMessage(sessionAck(delta, 'a', 'delivered'), 'a');
        await server.service.acceptIncomingMessage(sessionAck(delta, 'b', 'delivered'), 'b');
        const sent = countCopies(getSessionSocket(server, 'a'), delta.id.msgId);

        await runRowWindow(server, clock, delta);

        expect((await server.record.read(toOwnReceiptRef(delta))).right).toMatchObject({
            head: { phase: 'open' },
            tally: { confirmedRecipientPeerIds: ['a', 'b'] }
        });
        expect(copiesOf(server.sockets, delta)).toEqual([sent, sent, sent + 1]);
    });

    it('ends complete at the first window when every recipient was confirmed ahead, and resends nothing', async () => {
        // Pins a head the window opened complete being left open to its deadline while the row resent to everyone.
        const clock = installClock();
        const failing = { armed: false };
        const server = await createOwnReceiptServer(clock, { ...defaultOptions(['a', 'b', 'c']), recordBackend: toFailingWhileArmed(failing) });
        const delta = await publishWithFailedOpens(server, clock, failing);
        for (const sessionId of ['a', 'b', 'c']) {
            await server.service.acceptIncomingMessage(sessionAck(delta, sessionId, 'delivered'), sessionId);
        }
        const sent = countCopies(getSessionSocket(server, 'a'), delta.id.msgId);
        const attempts = (await server.store.readReceiptState(toOwnReceiptRef(delta)))?.attempts;
        if (attempts === undefined) {
            throw new Error('The server has no receipt row for the publication');
        }

        await runRowWindow(server, clock, delta);

        expect((await server.store.readReceiptState(toOwnReceiptRef(delta)))?.attempts).toBe(attempts + 1);
        expect((await server.record.read(toOwnReceiptRef(delta))).right?.head).toMatchObject({
            phase: 'complete',
            confirmedRecipientPeerIds: ['a', 'b', 'c']
        });
        expect((await server.store.readStoredMessage(delta.id.msgId))?.ended).toBe(true);
        expect(copiesOf(server.sockets, delta)).toEqual([sent, sent, sent]);
    });

    it('leaves a late ACK of an ended publication whose head never opened to the outbound owner, and writes nothing', async () => {
        // Pins an ended message's kept incomplete row proving an ACK that finds no head: it was counted ahead into a
        // record no head reads, and the outbound owner, which refuses an ACK of a message that has ended, never saw it.
        const clock = installClock();
        const failing = { armed: false };
        const server = await createOwnReceiptServer(clock, { ...defaultOptions(['a', 'b', 'c']), recordBackend: toFailingWhileArmed(failing) });
        const notification = createNoRetryNotification(clock);
        await server.service.enqueueOutboxIfAbsent(notification, audience(['a', 'b', 'c']));
        failing.armed = true;
        await settleDueWork(server, clock);
        failing.armed = false;
        expect((await server.record.read(toOwnReceiptRef(notification))).left).toEqual({ kind: 'head-absent' });
        await runRowWindow(server, clock, notification);
        expect((await server.store.readStoredMessage(notification.id.msgId))?.ended).toBe(true);
        expect((await server.store.readReceiptState(toOwnReceiptRef(notification)))?.ackedPeerIds).toEqual([]);

        await server.service.acceptIncomingMessage(sessionAck(notification, 'a', 'delivered'), 'a');

        expect(await readConfirmations(server, notification)).toEqual([]);
        expect(readReceiptAggregationVerdicts(server.observations, notification.id.msgId)).toEqual([]);
        expect((await server.record.read(toOwnReceiptRef(notification))).left).toEqual({ kind: 'head-absent' });
    });

    it('writes nothing for a late outside-audience NACK of an ended publication whose head never opened', async () => {
        // Pins an ended message's kept incomplete row, which names the recipient outside, proving the late NACK: it was
        // counted ahead as a stray row no head ever reads.
        const clock = installClock();
        const failing = { armed: false };
        const server = await createOwnReceiptServer(clock, { ...defaultOptions(['a', 'b']), recordBackend: toFailingWhileArmed(failing) });
        const notification = createNoRetryNotification(clock);
        await server.service.enqueueOutboxIfAbsent(notification, audience(['a', 'b']));
        failing.armed = true;
        await settleDueWork(server, clock);
        await expect(server.service.acceptIncomingMessage(sessionNack(notification, 'b', 'before-entry'), 'b'))
            .rejects.toThrow('Receipt record store unavailable');
        failing.armed = false;
        await runRowWindow(server, clock, notification);
        expect((await server.store.readStoredMessage(notification.id.msgId))?.ended).toBe(true);
        expect((await server.store.readReceiptState(toOwnReceiptRef(notification)))?.outsideAudiencePeerIds).toEqual(['b']);

        await server.service.acceptIncomingMessage(sessionNack(notification, 'b', 'not-subscribed'), 'b');

        expect(await readConfirmations(server, notification)).toEqual([]);
        expect((await server.record.read(toOwnReceiptRef(notification))).left).toEqual({ kind: 'head-absent' });
    });

    it('keeps the per-ACK count for a publication whose opening the record refuses', async () => {
        // Pins the ACKs of a publication with no head, and none possible, being dropped: the row would resend to every
        // recipient and keep a stray confirmation row per ACK.
        const clock = installClock();
        const sessions = Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.collectionEntries + 1 }, (_, index) => `s${index}`);
        const server = await createOwnReceiptServer(clock, defaultOptions(sessions));
        const notification = serverNotification('snapshot-crowd', 'receiver', NOTIFICATION_TTL_MS);
        await server.service.enqueueOutboxIfAbsent(notification, audience(undefined));
        await expect.poll(async () => {
            await server.engine.executeOnce();
            return (await server.store.readPendingAck(toOwnReceiptRef(notification)))?.expectedPeerIds.length;
        }).toBe(sessions.length);

        await server.service.acceptIncomingMessage(sessionAck(notification, 's0', 'delivered'), 's0');

        expect((await server.record.read(toOwnReceiptRef(notification))).left).toEqual({ kind: 'head-absent' });
        expect(await readConfirmations(server, notification)).toEqual([]);
        expect((await server.store.readReceiptState(toOwnReceiptRef(notification)))?.ackedPeerIds).toEqual(['s0']);
    });

    it('counts at the next window an outside-audience NACK whose record write failed, and ends complete at once', async () => {
        // Pins the record's outside confirmation of an admitted NACK being one-shot: a write that failed after the
        // server's row admitted the NACK was never tried again, so the receipt waited for its deadline.
        const clock = installClock();
        const failing = { armed: false };
        const server = await createOwnReceiptServer(clock, { ...defaultOptions(['a', 'b']), recordBackend: toFailingOnce(failing) });
        const delta = await publishDelta(server, clock, ['a', 'b']);
        await server.service.acceptIncomingMessage(sessionAck(delta, 'a', 'delivered'), 'a');
        failing.armed = true;

        await expect(server.service.acceptIncomingMessage(sessionNack(delta, 'b', 'before-entry'), 'b'))
            .rejects.toThrow('Receipt record store unavailable');

        expect((await server.store.readReceiptState(toOwnReceiptRef(delta)))?.outsideAudiencePeerIds).toEqual(['b']);
        expect((await server.record.read(toOwnReceiptRef(delta))).right?.tally.outsideAudienceRecipientPeerIds).toEqual([]);
        await runRowWindow(server, clock, delta);

        expect((await server.record.read(toOwnReceiptRef(delta))).right?.head).toMatchObject({
            phase: 'complete',
            confirmedRecipientPeerIds: ['a'],
            outsideAudienceRecipientPeerIds: ['b']
        });
        expect((await server.store.readStoredMessage(delta.id.msgId))?.ended).toBe(true);
        expect(copiesOf(server.sockets, delta)).toEqual([1, 1]);
    });
});

/** The delta the state sync computes for the room, as its producer row carries it. */
function createDelta(clock: ReceiptClock): ALMessage {
    const [entry] = computeGroupStateSyncEntries(
        createGroupDeltaStateSync({ nowMs: clock.nowMs, traceId: DELTA_TRACE_ID }),
        RECEIPT_SERVER_PEER_ID
    );
    if (entry === undefined) {
        throw new Error('Expected one group-state delta entry');
    }
    return decodePersistedALMessage(entry.resource);
}

/** A receipted room notification of the server's that asks no retry: its row ends at its first ACK window. */
function createNoRetryNotification(clock: ReceiptClock): ALMessage {
    const msgId = 'snapshot-no-retry';
    const message = newALBroadcastMessage({
        createdAtEpochMs: clock.nowMs,
        senderId: RECEIPT_SERVER_PEER_ID,
        route: newALRoute('room.snapshot', ROOM.groupId, msgId),
        scope: 'room',
        typeId: 'snapshot.v1',
        resource: { msgId },
        options: {
            groupRef: ROOM,
            reliability: 'at-least-once',
            qos: { ack: { algo: 'receiver' }, retry: { algo: 'none', opts: { maxAttempts: 0 } } },
            ttlMs: NOTIFICATION_TTL_MS
        }
    });
    return { ...message, id: { ...message.id, msgId } };
}

function audience(admittedAudience: readonly string[] | undefined): WsQueueBoxServerService.EnqueueAuthority {
    return { admittedAudience, admittedConnectionGenerationIds: undefined, recipientScope: undefined };
}

function defaultOptions(peerIds: readonly string[]): OwnReceiptServerOptions {
    return { peerIds, recordBackend: undefined, left: undefined };
}

function getSessionSocket(server: OwnReceiptServer, sessionId: string): SimulatedWebSocket {
    const socket = server.sockets[sessionId];
    if (socket === undefined) {
        throw new Error(`The server has no session ${sessionId}`);
    }
    return socket;
}

function copiesOf(sockets: Readonly<Record<string, SimulatedWebSocket>>, message: ALMessage): readonly number[] {
    return Object.values(sockets).map((socket) => countCopies(socket, message.id.msgId));
}

/** Enqueues the delta to `sessions` and runs the engine until each holds the copy its dequeue sent. */
async function publishDelta(server: OwnReceiptServer, clock: ReceiptClock, sessions: readonly string[]): Promise<ALMessage> {
    const delta = createDelta(clock);
    expect((await server.service.enqueueOutboxIfAbsent(delta, audience(sessions))).verdict.kind).toBe('admitted');
    await expect.poll(async () => {
        await server.engine.executeOnce();
        return sessions.map((sessionId) => countCopies(getSessionSocket(server, sessionId), delta.id.msgId));
    }).toEqual(sessions.map(() => 1));
    return delta;
}

function sessionNack(message: ALMessage, recipient: string, reason: ALNackReason): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: `nack-${message.id.msgId}-${recipient}-${reason}`, senderId: recipient, ts: Date.now(), traceId: message.id.traceId },
        {
            msgId: message.id.msgId,
            fromPeerId: recipient,
            toPeerId: RECEIPT_SERVER_PEER_ID,
            logicalRecipientPeerId: recipient,
            originPeerId: RECEIPT_SERVER_PEER_ID,
            reason,
            observedAtEpochMs: Date.now(),
            proof: null
        }
    );
}

/** The confirmations the record holds for the message, whatever its head expects. */
async function readConfirmations(server: OwnReceiptServer, message: ALMessage): Promise<readonly ALReceiptRecordConfirmation[]> {
    const prefix = toALReceiptRecordConfirmationPrefix(server.recordNamespace, toOwnReceiptRef(message));
    const keys = server.recordBackend.peekKeys().filter((key) => key.startsWith(prefix));
    const rows = await Promise.all(keys.map((key) => server.recordBackend.read(key, decodeALReceiptRecordConfirmation)));
    return rows.filter((row) => row !== undefined);
}

/** The record holds its first write, which is the dequeue's `open` when nothing else writes it first. */
function toHeldOnce(hold: WorkerHold): BackendWrapper {
    return (base) => holdALAdmissionWrite(base, hold);
}

/** The record's next write fails with a store error, not a conflict, once armed; the failure disarms it. */
function toFailingOnce(failing: { armed: boolean; }): BackendWrapper {
    return (base) =>
        createDelegatingALAdmissionWorkBackend(base, {
            write: async (operation, executionExpiresAtMs) => {
                if (failing.armed) {
                    failing.armed = false;
                    throw new Error('Receipt record store unavailable');
                }
                return await base.write(operation, executionExpiresAtMs);
            }
        });
}

/** Every write of the record fails with a store error, not a conflict, while armed. */
function toFailingWhileArmed(failing: { readonly armed: boolean; }): BackendWrapper {
    return (base) =>
        createDelegatingALAdmissionWorkBackend(base, {
            write: async (operation, executionExpiresAtMs) => {
                if (failing.armed) {
                    throw new Error('Receipt record store unavailable');
                }
                return await base.write(operation, executionExpiresAtMs);
            }
        });
}

/**
 * Publishes the delta to a, b and c while the record fails, so its dequeue opens no head, and steps the clock to each
 * retry the failure causes until the next one falls after the instant `runRowWindow` runs the row's window; then
 * disarms. Each retry dispatches the row again and moves that window.
 */
async function publishWithFailedOpens(
    server: OwnReceiptServer,
    clock: ReceiptClock,
    failing: { armed: boolean; }
): Promise<ALMessage> {
    const delta = createDelta(clock);
    await server.service.enqueueOutboxIfAbsent(delta, audience(['a', 'b', 'c']));
    failing.armed = true;
    for (let attempt = 1; attempt <= DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts; attempt += 1) {
        await settleDueWork(server, clock);
        const row = await readOutboxRow(server.outbox);
        const retryAtMs = row?.dequeueAudit.nextTs?.epochMilliseconds;
        const windowAtMs = (await server.store.readPendingAck(toOwnReceiptRef(delta)))?.deadlineAtMs;
        if (
            row === undefined || !NOT_COMPLETED_RETRYABLE_STATUSES.has(row.status) || retryAtMs === undefined || retryAtMs <= clock.nowMs ||
            windowAtMs === undefined
        ) {
            throw new Error('Assumed each failed dequeue leaves its row retryable later, beside the pending row it wrote');
        }
        if (retryAtMs > windowAtMs + 1) {
            failing.armed = false;
            expect((await server.record.read(toOwnReceiptRef(delta))).left).toEqual({ kind: 'head-absent' });
            return delta;
        }
        clock.nowMs = retryAtMs;
    }
    throw new Error('Assumed a failed dequeue\'s retry falls after the row\'s window within the work port\'s attempts');
}

/** Steps the clock just past the row's window, which falls before the dequeue's next retry, and runs what is due. */
async function runRowWindow(server: OwnReceiptServer, clock: ReceiptClock, message: ALMessage): Promise<void> {
    const windowAtMs = (await server.store.readPendingAck(toOwnReceiptRef(message)))?.deadlineAtMs;
    if (windowAtMs === undefined) {
        throw new Error('The publication has no pending row');
    }
    clock.nowMs = windowAtMs + 1;
    await settleDueWork(server, clock);
}

/** The publication's own WS_OUTBOX row, which the dequeue claims and retries. */
async function readOutboxRow(outbox: InMemoryQueueBox): Promise<ResourceEntry | undefined> {
    const rows = await Promise.all((await outbox.getAllKeys()).map((key) => outbox.getItem(key)));
    return rows.find((row) => row?.typeId === WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE);
}

/**
 * A cluster publication whose dequeue hook fails once, at the record's first write: the attempt publishes and the
 * failure propagates. The clock stands still, so the failed attempt's retry is not yet due.
 */
async function publishThroughFailedHook(clock: ReceiptClock): Promise<FailedHookPublication> {
    const failing = { armed: false };
    const cluster = await createOwnReceiptCluster(clock, { recordBackend: toFailingOnce(failing), bus: createBridgeBus() });
    const delta = createDelta(clock);
    await cluster.instance.service.enqueueOutboxIfAbsent(delta, audience(['a', 'b']));
    failing.armed = true;
    await expect.poll(async () => {
        await cluster.instance.engine.executeOnce();
        return copiesOf(cluster.sockets, delta);
    }).toEqual([1, 1]);
    return { cluster, delta, failing };
}

/** Runs the engine until no work row of the server or of its record is in flight or due by the clock. */
async function settleDueWork(server: OwnReceiptServer, clock: ReceiptClock): Promise<void> {
    await expect.poll(async () => {
        await server.engine.executeOnce();
        const rows = await Promise.all(
            [server.outbox, server.recordBackend.workQueue].map(async (queue) => await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key))))
        );
        return rows.flat().some((row) =>
            row !== undefined && NOT_COMPLETED_RETRYABLE_STATUSES.has(row.status) &&
            (row.status === EntityStatus.RESERVED || (row.dequeueAudit.nextTs?.epochMilliseconds ?? 0) <= clock.nowMs)
        );
    }).toBe(false);
}

/** Each poll steps the clock a little and runs the engine once, so the row's due work runs. */
function toRowEndedPoll(server: OwnReceiptServer, clock: ReceiptClock, message: ALMessage): RowEndedPoll {
    return {
        store: server.store,
        msgId: message.id.msgId,
        advance: async () => {
            clock.nowMs += 5;
            await server.engine.executeOnce();
        },
        timeoutMs: MEMORY_POLL_TIMEOUT_MS
    };
}

async function createOwnReceiptServer(receiptClock: ReceiptClock, options: OwnReceiptServerOptions): Promise<OwnReceiptServer> {
    const nowMs = () => receiptClock.nowMs;
    const outbox = createReceiptOutbox(receiptClock);
    const state = createInMemoryALAdmissionState(outbox);
    const clusterState = createReceiptClusterState(nowMs);
    const stores = createReceiptInstanceStores(clusterState, nowMs);
    const recorder = createRallarAlmReceiptDiagnosticsRecorder({ nowEpochMs: nowMs, capacity: 256 });
    const observations: WsQueueBoxServerReceiptObservation[] = [];
    const { left } = options;
    const keepAll = async ({ candidateSessionIds }: { readonly candidateSessionIds: readonly string[]; }) => candidateSessionIds;
    const server = await createReceiptServer({
        ...stores,
        receiptRecordStores: {
            ...stores.receiptRecordStores,
            backend: options.recordBackend?.(stores.receiptRecordStores.backend) ?? stores.receiptRecordStores.backend
        },
        inboundVolatileStores: undefined,
        outboundBackend: undefined,
        capturedRecipientEligibilityFilters: left === undefined ? undefined : {
            durable: async ({ candidateSessionIds }) => candidateSessionIds.filter((sessionId) => !left.has(sessionId)),
            local: keepAll,
            socket: keepAll
        },
        receiptObserver: (observation) => observations.push(observation),
        outbox,
        state,
        peerIds: options.peerIds,
        recorder,
        nowMs
    });
    const recordBackend = new InMemoryAdmissionBackend(clusterState.record, nowMs);
    return {
        ...server,
        outbox,
        recorder,
        observations,
        record: new ALReceiptRecord({ backend: recordBackend, namespace: stores.receiptRecordStores.namespace, nowMs }),
        recordBackend,
        recordNamespace: stores.receiptRecordStores.namespace,
        store: createDefaultInMemoryALOutboundRuntimeStores({
            nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: new InMemoryAdmissionBackend(state, nowMs)
        }).admissionStore
    };
}

/** One instance with a cluster publisher, so every copy of a publication goes out inside the dequeue hook. */
async function createOwnReceiptCluster(
    receiptClock: ReceiptClock,
    options: { readonly recordBackend: BackendWrapper; readonly bus: QueueBoxPubSubBridge; }
): Promise<OwnReceiptCluster> {
    const nowMs = () => receiptClock.nowMs;
    const clusterState = createReceiptClusterState(nowMs);
    const stores = createReceiptInstanceStores(clusterState, nowMs);
    const outbox = createReceiptOutbox(receiptClock);
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        nowMs,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        outboundBackend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), nowMs)
    });
    const instance = await createClusterInstance({
        name: RECEIPT_SERVER_PEER_ID,
        outboundStores,
        inboundStores: stores.inboundStores,
        inboundVolatileStores: undefined,
        receiptRecordStores: { ...stores.receiptRecordStores, backend: options.recordBackend(stores.receiptRecordStores.backend) },
        receiptObserver: undefined,
        roomView: { inSync: true },
        bus: options.bus,
        publisherId: 'local',
        engine: new InboxOutboxEngine(),
        roomPeerIds: ['a', 'b']
    });
    const recordBackend = new InMemoryAdmissionBackend(clusterState.record, nowMs);
    return {
        instance,
        outbox,
        sockets: { a: await connect(instance, 'a'), b: await connect(instance, 'b') },
        record: new ALReceiptRecord({ backend: recordBackend, namespace: stores.receiptRecordStores.namespace, nowMs }),
        recordBackend,
        recordNamespace: stores.receiptRecordStores.namespace,
        store: outboundStores.admissionStore
    };
}
