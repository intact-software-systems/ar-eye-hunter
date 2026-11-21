import { computeGroupClockChange } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-group-clock-change.ts';
import { expect, it } from 'vitest';

it('freezes 8:14 at the server and resumes the same balance ten minutes later', () => {
    const base = { name: 'period', expectedDirectorEpoch: 1 };
    const start = computeGroupClockChange([], { ...base, operation: 'start', expectedRevision: 0, durationMs: 600_000 }, 1_000);
    expect(start).toEqual({ name: 'period', revision: 1, status: 'running', endsAtEpochMs: 601_000 });
    if ('rejectionCode' in start) {
        throw new Error(start.message);
    }
    const paused = computeGroupClockChange([start], { ...base, operation: 'pause', expectedRevision: 1 }, 107_000);
    expect(paused).toEqual({ name: 'period', revision: 2, status: 'paused', remainingMs: 494_000 });
    if ('rejectionCode' in paused) {
        throw new Error(paused.message);
    }
    expect(computeGroupClockChange([paused], { ...base, operation: 'resume', expectedRevision: 1 }, 707_000))
        .toMatchObject({ rejectionCode: 'room-clock-revision-conflict' });
    expect(computeGroupClockChange([paused], { ...base, expectedDirectorEpoch: 2, operation: 'resume', expectedRevision: 2 }, 707_000))
        .toEqual({ name: 'period', revision: 3, status: 'running', endsAtEpochMs: 1_201_000 });
});

it('rejects expired pauses and live restarts, and reuses an expired clock name', () => {
    const clock = { name: 'period', revision: 2, status: 'running' as const, endsAtEpochMs: 10_000 };
    const base = { name: clock.name, expectedRevision: 2, expectedDirectorEpoch: 1 };
    expect(computeGroupClockChange([clock], { ...base, operation: 'pause' }, 10_000)).toHaveProperty('rejectionCode');
    const start = { ...base, operation: 'start' as const, durationMs: 1_000 };
    expect(computeGroupClockChange([clock], start, 9_999)).toHaveProperty('rejectionCode');
    expect(computeGroupClockChange([clock], start, 10_000)).toEqual({ ...clock, revision: 3, endsAtEpochMs: 11_000 });
});

it('starts the next phase clock while the previous period still has time', () => {
    const period = { name: 'match', revision: 1, status: 'running' as const, endsAtEpochMs: 600_000 };
    const advance = {
        name: 'match', operation: 'advance-phase' as const, phase: 'halftime', durationMs: 180_000,
        expectedDirectorEpoch: 1, expectedRevision: 1
    };
    expect(computeGroupClockChange([period], advance, 10_000)).toEqual({
        name: 'match', revision: 2, status: 'running', endsAtEpochMs: 190_000
    });
    expect(computeGroupClockChange([period], { ...advance, expectedRevision: 0 }, 10_000))
        .toMatchObject({ rejectionCode: 'room-clock-revision-conflict' });
});
