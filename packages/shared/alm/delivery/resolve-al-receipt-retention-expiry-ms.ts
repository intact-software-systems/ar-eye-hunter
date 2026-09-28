import { AL_RECEIPT_DEADLINE_GRACE_MS } from '../../al-contracts/al-control.ts';

/**
 * How long a row that answers a message's receipts outlives the message: its deadline plus the receipt grace, the
 * window in which a receipt or a late control about it is still admitted (D74). The volatile pair keeps its message
 * rows exactly this long, and the origin's receipt row already did.
 */
export function resolveALReceiptRetentionExpiryMs(deadlineAtMs: number): number {
    return deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS;
}
