import type { ALNackReason } from '../../al-contracts/al-control.ts';
import {
    isALOutsideAudienceNackReason,
    type ALOutsideAudienceNackReason
} from './is-al-outside-audience-nack-reason.ts';

/** The NACK reasons a relay re-originates toward the origin for the recipient a child's NACK names. */
export type ALRelayedNackReason = ALOutsideAudienceNackReason | 'gap';

/**
 * A NACK a relay re-originates toward the origin, naming the same recipient: an outside-audience NACK, or a `gap`
 * NACK, which asks the origin to repair that recipient through the relay and changes nothing at the relay.
 */
export function isALRelayedNackReason(reason: ALNackReason): reason is ALRelayedNackReason {
    return isALOutsideAudienceNackReason(reason) || reason === 'gap';
}
