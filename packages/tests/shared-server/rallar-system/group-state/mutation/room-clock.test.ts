import { expect, it } from 'vitest';
import { computeRoomClock } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-room-clock.ts';

it('freezes 8:14 at the server and resumes the same balance ten minutes later', () => {
    const base = { name: 'period', expectedDirectorEpoch: 1 };
    const start = computeRoomClock([], { ...base, operation: 'start', expectedRevision: 0, durationMs: 600_000 }, 1_000);
    expect(start).toEqual({ name: 'period', revision: 1, status: 'running', endsAtEpochMs: 601_000 });
    if ('rejectionCode' in start) throw new Error(start.message);
    const paused = computeRoomClock([start], { ...base, operation: 'pause', expectedRevision: 1 }, 107_000);
    expect(paused).toEqual({ name: 'period', revision: 2, status: 'paused', remainingMs: 494_000 });
    if ('rejectionCode' in paused) throw new Error(paused.message);
    expect(computeRoomClock([paused], { ...base, operation: 'resume', expectedRevision: 1 }, 707_000))
        .toMatchObject({ rejectionCode: 'room-clock-revision-conflict' });
    expect(computeRoomClock([paused], { ...base, expectedDirectorEpoch: 2, operation: 'resume', expectedRevision: 2 }, 707_000))
        .toEqual({ name: 'period', revision: 3, status: 'running', endsAtEpochMs: 1_201_000 });
});
