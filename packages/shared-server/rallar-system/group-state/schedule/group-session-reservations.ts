import {
    requireExactKeys,
    requirePositiveInteger,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import { toGroupSessionTiming, type GroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';

/** Private account intent, never included in group snapshots or public events. */
export interface GroupSessionReservations {
    readonly scheduleRevision: number;
    readonly principalIds: readonly string[];
}

export interface GroupSessionSeatCountInput {
    readonly schedule: GroupSessionSchedule;
    readonly reservations: GroupSessionReservations;
    readonly activePlayerPrincipalIds: readonly string[];
    readonly nowEpochMs: number;
}

export interface GroupSessionReservationInput extends GroupSessionSeatCountInput {
    readonly action: 'reserve' | 'withdraw';
    readonly principalId: string;
    readonly expectedScheduleRevision: number;
    readonly maxPlayers: number;
}

export type GroupSessionReservationResult =
    | Readonly<{ outcome: 'accepted'; reservations: GroupSessionReservations; }>
    | Readonly<{
        outcome: 'denied';
        reason: 'full' | 'schedule-changed' | 'cancelled' | 'reservations-expired';
    }>;

export function decodeGroupSessionReservations(value: unknown): GroupSessionReservations {
    const reservations = requireRecord(value, 'Session reservations');
    requireExactKeys(reservations, ['scheduleRevision', 'principalIds'], 'Session reservations');
    requirePositiveInteger(reservations.scheduleRevision, 'Reservation schedule revision');
    if (!Array.isArray(reservations.principalIds) || reservations.principalIds.length > 64) {
        throw new TypeError('Session reservations must contain at most 64 accounts');
    }
    const principalIds = reservations.principalIds.map((principalId: unknown) => {
        requireString(principalId, 'Reserved principal');
        return principalId;
    });
    if (new Set(principalIds).size !== principalIds.length) {
        throw new TypeError('Session reservations must contain each account once');
    }
    return { scheduleRevision: reservations.scheduleRevision as number, principalIds };
}

export function countGroupSessionOccupiedSeats(reservation: GroupSessionSeatCountInput): number {
    const reservations = requireCurrentReservations(reservation);
    const phase = toGroupSessionTiming(reservation.schedule, reservation.nowEpochMs).phase;
    const activePlayers = new Set(reservation.activePlayerPrincipalIds);
    if (phase !== 'cancelled' && phase !== 'reservations-expired') {
        for (const principalId of reservations.principalIds) {
            activePlayers.add(principalId);
        }
    }
    return activePlayers.size;
}

export function computeGroupSessionReservation(
    reservation: GroupSessionReservationInput
): GroupSessionReservationResult {
    const reservations = requireCurrentReservations(reservation);
    requireString(reservation.principalId, 'Reserving principal');
    requirePositiveInteger(reservation.expectedScheduleRevision, 'Expected schedule revision');
    requirePositiveInteger(reservation.maxPlayers, 'Scheduled player capacity');
    if (reservation.maxPlayers > 64) {
        throw new TypeError('Scheduled player capacity must be at most 64');
    }
    const phase = toGroupSessionTiming(reservation.schedule, reservation.nowEpochMs).phase;
    if (reservation.expectedScheduleRevision !== reservation.schedule.revision) {
        return { outcome: 'denied', reason: 'schedule-changed' };
    }
    if (reservation.action === 'withdraw') {
        return {
            outcome: 'accepted',
            reservations: {
                ...reservations,
                principalIds: reservations.principalIds.filter((principalId) => principalId !== reservation.principalId)
            }
        };
    }
    if (phase === 'cancelled' || phase === 'reservations-expired') {
        return { outcome: 'denied', reason: phase };
    }
    if (
        reservations.principalIds.includes(reservation.principalId) ||
        reservation.activePlayerPrincipalIds.includes(reservation.principalId)
    ) {
        return { outcome: 'accepted', reservations };
    }
    if (countGroupSessionOccupiedSeats(reservation) >= reservation.maxPlayers) {
        return { outcome: 'denied', reason: 'full' };
    }
    return {
        outcome: 'accepted',
        reservations: { ...reservations, principalIds: [...reservations.principalIds, reservation.principalId] }
    };
}

function requireCurrentReservations(reservation: GroupSessionSeatCountInput): GroupSessionReservations {
    const reservations = decodeGroupSessionReservations({
        scheduleRevision: reservation.reservations.scheduleRevision,
        principalIds: reservation.reservations.principalIds
    });
    if (reservations.scheduleRevision !== reservation.schedule.revision) {
        throw new TypeError('Stored reservations do not belong to the current schedule revision');
    }
    return reservations;
}
