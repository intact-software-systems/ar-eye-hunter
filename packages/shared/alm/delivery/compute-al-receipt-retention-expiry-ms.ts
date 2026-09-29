import { AL_RECEIPT_DEADLINE_GRACE_MS } from '../../al-contracts/al-control.ts';

export function computeALReceiptRetentionExpiryMs(deadlineAtMs: number): number {
    return deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS;
}
