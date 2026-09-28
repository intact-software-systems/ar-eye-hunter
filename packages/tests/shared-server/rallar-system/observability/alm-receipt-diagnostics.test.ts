import { describe, expect, it } from 'vitest';

import {
    createRallarAlmReceiptDiagnosticsRecorder,
    RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;

describe('the WS server settlement recorder (D58, D61, C10)', () => {
    it('opens an entry on the first receipt fact and keeps who confirmed and who did not', () => {
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => NOW_EPOCH_MS,
            capacity: 4
        });

        recorder.settlements(attemptSettled('snapshot-1'));
        recorder.settlements(acknowledgement('snapshot-1', ['a'], ['b']));

        expect(recorder.readDiagnostics()).toEqual({
            capacity: 4,
            messages: [{
                msgId: 'snapshot-1',
                mode: 'receiver',
                confirmedPeerIds: ['a'],
                unconfirmedPeerIds: ['b'],
                lastSettlementKind: 'acknowledgement',
                receiptExhausted: false,
                updatedAtEpochMs: NOW_EPOCH_MS
            }]
        });
    });

    it('marks an exhausted receipt and moves only the last kind on a later settlement', () => {
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => NOW_EPOCH_MS,
            capacity: 4
        });
        recorder.settlements(acknowledgement('snapshot-1', ['a'], ['b']));

        recorder.settlements({
            kind: 'receipt-exhausted',
            msgId: 'snapshot-1',
            carrier: 'ws',
            atMs: NOW_EPOCH_MS,
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            detail: 'The receipt ran out of retries after 3 of 3.'
        });
        recorder.settlements(attemptSettled('snapshot-1'));

        expect(recorder.readDiagnostics().messages).toEqual([expect.objectContaining({
            msgId: 'snapshot-1',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            receiptExhausted: true,
            lastSettlementKind: 'attempt-settled'
        })]);
    });

    it('keeps the capacity by evicting the least recently updated entry', () => {
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => NOW_EPOCH_MS,
            capacity: 2
        });

        recorder.settlements(acknowledgement('first', ['a'], []));
        recorder.settlements(acknowledgement('second', ['a'], []));
        recorder.settlements(acknowledgement('first', ['a', 'b'], []));
        recorder.settlements(acknowledgement('third', ['a'], []));

        expect(recorder.readDiagnostics().messages.map((entry) => entry.msgId)).toEqual([
            'first',
            'third'
        ]);
        expect(RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY).toBe(256);
    });

    it('lists the 256 most recently updated messages and lets the 257th evict the oldest (C10)', () => {
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => NOW_EPOCH_MS,
            capacity: RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY
        });

        for (let index = 1; index <= RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY + 1; index += 1) {
            recorder.settlements(acknowledgement(`message-${index}`, ['a'], []));
        }

        const msgIds = recorder.readDiagnostics().messages.map((entry) => entry.msgId);
        expect(msgIds).toHaveLength(RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY);
        expect(msgIds[0]).toBe('message-2');
        expect(msgIds.at(-1)).toBe('message-257');
    });

    it('lists no message whose settlements carried no receipt fact yet', () => {
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => NOW_EPOCH_MS,
            capacity: 4
        });

        recorder.settlements(attemptSettled('snapshot-1'));

        expect(recorder.readDiagnostics()).toEqual({ capacity: 4, messages: [] });
    });
});

function acknowledgement(
    msgId: string,
    confirmed: readonly string[],
    unconfirmed: readonly string[]
): ALDeliverySettlement {
    return {
        kind: 'acknowledgement',
        msgId,
        carrier: 'ws',
        atMs: NOW_EPOCH_MS,
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: [...confirmed, ...unconfirmed],
        confirmedRecipientPeerIds: confirmed,
        unconfirmedRecipientPeerIds: unconfirmed,
        complete: unconfirmed.length === 0
    };
}

function attemptSettled(msgId: string): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId,
        carrier: 'ws',
        atMs: NOW_EPOCH_MS,
        attemptId: 'attempt-1',
        outcome: 'sent',
        submissionAttempted: true,
        detail: undefined,
        willRetry: false
    };
}
