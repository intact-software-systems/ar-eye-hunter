import type { ALStoreDurability } from '../al-runtime-stores.ts';
import { computeALReceiptRetentionExpiryMs } from './compute-al-receipt-retention-expiry-ms.ts';

export function computeALVolatileControlRowExpiryMs(
    expireAtTimestamp: number,
    durability: ALStoreDurability,
    deadlineAtMs: number | undefined
): number {
    if (durability !== 'volatile' || deadlineAtMs === undefined) {
        return expireAtTimestamp;
    }
    return Math.min(expireAtTimestamp, computeALReceiptRetentionExpiryMs(deadlineAtMs));
}
