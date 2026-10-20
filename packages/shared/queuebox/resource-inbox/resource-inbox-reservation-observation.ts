import {
    isKeysEqual,
    type Key,
    type ResourceEntry
} from '../ResourceEntry.ts';

/** Invocation-local evidence; key and attempt are not globally unique across not-ready redelivery. */
export type ResourceInboxReservationObservation =
    | {
        readonly key: Key;
        readonly reservationAttempt: number;
        readonly availability: 'available';
        readonly boundary: 'postgres-update-returning';
        readonly association: 'physical-key-and-reservation-attempt';
        readonly previousPersistedRetryDelayUs: number;
        readonly dueToReservationObservationUs: number;
    }
    | {
        readonly key: Key;
        readonly reservationAttempt: number;
        readonly availability: 'unavailable';
        readonly boundary: 'unavailable';
        readonly association: 'unavailable';
        readonly reason:
            | 'unsupported-backend'
            | 'observed-claim-not-captured'
            | 'not-applicable'
            | 'invalid-observation';
    };

export function toUnavailableReservationObservation(
    entry: ResourceEntry,
    reason: Extract<ResourceInboxReservationObservation, { availability: 'unavailable'; }>['reason']
): ResourceInboxReservationObservation {
    return {
        key: entry.key,
        reservationAttempt: entry.dequeueAudit.attempts,
        availability: 'unavailable',
        boundary: 'unavailable',
        association: 'unavailable',
        reason
    };
}

/** Optional diagnostics cannot prevent handling a successfully claimed row. */
export function resolveResourceInboxReservationObservation(
    entry: ResourceEntry,
    observations: readonly ResourceInboxReservationObservation[],
    maximumObservations: number = Number.MAX_SAFE_INTEGER
): ResourceInboxReservationObservation {
    try {
        if (!Array.isArray(observations) || observations.length > maximumObservations) {
            return toUnavailableReservationObservation(entry, 'invalid-observation');
        }
        const matches = observations.filter((observation) =>
            isKeysEqual(entry.key, observation.key) && observation.reservationAttempt === entry.dequeueAudit.attempts
        );
        if (matches.length === 1 && validateResourceInboxReservationObservation(matches[0]).length === 0) {
            return matches[0];
        }
    }
    catch {
        // A malformed diagnostic port result invalidates evidence, never the claimed work.
    }
    return toUnavailableReservationObservation(entry, 'invalid-observation');
}

export function validateResourceInboxReservationObservation(
    observation: ResourceInboxReservationObservation
): readonly string[] {
    const identityValid = observation.key !== null && typeof observation.key === 'object' &&
        typeof observation.key.topicId === 'string' && typeof observation.key.resourceId === 'string' &&
        typeof observation.key.contextId === 'string' &&
        Number.isSafeInteger(observation.reservationAttempt) && observation.reservationAttempt > 0;
    const measurementValid = observation.availability === 'available'
        ? observation.boundary === 'postgres-update-returning' &&
            observation.association === 'physical-key-and-reservation-attempt' &&
            Number.isSafeInteger(observation.previousPersistedRetryDelayUs) &&
            Number.isSafeInteger(observation.dueToReservationObservationUs)
        : observation.availability === 'unavailable' && observation.boundary === 'unavailable' &&
            observation.association === 'unavailable' &&
            ['unsupported-backend', 'observed-claim-not-captured', 'not-applicable', 'invalid-observation'].includes(
                observation.reason
            );
    return identityValid && measurementValid ? [] : ['Invalid reservation observation'];
}
