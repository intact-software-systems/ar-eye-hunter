import { describe, expect, it } from 'vitest';

import {
    computeGroupSessionReservation,
    countGroupSessionOccupiedSeats,
    decodeGroupSessionReservations
} from '@shared-server/rallar-system/group-state/schedule/group-session-reservations.ts';

const schedule = { revision: 2, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null };
const reservations = { scheduleRevision: 2, principalIds: ['alice'] };

const reservationRequest = {
    schedule,
    reservations,
    action: 'reserve' as const,
    principalId: 'bob',
    expectedScheduleRevision: 2,
    activePlayerPrincipalIds: ['host'],
    maxPlayers: 3,
    nowEpochMs: 2_000_000
};

describe('scheduled player reservations', () => {
    it('counts active players and reserved accounts once, without counting expired reservations', () => {
        expect(countGroupSessionOccupiedSeats({
            schedule,
            reservations,
            activePlayerPrincipalIds: ['host', 'alice'],
            nowEpochMs: 4_199_999
        })).toBe(2);
        expect(countGroupSessionOccupiedSeats({
            schedule,
            reservations,
            activePlayerPrincipalIds: ['host'],
            nowEpochMs: 4_199_999
        })).toBe(2);
        expect(countGroupSessionOccupiedSeats({
            schedule,
            reservations,
            activePlayerPrincipalIds: ['host'],
            nowEpochMs: 4_200_000
        })).toBe(1);
    });

    it('reserves the last seat and refuses another account against the accepted state', () => {
        const accepted = computeGroupSessionReservation(reservationRequest);
        expect(accepted).toEqual({
            outcome: 'accepted',
            reservations: { scheduleRevision: 2, principalIds: ['alice', 'bob'] }
        });
        if (accepted.outcome !== 'accepted') {
            throw new Error('Expected the last player seat to be available');
        }
        expect(computeGroupSessionReservation({
            ...reservationRequest,
            reservations: accepted.reservations,
            principalId: 'charlie'
        })).toEqual({ outcome: 'denied', reason: 'full' });
        expect(reservations.principalIds).toEqual(['alice']);
    });

    it.each(['alice', 'host'])('does not charge an account twice when %s reserves from another tab', (principalId) => {
        expect(computeGroupSessionReservation({ ...reservationRequest, principalId, maxPlayers: 2 }))
            .toEqual({ outcome: 'accepted', reservations });
    });

    it('withdraws only the caller reservation and permits another account to use the seat', () => {
        const withdrawn = computeGroupSessionReservation({
            ...reservationRequest,
            action: 'withdraw',
            principalId: 'alice'
        });
        expect(withdrawn).toEqual({
            outcome: 'accepted',
            reservations: { scheduleRevision: 2, principalIds: [] }
        });
        if (withdrawn.outcome !== 'accepted') {
            throw new Error('Expected reservation withdrawal');
        }
        expect(computeGroupSessionReservation({
            ...reservationRequest,
            reservations: withdrawn.reservations,
            maxPlayers: 2
        })).toEqual({ outcome: 'accepted', reservations: { scheduleRevision: 2, principalIds: ['bob'] } });
    });

    it('rejects an old reserve or withdraw action after a schedule change', () => {
        for (const action of ['reserve', 'withdraw'] as const) {
            expect(computeGroupSessionReservation({ ...reservationRequest, action, expectedScheduleRevision: 1 }))
                .toEqual({ outcome: 'denied', reason: 'schedule-changed' });
        }
    });

    it('refuses reservations after cancellation or the exact no-show deadline', () => {
        expect(computeGroupSessionReservation({
            ...reservationRequest,
            schedule: { ...schedule, cancelledAtEpochMs: 1_900_000 }
        })).toEqual({ outcome: 'denied', reason: 'cancelled' });
        expect(computeGroupSessionReservation({ ...reservationRequest, nowEpochMs: 4_200_000 }))
            .toEqual({ outcome: 'denied', reason: 'reservations-expired' });
    });

    it('fails closed when stored reservations belong to a different schedule revision', () => {
        expect(() =>
            computeGroupSessionReservation({
                ...reservationRequest,
                reservations: { scheduleRevision: 1, principalIds: ['alice'] }
            })
        ).toThrow(TypeError);
    });

    it.each([
        null,
        { scheduleRevision: 2 },
        { scheduleRevision: 0, principalIds: [] },
        { scheduleRevision: 2, principalIds: ['alice', 'alice'] },
        { scheduleRevision: 2, principalIds: [''] },
        { scheduleRevision: 2, principalIds: Array.from({ length: 65 }, (_, index) => `player-${index}`) }
    ])('rejects malformed, duplicate or unbounded reservation storage %j', (value) => {
        expect(() => decodeGroupSessionReservations(value)).toThrow(TypeError);
    });
});
