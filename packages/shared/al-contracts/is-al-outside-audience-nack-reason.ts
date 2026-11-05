import type { ALNackReason } from './al-control.ts';

/**
 * A NACK that speaks for one recipient and places it outside the message's audience: `not-subscribed`, or
 * `before-entry` for a copy below the position the recipient entered the track at. It never ends a receipt.
 */
export function isALOutsideAudienceNackReason(reason: ALNackReason): boolean {
    return reason === 'not-subscribed' || reason === 'before-entry';
}
