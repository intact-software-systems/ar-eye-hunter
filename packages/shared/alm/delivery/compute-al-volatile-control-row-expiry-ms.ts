import type { ALStoreDurability } from '../al-runtime-stores.ts';
import { computeALReceiptRetentionExpiryMs } from './compute-al-receipt-retention-expiry-ms.ts';

/** A memory pair's control rows, volatile or checkpointed, stop at the message deadline plus the receipt grace. */
export function computeALVolatileControlRowExpiryMs(
    expireAtTimestamp: number,
    durability: ALStoreDurability,
    deadlineAtMs: number | undefined
): number {
    switch (durability) {
        case 'volatile':
        case 'checkpoint':
            return deadlineAtMs === undefined
                ? expireAtTimestamp
                : Math.min(expireAtTimestamp, computeALReceiptRetentionExpiryMs(deadlineAtMs));
        case 'durable':
            return expireAtTimestamp;
    }
}
