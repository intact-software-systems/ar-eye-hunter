import { assertRoomDeadlineName } from '../group-deadlines/room-deadline.ts';
import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requireExactOptionalKeys, requireRecord } from '../exact-object-decoding.ts';
import type { RoomLobby } from './room-lobby.ts';

export const ROOM_LOBBY_REGISTRATION_METADATA_KEY = 'rallarRoomLobbyRegistration';

function decodeRegistrationDefinition(value: unknown): RoomLobby.RegistrationDefinition {
    const record = requireRecord(value, 'Registration definition');
    requireExactOptionalKeys({ value: record, required: ['revision', 'atEpochMs'], optional: ['boundary'], label: 'Registration definition' });
    requireEpoch(record.revision, 'Registration revision');
    const atEpochMs = record.atEpochMs;
    if (atEpochMs !== null) requireEpoch(atEpochMs, 'Registration cutoff');
    if (record.revision === 0 && (atEpochMs !== null || Object.hasOwn(record, 'boundary'))) throw new TypeError('An initial registration has no cutoff');
    if (!Object.hasOwn(record, 'boundary')) return { revision: record.revision, atEpochMs };
    const boundary = requireRecord(record.boundary, 'Program registration boundary');
    requireExactKeys(boundary, ['program', 'phase'], 'Program registration boundary');
    assertRoomDeadlineName(boundary.program);
    assertRoomDeadlineName(boundary.phase);
    return { revision: record.revision, atEpochMs, boundary: { program: boundary.program, phase: boundary.phase } };
}

export function decodeRoomLobbyRegistration(value: unknown): RoomLobby.Registration {
    const record = requireRecord(value, 'Room registration');
    const { closed, ...publicFields } = record;
    const definition = decodeRegistrationDefinition(publicFields);
    if (typeof closed !== 'boolean' || (closed && definition.atEpochMs === null)) {
        throw new TypeError('Invalid room registration');
    }
    return { ...definition, closed };
}

export function roomLobbyRegistrationDefinition({ revision, atEpochMs, boundary }: RoomLobby.Registration): RoomLobby.RegistrationDefinition & ApiJsonObject {
    return boundary ? { revision, atEpochMs, boundary: { ...boundary } } : { revision, atEpochMs };
}

export function readRoomLobbyRegistration(metadata: ApiJsonObject): RoomLobby.RegistrationDefinition | null {
    if (!Object.hasOwn(metadata, ROOM_LOBBY_REGISTRATION_METADATA_KEY)) return null;
    return decodeRegistrationDefinition(metadata[ROOM_LOBBY_REGISTRATION_METADATA_KEY]);
}

export function isRoomLobbyRegistrationClosed(registration: RoomLobby.Registration, nowEpochMs: number): boolean {
    return registration.closed || (registration.atEpochMs !== null && registration.atEpochMs <= nowEpochMs);
}

/** Closing the gate releases waiters only. Previously issued offers retain their own expiry. */
export function closeRegistrationIfDue(lobby: RoomLobby, now: number): RoomLobby {
    const { registration } = lobby;
    if (registration.closed || !isRoomLobbyRegistrationClosed(registration, now)) return lobby;
    return { ...lobby, registration: { ...registration, closed: true }, waiters: [] };
}

export function changeRegistration(
    lobby: RoomLobby, command: Extract<RoomLobby.Command, { kind: 'close-registration' | 'set-registration-cutoff' }>, now: number
): RoomLobby.Change {
    if (command.kind === 'close-registration') {
        const { registration } = lobby;
        const current = closeRegistrationIfDue(lobby, now);
        if (command.generation !== registration.revision || command.dueAtEpochMs !== registration.atEpochMs || current === lobby) {
            return { lobby, rejection: null };
        }
        return { lobby: { ...current, revision: lobby.revision + 1 }, rejection: null };
    }
    return updateRoomLobbyRegistration(lobby, command, now);
}

interface RegistrationUpdate extends RoomLobby.RegistrationCutoff {
    readonly elapsedThroughEpochMs?: number;
    readonly boundary?: RoomLobby.Boundary;
}

export function updateRoomLobbyRegistration(lobby: RoomLobby, command: RegistrationUpdate, now: number): RoomLobby.Change {
    const { registration } = lobby;
    const current = closeRegistrationIfDue(lobby, now);
    requireEpoch(command.expectedRevision, 'Expected registration revision');
    if (command.atEpochMs !== null) requireEpoch(command.atEpochMs, 'Registration cutoff');
    if (current.registration.closed) {
        return { lobby: current === lobby ? lobby : { ...current, revision: lobby.revision + 1 }, rejection: 'registration-closed' };
    }
    if (command.expectedRevision !== registration.revision) return { lobby, rejection: 'revision-conflict' };
    const confirmedThrough = Math.max(now, command.elapsedThroughEpochMs ?? now);
    if (command.atEpochMs === registration.atEpochMs && command.boundary?.program === registration.boundary?.program &&
        command.boundary?.phase === registration.boundary?.phase) {
        const settled = closeRegistrationIfDue(lobby, confirmedThrough);
        return { lobby: settled === lobby ? lobby : { ...settled, revision: lobby.revision + 1 }, rejection: null };
    }
    const revision = registration.revision + 1;
    requireEpoch(revision, 'Registration revision');
    const updated = { ...lobby, revision: lobby.revision + 1, registration: { revision, atEpochMs: command.atEpochMs, ...(command.boundary && { boundary: command.boundary }), closed: false } };
    return { lobby: closeRegistrationIfDue(updated, confirmedThrough), rejection: null };
}
