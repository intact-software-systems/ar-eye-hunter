import { requireEpoch, requirePositiveInteger, requireRecord } from '../exact-object-decoding.ts';
import { assertRoomDeadlineName } from '../group-deadlines/room-deadline.ts';
import type { RoomSchedule } from '../group-deadlines/room-schedule.ts';
import { closeRegistrationIfDue, updateRoomLobbyRegistration } from './room-lobby-registration.ts';
import type { RoomLobby } from './room-lobby.ts';

export function assertRoomLobbyRegistrationBoundary(value: unknown): asserts value is RoomLobby.SetRegistrationBoundary {
    const command = requireRecord(value, 'Registration boundary command');
    requireEpoch(command.expectedRevision, 'Expected registration revision');
    requirePositiveInteger(command.expectedProgramRevision, 'Expected program revision');
    assertRoomDeadlineName(command.program);
    assertRoomDeadlineName(command.phase);
}

interface SetRegistrationBoundaryInput {
    readonly lobby: RoomLobby;
    readonly command: RoomLobby.SetRegistrationBoundary;
    readonly schedule: RoomSchedule | null;
    readonly nowEpochMs: number;
}

export function setRoomLobbyRegistrationBoundary({ lobby, command, schedule, nowEpochMs }: SetRegistrationBoundaryInput): RoomLobby.Change {
    assertRoomLobbyRegistrationBoundary(command);
    const current = settleRegistration(lobby, nowEpochMs);
    if (current.registration.closed) return { lobby: current, rejection: 'registration-closed' };
    if (command.expectedRevision !== lobby.registration.revision || (schedule && command.expectedProgramRevision !== schedule.revision)) {
        return { lobby, rejection: 'revision-conflict' };
    }
    return resolveBoundary({ lobby, schedule, nowEpochMs, boundary: { program: command.program, phase: command.phase } });
}

export function reconcileRoomLobbyRegistrationBoundary(lobby: RoomLobby, schedule: RoomSchedule | null, nowEpochMs: number): RoomLobby.Change {
    const boundary = lobby.registration.boundary;
    if (!boundary) return { lobby, rejection: null };
    const current = settleRegistration(lobby, nowEpochMs);
    if (current.registration.closed) return { lobby: current, rejection: null };
    return resolveBoundary({ lobby, schedule, nowEpochMs, boundary });
}

function settleRegistration(lobby: RoomLobby, nowEpochMs: number): RoomLobby {
    requireEpoch(nowEpochMs, 'Registration observation time');
    const current = closeRegistrationIfDue(lobby, nowEpochMs);
    return current === lobby ? lobby : { ...current, revision: lobby.revision + 1 };
}

interface ResolveBoundaryInput extends Omit<SetRegistrationBoundaryInput, 'command'> {
    readonly boundary: RoomLobby.Boundary;
}

function resolveBoundary({ lobby, schedule, nowEpochMs, boundary }: ResolveBoundaryInput): RoomLobby.Change {
    if (!schedule || schedule.name !== boundary.program) return { lobby, rejection: 'invalid-boundary' };
    const matches = schedule.phases.filter(phase => phase.phase === boundary.phase);
    if (matches.length !== 1) return { lobby, rejection: 'invalid-boundary' };
    const start = matches[0].startsAtEpochMs;
    // The saved cursor proves a phase elapsed even if this writer's UTC clock is behind it.
    const atEpochMs = schedule.status === 'program-paused' && start > schedule.elapsedThroughEpochMs ? null : start;
    return updateRoomLobbyRegistration(lobby, { expectedRevision: lobby.registration.revision, boundary, atEpochMs, elapsedThroughEpochMs: schedule.elapsedThroughEpochMs }, nowEpochMs);
}
