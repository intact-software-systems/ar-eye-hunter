import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requireRecord } from '../exact-object-decoding.ts';
import type { RoomLobby } from './room-lobby.ts';

export const ROOM_LOBBY_REGISTRATION_METADATA_KEY = 'rallarRoomLobbyRegistration';

function readDefinition(record: Record<string, unknown>): RoomLobby.RegistrationDefinition {
    requireEpoch(record.revision, 'Registration revision');
    const atEpochMs = record.atEpochMs;
    if (atEpochMs !== null) requireEpoch(atEpochMs, 'Registration cutoff');
    if (record.revision === 0 && atEpochMs !== null) throw new TypeError('An initial registration has no cutoff');
    return { revision: record.revision, atEpochMs };
}

export function decodeRoomLobbyRegistration(value: unknown): RoomLobby.Registration {
    const record = requireRecord(value, 'Room registration');
    requireExactKeys(record, ['revision', 'atEpochMs', 'closed'], 'Room registration');
    const definition = readDefinition(record);
    if (typeof record.closed !== 'boolean' || (record.closed && definition.atEpochMs === null)) {
        throw new TypeError('Invalid room registration');
    }
    return { ...definition, closed: record.closed };
}

export function readRoomLobbyRegistration(metadata: ApiJsonObject): RoomLobby.RegistrationDefinition | null {
    if (!Object.hasOwn(metadata, ROOM_LOBBY_REGISTRATION_METADATA_KEY)) return null;
    const record = requireRecord(metadata[ROOM_LOBBY_REGISTRATION_METADATA_KEY], 'Registration definition');
    requireExactKeys(record, ['revision', 'atEpochMs'], 'Registration definition');
    return readDefinition(record);
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
    const { registration } = lobby;
    const current = closeRegistrationIfDue(lobby, now);
    if (command.kind === 'close-registration') {
        if (command.generation !== registration.revision || command.dueAtEpochMs !== registration.atEpochMs || current === lobby) {
            return { lobby, rejection: null };
        }
        return { lobby: { ...current, revision: lobby.revision + 1 }, rejection: null };
    }
    requireEpoch(command.expectedRevision, 'Expected registration revision');
    if (command.atEpochMs !== null) requireEpoch(command.atEpochMs, 'Registration cutoff');
    if (current.registration.closed) {
        return { lobby: current === lobby ? lobby : { ...current, revision: lobby.revision + 1 }, rejection: 'registration-closed' };
    }
    if (command.expectedRevision !== registration.revision) return { lobby, rejection: 'revision-conflict' };
    if (command.atEpochMs === registration.atEpochMs) return { lobby, rejection: null };
    const revision = registration.revision + 1;
    requireEpoch(revision, 'Registration revision');
    const updated = { ...lobby, revision: lobby.revision + 1, registration: { revision, atEpochMs: command.atEpochMs, closed: false } };
    return { lobby: closeRegistrationIfDue(updated, now), rejection: null };
}
