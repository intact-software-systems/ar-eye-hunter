import { readRoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import { SCOPE } from './group-mutation-test-runtime.ts';
import { computeGroupClockChange, computeGroupClockUpdate } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-group-clock-change.ts';
import { assertRoomClockCommand, assertRoomClockMutation, readRoomClocks, readRoomSchedule } from '@shared/api/group-deadlines/room-clock.ts';
import { pausedRoomSchedulePosition, type RoomSchedule } from '@shared/api/group-deadlines/room-schedule.ts';
import { expect, it } from 'vitest';

import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import { createService, requireSnapshot, seedOpenGroup } from '../presence/group-presence-test-runtime.ts';

const phases = [
    { phase: 'first', startsAtEpochMs: 100 },
    { phase: 'break', startsAtEpochMs: 200 },
    { phase: 'second', startsAtEpochMs: 400 }
];
const schedule: RoomSchedule = { status: 'scheduled', name: 'court', revision: 1, elapsedThroughEpochMs: 100, phases };
const pause = { name: 'court', expectedDirectorEpoch: 1, operation: 'pause-program', expectedRevision: 1 } as const;
const resume = { ...pause, operation: 'resume-program', expectedRevision: 2 } as const;

it('freezes the greatest elapsed start and shifts only the remaining program once', async () => {
    const repository = new GroupBarrierRepository();
    await seedOpenGroup(repository, 'court');
    const { group } = await requireSnapshot(repository, 'court');
    const venue = [{ name: 'venue-close', revision: 1, atEpochMs: 50000 }];
    const before = { ...group, kind: 'room' as const, metadata: {
        rallarRoomClocks: [{ ...schedule, phases }], rallarRoomDeadlines: venue
    } };
    const frozen = computeGroupClockUpdate(before, pause, 200);
    if ('rejectionCode' in frozen) throw new Error(frozen.message);
    const observed = readRoomSchedule(frozen.metadata, 'court');
    expect(observed).toEqual({ ...schedule, revision: 2, status: 'program-paused', elapsedThroughEpochMs: 200 });
    expect(readRoomClocks(frozen.metadata)).toEqual([]);
    expect(pausedRoomSchedulePosition(observed!)).toEqual({ status: 'paused', current: phases[1], next: phases[2], remainingMs: 200 });
    const running = computeGroupClockUpdate(frozen, resume, 600200);
    if ('rejectionCode' in running) throw new Error(running.message);
    expect(readRoomSchedule(running.metadata, 'court')).toEqual({
        ...schedule, revision: 3, elapsedThroughEpochMs: 600200,
        phases: [phases[0], phases[1], { ...phases[2], startsAtEpochMs: 600400 }]
    });
    expect(running.metadata.rallarRoomDeadlines).toEqual(venue);
    expect(computeGroupClockUpdate(running, resume, 600250)).toHaveProperty('rejectionCode', 'room-clock-revision-conflict');
});

it('preserves a pre-start delay and never reverses the program for a slower writer', () => {
    const notStarted = { ...schedule, elapsedThroughEpochMs: 90 };
    const earlier = computeGroupClockChange([notStarted], pause, 80);
    if (!('phases' in earlier)) throw new Error('Expected a paused program');
    expect(pausedRoomSchedulePosition(earlier)).toEqual({ status: 'paused', current: null, next: phases[0], remainingMs: 10 });
    expect(computeGroupClockChange([earlier], resume, 70)).toEqual({ ...notStarted, revision: 3 });
    const last = computeGroupClockChange([schedule], pause, 500);
    if (!('phases' in last)) throw new Error('Expected a paused program');
    expect(pausedRoomSchedulePosition(last)).toEqual({ status: 'paused', current: phases[2], next: null, remainingMs: null });
});

it('preserves elapsed phases and the frozen cursor on a schedule revision while paused', () => {
    const frozen: RoomSchedule = { ...schedule, status: 'program-paused', elapsedThroughEpochMs: 200, revision: 2 };
    const publish = { ...resume, operation: 'publish-schedule' as const, phases: [phases[0], phases[1], { ...phases[2], startsAtEpochMs: 300 }] };
    expect(computeGroupClockChange([frozen], publish, 1000)).toEqual({ ...frozen, phases: publish.phases, revision: 3 });
    expect(computeGroupClockChange([frozen], { ...publish, phases: [phases[0], phases[2]] }, 1000)).toHaveProperty('rejectionCode');
});

it('rejects overflow, wrong-state transitions, and plain-clock commands on a program', () => {
    const frozen: RoomSchedule = { ...schedule, status: 'program-paused', elapsedThroughEpochMs: 200, revision: 2 };
    expect(computeGroupClockChange([frozen], resume, 8640000000000000)).toHaveProperty('rejectionCode');
    expect(computeGroupClockChange([schedule], { ...resume, expectedRevision: 1 }, 300)).toHaveProperty('rejectionCode');
    expect(computeGroupClockChange([frozen], { ...pause, expectedRevision: 2 }, 300)).toHaveProperty('rejectionCode');
    expect(computeGroupClockChange([frozen], { ...resume, operation: 'resume' }, 300)).toHaveProperty('rejectionCode');
    expect(() => assertRoomClockMutation(pause)).not.toThrow();
    expect(() => assertRoomClockMutation({ ...resume, durationMs: 1 })).toThrow();
    expect(() => assertRoomClockCommand(pause)).toThrow();
});


it('keeps the pause across director loss and fences the former director’s delayed resume', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, 'court');
    const now = Date.now();
    const writer = createService({ runtimeRepository: runtime, nowEpochMs: now, attemptCount: 1, injectedRandomId: undefined, timing: undefined });
    const alice = { actorPrincipalId: 'alice', actorSessionId: 'alice-session' };
    const bob = { actorPrincipalId: 'bob', actorSessionId: 'bob-session' };
    await writer.joinGroup(SCOPE, 'court', { actorPrincipalId: 'bob', requestId: 'join-bob' });
    for (const actor of [alice, bob]) {
        await writer.connectPresenceSession(SCOPE, 'court', actor.actorSessionId, {
            ...actor, principalId: actor.actorPrincipalId, generationId: 'presence-' + actor.actorPrincipalId,
            connectionGenerationId: 'socket-' + actor.actorPrincipalId, publicationKey: null, requestId: 'connect-' + actor.actorPrincipalId
        });
    }
    await writer.appointDirector(SCOPE, 'court', { ...alice, requestId: 'first-director' });
    await writer.updateGroup(SCOPE, 'court', { ...alice, requestId: 'publish', roomClock: {
        name: 'court', expectedDirectorEpoch: 1, expectedRevision: 0, operation: 'publish-schedule',
        phases: [{ phase: 'first', startsAtEpochMs: now - 1000 }, { phase: 'second', startsAtEpochMs: now + 1000 }]
    } });
    await writer.updateGroup(SCOPE, 'court', { ...alice, requestId: 'freeze', roomClock: pause });
    const successor = { phase: 'play', durationMs: 600_000 };
    await writer.updateGroup(SCOPE, 'court', { ...alice, requestId: 'start-warmup', roomClock: {
        name: 'match', operation: 'advance-phase', phase: 'warmup', durationMs: 60000,
        expectedDirectorEpoch: 1, expectedRevision: 0, successor
    } });
    const before = readRoomSchedule((await requireSnapshot(runtime, 'court')).group.metadata, 'court');
    expect(before && pausedRoomSchedulePosition(before)?.remainingMs).toBe(1000);
    await writer.disconnectPresenceSession(SCOPE, 'court', alice.actorSessionId, {
        actorPrincipalId: 'alice', principalId: 'alice', generationId: 'presence-alice', reason: 'closed', requestId: 'disconnect'
    });
    expect(readRoomSchedule((await requireSnapshot(runtime, 'court')).group.metadata, 'court')).toEqual(before);
    await writer.appointDirector(SCOPE, 'court', { ...bob, requestId: 'replacement' });
    const cancel = { name: 'match', operation: 'set-successor' as const, successor: null, expectedDirectorEpoch: 2, expectedRevision: 1 };
    await expect(writer.updateGroup(SCOPE, 'court', { ...alice, requestId: 'former-director-cancellation', roomClock: cancel }))
        .rejects.toMatchObject({ code: 'room-director-changed' });
    const match = async () => readRoomTimeline((await requireSnapshot(runtime, 'court')).group.metadata, 'match');
    expect(await match()).toMatchObject({ revision: 1, successor });
    await writer.updateGroup(SCOPE, 'court', { ...bob, requestId: 'replacement-cancellation', roomClock: cancel });
    expect(await match()).toMatchObject({ revision: 2, successor: null });
    for (const actor of [alice, bob]) {
        await expect(writer.updateGroup(SCOPE, 'court', { ...actor, requestId: 'obsolete-' + actor.actorPrincipalId, roomClock: resume }))
            .rejects.toMatchObject({ code: 'room-director-changed' });
    }
    expect(readRoomSchedule((await requireSnapshot(runtime, 'court')).group.metadata, 'court')).toEqual(before);
    await writer.updateGroup(SCOPE, 'court', { ...bob, requestId: 'resume-by-replacement', roomClock: { ...resume, expectedDirectorEpoch: 2 } });
    expect(readRoomSchedule((await requireSnapshot(runtime, 'court')).group.metadata, 'court')?.status).toBe('scheduled');
});
