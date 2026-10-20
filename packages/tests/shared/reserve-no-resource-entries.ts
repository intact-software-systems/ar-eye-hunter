import type {
    ResourceInboxReservationObservationRequest,
    ResourceInboxReservationObservationResult,
    ResourceInboxReservationRequest
} from '@shared/queuebox/queue-box-types.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

/** An empty queue port preserves both return contracts without manufacturing observed work. */
export function reserveNoResourceEntries(request: ResourceInboxReservationObservationRequest): Promise<ResourceInboxReservationObservationResult>;
export function reserveNoResourceEntries(request: ResourceInboxReservationRequest): Promise<Map<Key, ResourceEntry>>;
export async function reserveNoResourceEntries(
    request: ResourceInboxReservationRequest | ResourceInboxReservationObservationRequest
): Promise<Map<Key, ResourceEntry> | ResourceInboxReservationObservationResult> {
    return 'reservationObservation' in request ? { entries: new Map(), observations: [] } : new Map();
}
