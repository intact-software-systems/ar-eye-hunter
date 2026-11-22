import { expect, it } from 'vitest';
import type { RoomSchedule } from '@shared/api/group-deadlines/room-schedule.ts';
import { changeRoomLobby, createRoomLobby, decodeRoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { reconcileRoomLobbyRegistrationBoundary, setRoomLobbyRegistrationBoundary } from '@shared/api/room-lobbies/room-lobby-registration-boundary.ts';
import { readRoomLobbyRegistration, roomLobbyRegistrationDefinition } from '@shared/api/room-lobbies/room-lobby-registration.ts';

const lobby = createRoomLobby({ roomRef: { applicationId: 'app', workspaceId: 'league', groupId: 'court' },
    activationId: 'game-day', capacity: 2, policy: { returnWindowMs: 500, claimWindowMs: 300 } });
const boundary = { program: 'match', phase: 'play' };
const command = { ...boundary, expectedRevision: 0, expectedProgramRevision: 1 };
const schedule: RoomSchedule = { name: 'match', revision: 1, status: 'scheduled', elapsedThroughEpochMs: 10,
    phases: [{ phase: 'warmup', startsAtEpochMs: 10 }, { phase: 'play', startsAtEpochMs: 100 }] };

it('suspends, resumes and settles a unique phase boundary across missed timer deliveries', () => {
    const bound = setRoomLobbyRegistrationBoundary({ lobby, command, schedule, nowEpochMs: 20 }).lobby;
    expect(bound.registration).toEqual({ revision: 1, atEpochMs: 100, boundary, closed: false });
    expect(decodeRoomLobby(bound)).toEqual(bound);
    expect(readRoomLobbyRegistration({ rallarRoomLobbyRegistration: roomLobbyRegistrationDefinition(bound.registration) }))
        .toEqual({ revision: 1, atEpochMs: 100, boundary });
    const paused: RoomSchedule = { ...schedule, revision: 2, status: 'program-paused', elapsedThroughEpochMs: 40 };
    const held = reconcileRoomLobbyRegistrationBoundary(bound, paused, 40).lobby;
    expect(held.registration).toEqual({ revision: 2, atEpochMs: null, boundary, closed: false });
    expect(changeRoomLobby(held, { kind: 'close-registration', generation: 1, dueAtEpochMs: 100 }, 120).lobby).toBe(held);
    const resumed = { ...schedule, revision: 3, phases: [schedule.phases[0], { phase: 'play', startsAtEpochMs: 180 }] };
    const running = reconcileRoomLobbyRegistrationBoundary(held, resumed, 120).lobby;
    expect(running.registration).toEqual({ revision: 3, atEpochMs: 180, boundary, closed: false });
    const closed = reconcileRoomLobbyRegistrationBoundary(running, { ...paused, revision: 4 }, 180).lobby;
    expect(closed.registration).toMatchObject({ revision: 3, atEpochMs: 180, closed: true });
    expect(reconcileRoomLobbyRegistrationBoundary(closed, null, 200).lobby).toBe(closed);
});

it('checks both captured revisions and rejects missing or ambiguous bound phase edits while open', () => {
    expect(() => setRoomLobbyRegistrationBoundary({ lobby, schedule, command: { ...command, expectedProgramRevision: 0 }, nowEpochMs: 20 }))
        .toThrow(/program revision/i);
    for (const stale of [{ ...command, expectedRevision: 1 }, { ...command, expectedProgramRevision: 2 }]) {
        expect(setRoomLobbyRegistrationBoundary({ lobby, command: stale, schedule, nowEpochMs: 20 }).rejection).toBe('revision-conflict');
    }
    const bound = setRoomLobbyRegistrationBoundary({ lobby, command, schedule, nowEpochMs: 20 }).lobby;
    for (const invalid of [null, { ...schedule, name: 'unrelated' }, { ...schedule, phases: [schedule.phases[0]] },
        { ...schedule, phases: [...schedule.phases, { phase: 'play', startsAtEpochMs: 200 }] }]) {
        expect(reconcileRoomLobbyRegistrationBoundary(bound, invalid, 30)).toEqual({ lobby: bound, rejection: 'invalid-boundary' });
    }
    expect(reconcileRoomLobbyRegistrationBoundary(bound, { ...schedule, revision: 2 }, 30).lobby).toBe(bound);
    const unbound = changeRoomLobby(bound, { kind: 'set-registration-cutoff', expectedRevision: 1, atEpochMs: 100 }, 40).lobby;
    expect(unbound.registration).toEqual({ revision: 2, atEpochMs: 100, closed: false });
});

it('closes immediately when a paused program has already reached the selected phase', () => {
    const elapsed = { ...schedule, status: 'program-paused' as const, elapsedThroughEpochMs: 120 };
    const bound = setRoomLobbyRegistrationBoundary({ lobby, command, schedule: elapsed, nowEpochMs: 125 });
    expect(bound.lobby.registration).toEqual({ revision: 1, atEpochMs: 100, boundary, closed: true });
});


it('retains the actual elapsed phase start when a later writer’s clock runs behind the program cursor', () => {
    const elapsed = { ...schedule, elapsedThroughEpochMs: 120 };
    const bound = setRoomLobbyRegistrationBoundary({ lobby, command, schedule: elapsed, nowEpochMs: 95 });
    expect(bound.lobby.registration).toEqual({ revision: 1, atEpochMs: 100, boundary, closed: true });
});
