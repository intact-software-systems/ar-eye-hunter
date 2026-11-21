import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import { requireSnapshot, seedOpenGroup } from '../presence/group-presence-test-runtime.ts';
import { computeGroupClockChange, computeGroupClockUpdate } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-group-clock-change.ts';
import { expect, it } from 'vitest';

it('freezes 8:14 at the server and resumes the same balance ten minutes later', () => {
    const base = { name: 'period', expectedDirectorEpoch: 1 };
    const start = computeGroupClockChange([], { ...base, operation: 'start', expectedRevision: 0, durationMs: 600_000 }, 1_000);
    expect(start).toEqual({ name: 'period', revision: 1, status: 'running', endsAtEpochMs: 601_000 });
    if (!('status' in start)) {
        throw new Error(start.message);
    }
    const paused = computeGroupClockChange([start], { ...base, operation: 'pause', expectedRevision: 1 }, 107_000);
    expect(paused).toEqual({ name: 'period', revision: 2, status: 'paused', remainingMs: 494_000 });
    if (!('status' in paused)) {
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
        name: 'match', revision: 2, phase: 'halftime', startedAtRevision: 2, status: 'running', endsAtEpochMs: 190_000
    });
    expect(computeGroupClockChange([period], { ...advance, expectedRevision: 0 }, 10_000))
        .toMatchObject({ rejectionCode: 'room-clock-revision-conflict' });
});

it('resumes a plain clock without interpreting app-owned timeline metadata', async () => {
    const repository = new GroupBarrierRepository();
    await seedOpenGroup(repository, 'court');
    const { group } = await requireSnapshot(repository, 'court');
    const clock = { name: 'match', revision: 3, status: 'paused', remainingMs: 9000 };
    const metadata = { rallarRoomClocks: [clock], rallarRoomTimelines: ['app-owned'] };
    const result = computeGroupClockUpdate({ ...group, kind: 'room', metadata }, {
        operation: 'resume', name: 'match', expectedRevision: 3, expectedDirectorEpoch: 1
    }, 1000);
    expect(result).toMatchObject({ metadata: { rallarRoomTimelines: ['app-owned'], rallarRoomClocks: [
        { name: 'match', revision: 4, status: 'running', endsAtEpochMs: 10000 }
    ] } });
});

it('adds the requested duration to the existing phase end and preserves the occurrence', () => {
    const clock = { name: 'match', phase: 'first', startedAtRevision: 2, revision: 4, status: 'running' as const, endsAtEpochMs: 9000 };
    const command = { name: 'match', operation: 'extend-phase' as const, durationMs: 1234, expectedRevision: 4, expectedDirectorEpoch: 1 };
    expect(computeGroupClockChange([clock], command, 7000)).toEqual({ ...clock, revision: 5, endsAtEpochMs: 10234 });
    expect(computeGroupClockChange([clock], command, 9000)).toHaveProperty('rejectionCode');
    const plain = { name: 'match', revision: 4, status: 'paused' as const, remainingMs: 1000 };
    expect(computeGroupClockChange([plain], command, 7000)).toHaveProperty('rejectionCode');
    expect(computeGroupClockChange([{ ...plain, phase: 'first', startedAtRevision: 2 }], {
        ...command, durationMs: Number.MAX_SAFE_INTEGER
    }, 7000)).toHaveProperty('rejectionCode');
});

it('revises future schedule boundaries while protecting elapsed phases and manual clocks', () => {
    const phases = [{ phase: 'halftime', startsAtEpochMs: 100 }, { phase: 'second', startsAtEpochMs: 500 }];
    const publish = { operation: 'publish-schedule' as const, name: 'court', expectedDirectorEpoch: 1, expectedRevision: 0, phases };
    const first = { name: 'court', status: 'scheduled' as const, revision: 1, phases };
    expect(computeGroupClockChange([], publish, 200)).toEqual(first);
    const later = [phases[0], { ...phases[1], startsAtEpochMs: 700 }];
    const revise = { ...publish, expectedRevision: 1, phases: later };
    expect(computeGroupClockChange([first], revise, 499)).toEqual({ ...first, revision: 2, phases: later });
    expect(computeGroupClockChange([first], revise, 500)).toHaveProperty('rejectionCode');
    expect(computeGroupClockChange([first], { ...publish, expectedRevision: 1, phases: [{ phase: 'new', startsAtEpochMs: 99 }, ...phases] }, 200)).toHaveProperty('rejectionCode');
    expect(computeGroupClockChange([first], { name: 'court', operation: 'start', durationMs: 1000, expectedDirectorEpoch: 1, expectedRevision: 1 }, 200)).toHaveProperty('rejectionCode');
});
