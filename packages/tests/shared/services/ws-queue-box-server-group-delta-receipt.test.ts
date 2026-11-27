import { describe, expect, it } from 'vitest';

import {
    createRallarAlmReceiptDiagnosticsRecorder,
    type RallarAlmReceiptDiagnosticsRecorder
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries
} from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState } from '@shared/alm/al-admission-backend.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';

import {
    createClientEventStateSync,
    createGroupDeltaStateSync,
    STATE_SYNC_FIXTURE_SESSION_IDS
} from '../../shared-server/rallar-system/state-sync/create-state-sync-effect-fixture.ts';
import {
    countCopies,
    createReceiptClusterState,
    createReceiptInstanceStores,
    createReceiptOutbox,
    createReceiptServer,
    installClock,
    RECEIPT_SERVER_PEER_ID,
    sessionAck,
    type ReceiptClock,
    type ReceiptServerInstance
} from './ws-queue-box-server-receipt-fixture.ts';

const DELTA_TRACE_ID = 'trace-delta-1';
const CLOCK_STEP_MS = 1_000;

describe('receipts of the group-state deltas the server publishes', () => {
    it('records the delta\'s trace on the receipt it ends, naming the session that acknowledged it and the one that never did', async () => {
        // Pins the admin read losing the delta's trace, or stating the row's own exhaustion: the receipt is counted in
        // the record, and the admin read learns it when the record's terminal receipt settles the row.
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
            admittedConnectionGenerationIds: undefined,
            recipientScope: undefined
        });

        expect(enqueued.verdict.kind).toBe('admitted');
        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [countCopies(local.sockets.a, delta.id.msgId), countCopies(local.sockets.b, delta.id.msgId)];
        }).toEqual([1, 1]);

        const acknowledgedAtEpochMs = clock.nowMs;
        await local.service.acceptIncomingMessage(sessionAck(delta, 'a', 'delivered'), 'a');
        expect((await local.record.read({ originPeerId: RECEIPT_SERVER_PEER_ID, msgId: delta.id.msgId })).right?.tally.confirmedRecipientPeerIds)
            .toEqual(['a']);
        expect(recorder.readDiagnostics().messages).toEqual([]);

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.lastSettlementKind;
        }, { timeout: 5_000 }).toBe('acknowledgement');
        expect(recorder.readDiagnostics().messages).toEqual([{
            msgId: delta.id.msgId,
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'acknowledgement',
            receiptExhausted: false,
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
            admittedConnectionGenerationIds: undefined,
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

/** The server, and the test's own reader of the receipt record it counts in. */
interface DeltaServer extends ReceiptServerInstance {
    readonly record: ALReceiptRecord;
}

async function createDeltaServer(
    clock: ReceiptClock,
    recorder: RallarAlmReceiptDiagnosticsRecorder
): Promise<DeltaServer> {
    const outbox = createReceiptOutbox(clock);
    const nowMs = () => clock.nowMs;
    const stores = createReceiptInstanceStores(createReceiptClusterState(nowMs), nowMs);
    const server = await createReceiptServer({
        ...stores,
        inboundVolatileStores: undefined,
        outboundBackend: undefined,
        capturedRecipientEligibilityFilters: undefined,
        receiptObserver: undefined,
        outbox,
        state: createInMemoryALAdmissionState(outbox),
        peerIds: STATE_SYNC_FIXTURE_SESSION_IDS,
        recorder,
        nowMs
    });
    return { ...server, record: new ALReceiptRecord({ ...stores.receiptRecordStores, nowMs }) };
}
