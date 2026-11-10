import { describe, expect, it } from 'vitest';

import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { isALRelayedNackReason } from '@shared/alm/delivery/is-al-relayed-nack-reason.ts';

/** Every NACK reason, keyed so a new reason fails to compile here until it states whether a relay forwards it. */
const RELAYED_BY_REASON = {
    duplicate: false,
    gap: true,
    'resync-required': false,
    expired: false,
    unauthorized: false,
    'no-route': false,
    overloaded: false,
    stale: false,
    'not-yet-in-sync': false,
    'membership-fenced': false,
    'no-leader': false,
    'held-by-other': false,
    unsupported: false,
    'no-publish-grant': false,
    'not-subscribed': true,
    'before-entry': true
} satisfies Record<ALNackReason, boolean>;

describe('a NACK a relay forwards toward the origin for the recipient it names', () => {
    it.each(Object.entries(RELAYED_BY_REASON))('reads %s as relayed: %s', (reason, relayed) => {
        expect(isALRelayedNackReason(reason as ALNackReason)).toBe(relayed);
    });
});
