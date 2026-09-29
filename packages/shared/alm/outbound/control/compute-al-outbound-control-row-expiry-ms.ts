import type { ALStoreDurability } from '../../al-runtime-stores.ts';
import { resolveALReceiptRetentionExpiryMs } from '../../delivery/resolve-al-receipt-retention-expiry-ms.ts';

/**
 * The volatile pair keeps a message's control rows no longer than its deadline plus the receipt grace (D74):
 * past it the owner row is gone and no control reads them. A pending receipt still ends at the deadline.
 */
export function computeALOutboundControlRowExpiryMs(
    expireAtTimestamp: number,
    durability: ALStoreDurability,
    deadlineAtMs: number | undefined
): number {
    if (durability !== 'volatile' || deadlineAtMs === undefined) {
        return expireAtTimestamp;
    }
    return Math.min(expireAtTimestamp, resolveALReceiptRetentionExpiryMs(deadlineAtMs));
}
