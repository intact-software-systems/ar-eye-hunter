import { describe, expect, it } from 'vitest';

import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import { computeALVolatileControlRowExpiryMs } from '@shared/alm/delivery/compute-al-volatile-control-row-expiry-ms.ts';

const DEADLINE_AT_MS = 1_000_000;
const TTL_EXPIRY_MS = DEADLINE_AT_MS + 30 * 60_000;

describe('computeALVolatileControlRowExpiryMs (D74)', () => {
    it('stops a volatile control row at the message deadline plus the receipt grace', () => {
        expect(computeALVolatileControlRowExpiryMs(TTL_EXPIRY_MS, 'volatile', DEADLINE_AT_MS)).toBe(
            DEADLINE_AT_MS + AL_RECEIPT_DEADLINE_GRACE_MS
        );
    });

    it('keeps a volatile pending receipt at its own earlier deadline', () => {
        expect(computeALVolatileControlRowExpiryMs(DEADLINE_AT_MS, 'volatile', DEADLINE_AT_MS)).toBe(DEADLINE_AT_MS);
    });

    it('keeps a durable control row, and one whose message the store no longer holds, at its TTL', () => {
        expect(computeALVolatileControlRowExpiryMs(TTL_EXPIRY_MS, 'durable', DEADLINE_AT_MS)).toBe(TTL_EXPIRY_MS);
        expect(computeALVolatileControlRowExpiryMs(TTL_EXPIRY_MS, 'volatile', undefined)).toBe(TTL_EXPIRY_MS);
    });
});
