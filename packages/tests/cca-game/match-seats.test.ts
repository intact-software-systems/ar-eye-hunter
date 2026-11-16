import { describe, expect, it } from 'vitest';

import { computeTownMatchSeats, createTownMatchSeats } from '../../../apps/cca-2d/src/match/match-seats.ts';

const members = [
    { id: 'alice', sessionId: 'alice-session', displayName: 'Alice' },
    { id: 'bob', sessionId: 'bob-session', displayName: 'Bob' }
];

describe('round controller seats', () => {
    it('holds an absent seat for ten seconds and accepts a fresh controller before the deadline', () => {
        const seats = createTownMatchSeats(members);
        const away = computeTownMatchSeats({ seats, available: [members[0]], departedIds: [], now: 1000 });
        expect(away[1]).toEqual({ id: 'bob', sessionId: 'bob-session', status: 'away', expiresAtEpochMs: 11000 });
        const waiting = computeTownMatchSeats({ seats: away, available: [members[0]], departedIds: [], now: 9000 });
        expect(waiting[1]).toEqual(away[1]);
        const returned = computeTownMatchSeats({
            seats: waiting,
            available: [members[0], { ...members[1], sessionId: 'bob-reconnected' }],
            departedIds: [],
            now: 10999
        });
        expect(returned[1]).toEqual({ id: 'bob', sessionId: 'bob-reconnected', status: 'active', expiresAtEpochMs: 0 });
        expect(seats[1].status).toBe('active');
    });

    it('makes expiry and voluntary departure irreversible until a new round', () => {
        const seats = createTownMatchSeats(members);
        const away = computeTownMatchSeats({ seats, available: [members[0]], departedIds: [], now: 1000 });
        const expired = computeTownMatchSeats({ seats: away, available: members, departedIds: [], now: 11000 });
        expect(expired[1]).toEqual({ id: 'bob', sessionId: 'bob-session', status: 'observer', expiresAtEpochMs: 0 });
        const returned = computeTownMatchSeats({ seats: expired, available: members, departedIds: [], now: 12000 });
        expect(returned[1].status).toBe('observer');
        const departed = computeTownMatchSeats({ seats, available: members, departedIds: ['bob'], now: 1000 });
        expect(departed[1].status).toBe('observer');
        expect(createTownMatchSeats(members)[1].status).toBe('active');
    });

    it('does not invent seats for strangers or extend a checkpoint deadline after handover', () => {
        const away = computeTownMatchSeats({ seats: createTownMatchSeats(members), available: [], departedIds: [], now: 2000 });
        const restored = computeTownMatchSeats({
            seats: structuredClone(away),
            available: [{ id: 'outsider', sessionId: 'other', displayName: 'Other' }],
            departedIds: [],
            now: 11999
        });
        expect(restored).toEqual(away);
        expect(computeTownMatchSeats({ seats: restored, available: [], departedIds: [], now: 12000 }).every((seat) => seat.status === 'observer')).toBe(true);
    });
});
