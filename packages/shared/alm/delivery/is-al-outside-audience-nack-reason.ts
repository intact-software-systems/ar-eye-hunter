import type { ALNackReason } from '../../al-contracts/al-control.ts';

/** The NACK reasons that speak for one recipient and place it outside the message's audience. */
export type ALOutsideAudienceNackReason = Extract<ALNackReason, 'not-subscribed' | 'before-entry'>;

/**
 * A NACK that speaks for one recipient and places it outside the message's audience: `not-subscribed`, or
 * `before-entry` for a copy below the position the recipient entered the track at. It never ends a receipt.
 */
export function isALOutsideAudienceNackReason(reason: ALNackReason): reason is ALOutsideAudienceNackReason {
    return reason === 'not-subscribed' || reason === 'before-entry';
}
