import { describe, expect, it } from 'vitest';

import {
    createRallarAlmReceiptDiagnosticsRecorder,
    type RallarAlmReceiptDiagnosticsRecorder
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries
} from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState } from '@shared/alm/al-admission-backend.ts';

import {
    createClientEventStateSync,
    createGroupDeltaStateSync,
    STATE_SYNC_FIXTURE_SESSION_IDS
} from '../../shared-server/rallar-system/state-sync/create-state-sync-effect-fixture.ts';
import {
    countCopies,
    createReceiptOutbox,
    createReceiptServer,
    installClock,
    RECEIPT_SERVER_PEER_ID,
    type ReceiptClock,
    type ReceiptServerInstance
} from './ws-queue-box-server-receipt-fixture.ts';

const DELTA_TRACE_ID = 'trace-delta-1';
const CLOCK_STEP_MS = 1_000;

describe('receipts of the group-state deltas the server publishes', () => {
    it('records the delta\'s trace on the session that acknowledged it, then on the receipt the rest never gave', async () => {
        const clock = installClock();
        const recorder = createReceiptRecorder(clock);
        const local = await createDeltaServer(clock, recorder);
        const [entry] = computeGroupStateSyncEntries(
            createGroupDeltaStateSync({ nowMs: clock.nowMs, traceId: DELTA_TRACE_ID }),
            RECEIPT_SERVER_PEER_ID
        );
        if (entry === undefined) {
            throw new Error('Expected one group-state delta entry');
        }
        const delta = decodePersistedALMessage(entry.resource);

        const enqueued = await local.service.enqueueOutboxIfAbsent(delta, {
            admittedAudience: STATE_SYNC_FIXTURE_SESSION_IDS,
            recipientScope: undefined
        });

        expect(enqueued.verdict.kind).toBe('admitted');
        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [countCopies(local.sockets.a, delta.id.msgId), countCopies(local.sockets.b, delta.id.msgId)];
        }).toEqual([1, 1]);

        const acknowledgedAtEpochMs = clock.nowMs;
        await local.service.acceptIncomingMessage(sessionAck(delta, 'a'), 'a');
        expect(recorder.readDiagnostics().messages).toEqual([{
            msgId: delta.id.msgId,
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'acknowledgement',
            receiptExhausted: false,
            traceId: DELTA_TRACE_ID,
            updatedAtEpochMs: acknowledgedAtEpochMs
        }]);

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.receiptExhausted;
        }, { timeout: 5_000 }).toBe(true);
        expect(recorder.readDiagnostics().messages).toEqual([{
            msgId: delta.id.msgId,
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'receipt-exhausted',
            receiptExhausted: true,
            traceId: DELTA_TRACE_ID,
            updatedAtEpochMs: expect.any(Number)
        }]);
        expect(recorder.readDiagnostics().messages[0]?.updatedAtEpochMs).toBeGreaterThan(acknowledgedAtEpochMs);
    });

    it('records nothing for a client-state event, which asks no receipt', async () => {
        const clock = installClock();
        const recorder = createReceiptRecorder(clock);
        const local = await createDeltaServer(clock, recorder);
        const [clientEvent] = computeClientStateSyncEntries(
            createClientEventStateSync({ nowMs: clock.nowMs, traceId: 'trace-client-event-1' }),
            RECEIPT_SERVER_PEER_ID
        );
        if (clientEvent === undefined) {
            throw new Error('Expected one client-state event entry');
        }

        await local.service.enqueueOutboxIfAbsent(clientEvent.message, {
            admittedAudience: STATE_SYNC_FIXTURE_SESSION_IDS,
            recipientScope: undefined
        });
        for (let step = 0; step < 10; step += 1) {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
        }

        expect(countCopies(local.sockets.a, clientEvent.message.id.msgId)).toBe(1);
        expect(recorder.readDiagnostics().messages).toEqual([]);
    });
});

function createReceiptRecorder(clock: ReceiptClock): RallarAlmReceiptDiagnosticsRecorder {
    return createRallarAlmReceiptDiagnosticsRecorder({ nowEpochMs: () => clock.nowMs, capacity: 256 });
}

async function createDeltaServer(
    clock: ReceiptClock,
    recorder: RallarAlmReceiptDiagnosticsRecorder
): Promise<ReceiptServerInstance> {
    const outbox = createReceiptOutbox(clock);
    return await createReceiptServer({
        outbox,
        state: createInMemoryALAdmissionState(outbox),
        peerIds: STATE_SYNC_FIXTURE_SESSION_IDS,
        recorder,
        nowMs: () => clock.nowMs
    });
}

/** The browser addresses its ACK to the delta's sender and stamps it with the delta's trace. */
function sessionAck(delta: ALMessage, recipient: string): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${delta.id.msgId}-${recipient}`, senderId: recipient, ts: Date.now(), traceId: delta.id.traceId },
        {
            ackedMsgId: delta.id.msgId,
            fromPeerId: recipient,
            toPeerId: delta.id.senderId,
            originPeerId: delta.id.senderId,
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}
