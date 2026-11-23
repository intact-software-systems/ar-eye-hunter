import { expect, it } from 'vitest';
import { assertRoomClockMutation } from '@shared/api/group-deadlines/room-clock.ts';
import { readRoomTimeline, settleRoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import { computeGroupClockChange } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-group-clock-change.ts';

const next = { phase: 'play', durationMs: 600_000 };
const warmup = {
    name: 'match', phase: 'warmup', revision: 1, startedAtRevision: 1, startedAtEpochMs: 0,
    startedBy: 'director' as const, status: 'running' as const, endsAtEpochMs: 1000, successor: next
};
const base = { name: 'match', expectedDirectorEpoch: 1, expectedRevision: 1 };

it('starts a timed successor at the revised boundary, once, even after a late wake', () => {
    const extended = computeGroupClockChange([warmup], { ...base, operation: 'extend-phase', durationMs: 300 }, 800);
    expect(extended).toEqual({ ...warmup, revision: 2, endsAtEpochMs: 1300 });
    if (!('startedBy' in extended)) throw Error('missing timeline');
    expect(settleRoomTimeline(extended, 1000)).toBeNull();
    const started = settleRoomTimeline(extended, 3000);
    expect(started).toEqual({ ...warmup, phase: 'play', startedAtRevision: 3, startedAtEpochMs: 1300,
        startedBy: 'automatic', revision: 3, successor: null, endsAtEpochMs: 601300 });
    expect(settleRoomTimeline(started!, 700000)).toBeNull();
});

it('freezes the planned transition, resumes it under a new director, and clears it on early advancement', () => {
    const paused = computeGroupClockChange([warmup], { ...base, operation: 'pause' }, 700);
    if (!('startedBy' in paused)) throw Error('missing timeline');
    expect(settleRoomTimeline(paused, 8000)).toBeNull();
    const resumed = computeGroupClockChange([paused], { ...base, operation: 'resume', expectedDirectorEpoch: 2, expectedRevision: 2 }, 8000);
    expect(resumed).toEqual({ ...warmup, revision: 3, endsAtEpochMs: 8300 });
    const advance = { ...base, operation: 'advance-phase' as const, phase: 'play', durationMs: 100 };
    expect(computeGroupClockChange([warmup], advance, 999)).toMatchObject({ phase: 'play', startedAtEpochMs: 999, successor: null });
    expect(computeGroupClockChange([warmup], advance, 1000)).toHaveProperty('rejectionCode');
});

it('configures or cancels only a live or paused phase and validates the scheduled duration', () => {
    const command = { ...base, operation: 'set-successor' as const, successor: null };
    expect(() => assertRoomClockMutation(command)).not.toThrow();
    expect(computeGroupClockChange([warmup], command, 200)).toEqual({ ...warmup, revision: 2, successor: null });
    expect(computeGroupClockChange([warmup], command, 1000)).toHaveProperty('rejectionCode');
    expect(computeGroupClockChange([warmup], { ...command, successor: { ...next, durationMs: Number.MAX_SAFE_INTEGER } }, 1))
        .toHaveProperty('rejectionCode');
    expect(() => assertRoomClockMutation({ ...command, successor: { ...next, durationMs: 0 } })).toThrow();
    const advance = { ...base, operation: 'advance-phase' as const, phase: 'warmup', durationMs: 100, successor: next };
    expect(() => assertRoomClockMutation(advance)).not.toThrow();
    expect(computeGroupClockChange([], { ...advance, expectedRevision: 0 }, 900)).toMatchObject({ successor: next, endsAtEpochMs: 1000 });
});

it('refuses unreadable pending transitions instead of storing an end or revision the worker cannot commit', () => {
    const read = (record: typeof warmup) => readRoomTimeline({ rallarRoomClocks: [record] }, 'match');
    expect(() => read({ ...warmup, endsAtEpochMs: 8_640_000_000_000_000 })).toThrow();
    expect(() => read({ ...warmup, revision: Number.MAX_SAFE_INTEGER })).toThrow();
    expect(read(warmup)).toEqual(warmup);
});
