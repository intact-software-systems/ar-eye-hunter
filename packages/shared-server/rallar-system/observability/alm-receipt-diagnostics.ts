import type {
    ALDeliverySettlement,
    ALDeliverySettlementSink
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    AdminOperationsAlmReceiptDiagnostics,
    AdminOperationsAlmReceiptEntry
} from '@shared/api/admin-operations-types.ts';

/** The most messages the recorder lists: the AL collection limit, so a room-sized burst stays visible (C10). */
export const RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY = 256;

export interface CreateRallarAlmReceiptDiagnosticsRecorderInput {
    readonly nowEpochMs: () => number;
    readonly capacity: number;
}

/** The WS server's settlement sink (D58, D61): per message, who confirmed its receipt; in memory, per process. */
export interface RallarAlmReceiptDiagnosticsRecorder {
    readonly settlements: ALDeliverySettlementSink;
    readonly readDiagnostics: () => AdminOperationsAlmReceiptDiagnostics;
}

export function createRallarAlmReceiptDiagnosticsRecorder(
    input: CreateRallarAlmReceiptDiagnosticsRecorderInput
): RallarAlmReceiptDiagnosticsRecorder {
    const entries = new Map<string, AdminOperationsAlmReceiptEntry>();
    return {
        settlements: (settlement) => {
            const next = toRallarAlmReceiptEntry(
                entries.get(settlement.msgId),
                settlement,
                input.nowEpochMs()
            );
            if (next !== undefined) {
                setBoundedEntry(entries, next, input.capacity);
            }
        },
        readDiagnostics: () => ({ capacity: input.capacity, messages: [...entries.values()] })
    };
}

/** A receipt fact opens or refreshes the message's entry; any other settlement only moves its last kind. */
export function toRallarAlmReceiptEntry(
    current: AdminOperationsAlmReceiptEntry | undefined,
    settlement: ALDeliverySettlement,
    nowEpochMs: number
): AdminOperationsAlmReceiptEntry | undefined {
    switch (settlement.kind) {
        case 'acknowledgement':
            return {
                msgId: settlement.msgId,
                mode: settlement.mode,
                confirmedPeerIds: settlement.confirmedRecipientPeerIds,
                unconfirmedPeerIds: settlement.unconfirmedRecipientPeerIds,
                lastSettlementKind: settlement.kind,
                receiptExhausted: current?.receiptExhausted ?? false,
                updatedAtEpochMs: nowEpochMs
            };
        case 'receipt-exhausted':
            return {
                msgId: settlement.msgId,
                mode: settlement.mode,
                confirmedPeerIds: settlement.confirmedPeerIds,
                unconfirmedPeerIds: settlement.unconfirmedPeerIds,
                lastSettlementKind: settlement.kind,
                receiptExhausted: true,
                updatedAtEpochMs: nowEpochMs
            };
        default:
            return current === undefined
                ? undefined
                : { ...current, lastSettlementKind: settlement.kind, updatedAtEpochMs: nowEpochMs };
    }
}

/** The least recently updated entry leaves first. */
function setBoundedEntry(
    entries: Map<string, AdminOperationsAlmReceiptEntry>,
    entry: AdminOperationsAlmReceiptEntry,
    capacity: number
): void {
    entries.delete(entry.msgId);
    entries.set(entry.msgId, entry);
    for (const msgId of entries.keys()) {
        if (entries.size <= capacity) {
            return;
        }
        entries.delete(msgId);
    }
}
