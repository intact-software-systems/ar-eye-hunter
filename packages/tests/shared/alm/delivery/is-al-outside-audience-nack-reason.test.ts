import { describe, expect, it } from 'vitest';

import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { isALOutsideAudienceNackReason } from '@shared/alm/delivery/is-al-outside-audience-nack-reason.ts';

/** Every NACK reason, keyed so a new reason fails to compile here until it states whether it speaks for the audience. */
const OUTSIDE_AUDIENCE_BY_REASON = {
    duplicate: false,
    gap: false,
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

describe('a NACK that places one recipient outside the audience', () => {
    it.each(Object.entries(OUTSIDE_AUDIENCE_BY_REASON))('reads %s as outside the audience: %s', (reason, outside) => {
        expect(isALOutsideAudienceNackReason(reason as ALNackReason)).toBe(outside);
    });
});
