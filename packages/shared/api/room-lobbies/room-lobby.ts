import { decodeExactGroupRef } from '../../encoding/decode-exact-group-ref.ts';
import type { ApiJsonObject } from '../api-json-value.ts';
import { isSameGroupScope } from '../api-type-utils.ts';
import { requireEpoch, requireExactKeys, requireOneOf, requireRecord, requireString } from '../exact-object-decoding.ts';
import type { GroupRef } from '../group-types.ts';
import { decodeStateScope, type StateScope } from '../state-types.ts';

export namespace RoomLobby {
    export interface Policy {
        readonly returnWindowMs: number;
        readonly claimWindowMs: number;
    }
    export interface ReturnWindow {
        readonly generation: number;
        readonly dueAtEpochMs: number;
    }
    export interface Seat {
        readonly principalId: string;
        readonly present: boolean;
        readonly admissionWindow: ReturnWindow | null;
        readonly returnWindow: ReturnWindow | null;
    }
    export type Command =
        | { readonly kind: 'reserve' | 'arrive' | 'away' | 'release'; readonly principalId: string; }
        | ({ readonly kind: 'expire'; } & ReturnWindow);
    export interface Change {
        readonly lobby: RoomLobby;
        readonly rejection: 'full' | 'return-expired' | 'admission-expired' | null;
    }
}

export interface RoomLobby {
    readonly roomRef: GroupRef;
    readonly capacity: number;
    readonly policy: RoomLobby.Policy;
    readonly revision: number;
    readonly seats: readonly RoomLobby.Seat[];
}

export interface RoomLobbyAccountView {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly seat: {
        readonly roomRef: GroupRef;
        readonly status: 'arriving' | 'present' | 'away';
        readonly deadlineEpochMs: number | null;
    } | null;
}

export const DEFAULT_ROOM_LOBBY_POLICY: RoomLobby.Policy = Object.freeze({ returnWindowMs: 120000, claimWindowMs: 60000 });
export const ROOM_LOBBY_METADATA_KEY = 'rallarRoomLobby';

function positiveInteger(value: unknown, label: string): number {
    requireEpoch(value, label);
    if (value === 0) throw new TypeError(`${label} must be positive`);
    return value;
}

export function decodeRoomLobbyPolicy(value: unknown): RoomLobby.Policy {
    const policy = requireRecord(value, 'Room lobby policy');
    requireExactKeys(policy, ['returnWindowMs', 'claimWindowMs'], 'Room lobby policy');
    return {
        returnWindowMs: positiveInteger(policy.returnWindowMs, 'Return duration'),
        claimWindowMs: positiveInteger(policy.claimWindowMs, 'Claim duration')
    };
}

export function roomLobbyApplicationDefault(
    policies: Readonly<Record<string, RoomLobby.Policy>> | undefined,
    applicationId: string
): RoomLobby.Policy | undefined {
    return policies && Object.hasOwn(policies, applicationId) ? policies[applicationId] : undefined;
}

export function readRoomLobbyPolicy(metadata: ApiJsonObject): RoomLobby.Policy | null {
    return Object.hasOwn(metadata, ROOM_LOBBY_METADATA_KEY) ? decodeRoomLobbyPolicy(metadata[ROOM_LOBBY_METADATA_KEY]) : null;
}

export function createRoomLobby(roomRef: GroupRef, capacity: number, policy: RoomLobby.Policy): RoomLobby {
    return {
        roomRef: decodeExactGroupRef(roomRef, 'Room lobby'), capacity: positiveInteger(capacity, 'Lobby capacity'),
        policy: decodeRoomLobbyPolicy(policy), revision: 0, seats: []
    };
}

function decodeWindow(value: unknown, revision: number): RoomLobby.ReturnWindow | null {
    if (value === null) return null;
    const window = requireRecord(value, 'Seat window');
    requireExactKeys(window, ['generation', 'dueAtEpochMs'], 'Seat window');
    const generation = positiveInteger(window.generation, 'Seat window generation');
    if (generation > revision) throw new TypeError('Seat window is newer than lobby revision');
    requireEpoch(window.dueAtEpochMs, 'Seat deadline');
    return { generation, dueAtEpochMs: window.dueAtEpochMs };
}

export function decodeRoomLobby(value: unknown): RoomLobby {
    const record = requireRecord(value, 'Room lobby');
    requireExactKeys(record, ['roomRef', 'capacity', 'policy', 'revision', 'seats'], 'Room lobby');
    const roomRef = decodeExactGroupRef(record.roomRef, 'Room lobby');
    const capacity = positiveInteger(record.capacity, 'Lobby capacity');
    const policy = decodeRoomLobbyPolicy(record.policy);
    const revision = record.revision;
    requireEpoch(revision, 'Lobby revision');
    if (!Array.isArray(record.seats) || record.seats.length > capacity || (revision === 0 && record.seats.length > 0)) {
        throw new TypeError('Invalid lobby occupancy');
    }
    const principals = new Set<string>();
    const seats = record.seats.map((value): RoomLobby.Seat => {
        const seat = requireRecord(value, 'Lobby seat');
        requireExactKeys(seat, ['principalId', 'present', 'admissionWindow', 'returnWindow'], 'Lobby seat');
        requireString(seat.principalId, 'Lobby seat account');
        if (principals.has(seat.principalId) || typeof seat.present !== 'boolean') throw new TypeError('Invalid lobby seat');
        principals.add(seat.principalId);
        const admissionWindow = decodeWindow(seat.admissionWindow, revision);
        const returnWindow = decodeWindow(seat.returnWindow, revision);
        if (admissionWindow && (seat.present || returnWindow) || seat.present && returnWindow) {
            throw new TypeError('Invalid lobby seat windows');
        }
        return { principalId: seat.principalId, present: seat.present, admissionWindow, returnWindow };
    });
    const full = seats.filter(seat => seat.admissionWindow === null).length === capacity;
    if (seats.some(seat => (seat.returnWindow !== null) !== (full && !seat.present))) {
        throw new TypeError('Return windows require a full roster');
    }
    return { roomRef, capacity, policy, revision, seats };
}

function makeWindow(generation: number, now: number, duration: number): RoomLobby.ReturnWindow {
    const dueAtEpochMs = now + duration;
    requireEpoch(dueAtEpochMs, 'Seat deadline');
    return { generation: positiveInteger(generation, 'Lobby revision'), dueAtEpochMs };
}

/** At the first return expiry the roster reopens. Equally due holders lose their seats together;
 * every later return window is cancelled, even if a delayed worker observes several deadlines. */
function settleDueSeats(lobby: RoomLobby, now: number): readonly RoomLobby.Seat[] {
    let firstDueReturn = Infinity;
    for (const seat of lobby.seats) {
        if (seat.returnWindow && seat.returnWindow.dueAtEpochMs <= now) {
            firstDueReturn = Math.min(firstDueReturn, seat.returnWindow.dueAtEpochMs);
        }
    }
    const remaining = lobby.seats.filter(seat =>
        !(seat.admissionWindow && seat.admissionWindow.dueAtEpochMs <= now) &&
        seat.returnWindow?.dueAtEpochMs !== firstDueReturn);
    if (remaining.length === lobby.seats.length) return lobby.seats;
    return remaining.map(seat => seat.returnWindow ? { ...seat, returnWindow: null } : seat);
}

function updateSeat(seats: readonly RoomLobby.Seat[], seat: RoomLobby.Seat): readonly RoomLobby.Seat[] {
    return seats.some(current => current.principalId === seat.principalId)
        ? seats.map(current => current.principalId === seat.principalId ? seat : current)
        : [...seats, seat];
}

export function changeRoomLobby(lobby: RoomLobby, command: RoomLobby.Command, nowEpochMs: number): RoomLobby.Change {
    requireEpoch(nowEpochMs, 'Lobby time');
    if (command.kind === 'expire' && (command.dueAtEpochMs > nowEpochMs || !lobby.seats.some(seat => {
        const window = seat.admissionWindow ?? seat.returnWindow;
        return window?.generation === command.generation && window.dueAtEpochMs === command.dueAtEpochMs;
    }))) return { lobby, rejection: null };

    const generation = lobby.revision + 1;
    let seats = settleDueSeats(lobby, nowEpochMs);
    let rejection: RoomLobby.Change['rejection'] = null;
    if (command.kind !== 'expire') {
        requireString(command.principalId, 'Lobby seat account');
        const existing = seats.find(seat => seat.principalId === command.principalId);
        const prior = lobby.seats.find(seat => seat.principalId === command.principalId);
        if (command.kind === 'arrive' && prior && !existing) {
            rejection = prior.admissionWindow ? 'admission-expired' : 'return-expired';
        }
        else if (!existing && (command.kind === 'arrive' || command.kind === 'reserve') && seats.length >= lobby.capacity) {
            rejection = 'full';
        }
        else if (command.kind === 'arrive' && !existing?.present) {
            seats = updateSeat(seats, { principalId: command.principalId, present: true, admissionWindow: null, returnWindow: null });
        }
        else if (command.kind === 'reserve' && !existing) {
            seats = [...seats, { principalId: command.principalId, present: false, returnWindow: null,
                admissionWindow: makeWindow(generation, nowEpochMs, lobby.policy.claimWindowMs) }];
        }
        else if (command.kind === 'away' && existing?.present) {
            seats = updateSeat(seats, { ...existing, present: false });
        }
        else if (command.kind === 'release' && existing) {
            seats = seats.filter(seat => seat !== existing);
        }
    }
    if (seats === lobby.seats) return { lobby, rejection };
    positiveInteger(generation, 'Lobby revision');
    const full = seats.filter(seat => seat.admissionWindow === null).length === lobby.capacity;
    const roster = seats.map(seat => {
        if (!full && seat.returnWindow) return { ...seat, returnWindow: null };
        if (full && !seat.present && !seat.returnWindow) {
            return { ...seat, returnWindow: makeWindow(generation, nowEpochMs, lobby.policy.returnWindowMs) };
        }
        return seat;
    });
    return { lobby: { ...lobby, revision: generation, seats: roster }, rejection };
}

export function projectRoomLobbyAccount(scope: StateScope, principalId: string, lobby: RoomLobby | null): RoomLobbyAccountView {
    if (lobby && !isSameGroupScope(lobby.roomRef, scope)) throw new TypeError('Room lobby is outside the account scope');
    const own = lobby?.seats.find(seat => seat.principalId === principalId);
    return {
        scope, principalId,
        seat: own && lobby ? {
            roomRef: lobby.roomRef, status: own.present ? 'present' : own.admissionWindow ? 'arriving' : 'away',
            deadlineEpochMs: (own.admissionWindow ?? own.returnWindow)?.dueAtEpochMs ?? null
        } : null
    };
}

export function decodeRoomLobbyAccountView(value: unknown): RoomLobbyAccountView {
    const view = requireRecord(value, 'Room lobby account view');
    requireExactKeys(view, ['scope', 'principalId', 'seat'], 'Room lobby account view');
    const scope = decodeStateScope(view.scope);
    requireString(view.principalId, 'Lobby account');
    if (view.seat === null) return { scope, principalId: view.principalId, seat: null };
    const seat = requireRecord(view.seat, 'Private lobby seat');
    requireExactKeys(seat, ['roomRef', 'status', 'deadlineEpochMs'], 'Private lobby seat');
    const roomRef = decodeExactGroupRef(seat.roomRef, 'Private lobby seat');
    if (!isSameGroupScope(roomRef, scope)) throw new TypeError('Lobby seat is outside account scope');
    const status = requireOneOf(seat.status, ['present', 'arriving', 'away'], 'Lobby seat status');
    const deadlineEpochMs = seat.deadlineEpochMs;
    if (deadlineEpochMs !== null) requireEpoch(deadlineEpochMs, 'Lobby seat deadline');
    if ((status === 'present' && deadlineEpochMs !== null) || (status === 'arriving' && deadlineEpochMs === null)) {
        throw new TypeError('Invalid deadline for lobby seat status');
    }
    return { scope, principalId: view.principalId, seat: { roomRef, status, deadlineEpochMs } };
}
