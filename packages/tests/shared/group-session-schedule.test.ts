import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { describe, expect, it } from 'vitest';

import {
    groupSessionStartRefusal,
    readGroupSessionSchedule,
    toGroupSessionTiming
} from '@shared/api/group-sessions/group-session-schedule.ts';

// The room schedule is a public contract; reservations must not be accepted in it.
describe('scheduled session contract', () => {
    it('distinguishes unscheduled rooms from complete schedules', () => {
        expect(readGroupSessionSchedule({})).toBeNull();
        expect(readGroupSessionSchedule({
            rallarSessionSchedule: { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null }
        })).toEqual({ revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null });
    });

    const malformedSchedules: readonly ApiJsonValue[] = [
        null,
        {},
        { revision: 1, startsAtEpochMs: 3_600_000 },
        { revision: 0, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null },
        { revision: 1.5, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null },
        { revision: 1, startsAtEpochMs: -1, cancelledAtEpochMs: null },
        { revision: 1, startsAtEpochMs: Number.MAX_SAFE_INTEGER, cancelledAtEpochMs: null },
        { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: -1 },
        { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null, principalIds: ['alice'] }
    ];
    it.each(malformedSchedules)('fails closed for malformed or private data in public schedule %j', (schedule) => {
        expect(() => readGroupSessionSchedule({ rallarSessionSchedule: schedule })).toThrow(TypeError);
    });
});

describe('scheduled session timing', () => {
    const schedule = { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null };

    it.each(
        [
            [2_999_999, 'upcoming'],
            [3_000_000, 'lobby'],
            [3_599_999, 'lobby'],
            [3_600_000, 'start-ready'],
            [4_199_999, 'start-ready'],
            [4_200_000, 'reservations-expired']
        ] as const
    )('uses the exact approved boundaries at %i', (nowEpochMs, phase) => {
        expect(toGroupSessionTiming(schedule, nowEpochMs)).toEqual({
            phase,
            lobbyOpensAtEpochMs: 3_000_000,
            startsAtEpochMs: 3_600_000,
            reservationsExpireAtEpochMs: 4_200_000
        });
    });

    it('keeps cancellation terminal after the planned start', () => {
        expect(toGroupSessionTiming({ ...schedule, cancelledAtEpochMs: 2_000_000 }, 4_300_000).phase)
            .toBe('cancelled');
    });

    it.each([NaN, Infinity, -1, 0.5])('rejects an invalid attempt clock %s', (nowEpochMs) => {
        expect(() => toGroupSessionTiming(schedule, nowEpochMs)).toThrow(TypeError);
    });
});

describe('scheduled gameplay start gate', () => {
    it('keeps unscheduled games unchanged and refuses early or cancelled scheduled starts', () => {
        const metadata = { rallarSessionSchedule: { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null } };
        expect(groupSessionStartRefusal({}, 1_000)).toBeNull();
        expect(groupSessionStartRefusal(metadata, 3_599_999)).toMatchObject({ code: 'session-not-started' });
        expect(groupSessionStartRefusal(metadata, 3_600_000)).toBeNull();
        expect(groupSessionStartRefusal({ rallarSessionSchedule: { ...metadata.rallarSessionSchedule, cancelledAtEpochMs: 1_000 } }, 4_000_000))
            .toMatchObject({ code: 'session-cancelled' });
    });
});
