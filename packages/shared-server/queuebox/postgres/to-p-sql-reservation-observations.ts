import {
    toUnavailableReservationObservation,
    type ResourceInboxReservationObservation
} from '@shared/queuebox/resource-inbox/resource-inbox-reservation-observation.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export interface PSqlReservationObservationRow {
    readonly entry: ResourceEntry;
    readonly selectedStatus: string;
    readonly selectedEndTs: string | null;
    readonly selectedNextTs: string | null;
    readonly previousPersistedRetryDelayUs: unknown;
    readonly dueToReservationObservationUs: unknown;
}

/** Decode only after the transaction returns. SQL numeric text avoids bigint overflow and endpoint rounding. */
export function toPSqlReservationObservations(
    rows: readonly PSqlReservationObservationRow[]
): readonly ResourceInboxReservationObservation[] {
    return rows.map((row) => {
        try {
            if (row.selectedStatus !== 'RETRY') {
                return toUnavailableReservationObservation(row.entry, 'not-applicable');
            }
            const previousPersistedRetryDelayUs = toSignedSafeMicroseconds(row.previousPersistedRetryDelayUs);
            const dueToReservationObservationUs = toSignedSafeMicroseconds(row.dueToReservationObservationUs);
            if (previousPersistedRetryDelayUs !== undefined && dueToReservationObservationUs !== undefined) {
                return {
                    key: row.entry.key,
                    reservationAttempt: row.entry.dequeueAudit.attempts,
                    availability: 'available',
                    boundary: 'postgres-update-returning',
                    association: 'physical-key-and-reservation-attempt',
                    previousPersistedRetryDelayUs,
                    dueToReservationObservationUs
                };
            }
        }
        catch {
            // Diagnostic corruption is distinct from the authoritative row validation inside the transaction.
        }
        return toUnavailableReservationObservation(row.entry, 'invalid-observation');
    });
}

function toSignedSafeMicroseconds(value: unknown): number | undefined {
    if (typeof value !== 'string' || !/^-?\d{1,16}$/u.test(value)) {
        return undefined;
    }
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : undefined;
}
