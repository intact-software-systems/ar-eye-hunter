import { describe, expect, it } from 'vitest';

import { computeALReceiptRetentionExpiryMs } from '@shared/alm/delivery/compute-al-receipt-retention-expiry-ms.ts';

describe('computeALReceiptRetentionExpiryMs (D74)', () => {
    it('keeps a row for the message deadline plus the 30 s receipt grace', () => {
        expect(computeALReceiptRetentionExpiryMs(1_800_000_000_000)).toBe(1_800_000_030_000);
    });
});
