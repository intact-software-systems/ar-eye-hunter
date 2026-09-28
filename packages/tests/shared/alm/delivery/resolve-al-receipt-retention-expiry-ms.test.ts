import { describe, expect, it } from 'vitest';

import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import { resolveALReceiptRetentionExpiryMs } from '@shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts';

describe('resolveALReceiptRetentionExpiryMs (D74)', () => {
    it('keeps a row for the message deadline plus the 30 s receipt grace', () => {
        expect(resolveALReceiptRetentionExpiryMs(1_800_000_000_000)).toBe(1_800_000_030_000);
    });

    it('is the window a receipt about the message is still admitted in', () => {
        const deadlineAtMs = 1_000;

        expect(resolveALReceiptRetentionExpiryMs(deadlineAtMs) - deadlineAtMs).toBe(
            AL_RECEIPT_DEADLINE_GRACE_MS
        );
    });
});
