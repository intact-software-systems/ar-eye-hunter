import { decodeExactGroupRef } from '../../encoding/decode-exact-group-ref.ts';
import { isSameGroupScope } from '../api-type-utils.ts';
import { requireEpoch, requireExactKeys, requireOneOf, requireRecord, requireString } from '../exact-object-decoding.ts';
import type { GroupRef } from '../group-types.ts';
import { decodeStateScope, type StateScope } from '../state-types.ts';

import { decodePositiveLobbyInteger, decodeRoomLobbyPolicy } from './room-lobby-policy.ts';

export {
    ROOM_LOBBY_METADATA_KEY, decodeRoomLobbyPolicy, readRoomLobbyPolicy, roomLobbyApplicationDefault
} from './room-lobby-policy.ts';
export { configureRoomLobbyCapacityClaims } from './room-lobby-allocation.ts';
export { changeRoomLobby, configureRoomLobby } from './room-lobby-roster.ts';

export namespace RoomLobby {
    export interface Policy {
        readonly returnWindowMs: number;
        readonly claimWindowMs: number;
    }
    export interface ReturnWindow {
        readonly generation: number;
        readonly dueAtEpochMs: number;
    }
    export interface CapacityClaims extends ReturnWindow {
        readonly principalIds: readonly string[];
    }
    export interface Waiter {
        readonly principalId: string;
        readonly eligibleUntilEpochMs: number | null;
        readonly generation: number;
    }
    export interface Seat {
        readonly offerWindow: ReturnWindow | null;
        readonly principalId: string;
        readonly present: boolean;
        readonly admissionWindow: ReturnWindow | null;
        readonly returnWindow: ReturnWindow | null;
    }
    export type Command =
        | { readonly kind: 'reserve' | 'arrive' | 'away' | 'release'; readonly principalId: string; }
        | { readonly kind: 'wait'; readonly principalId: string; readonly eligibleUntilEpochMs: number | null; }
        | ({ readonly kind: 'expire'; } & ReturnWindow);
    export interface Change {
        readonly lobby: RoomLobby;
        readonly rejection: 'full' | 'return-expired' | 'admission-expired' | 'eligibility-expired' | null;
    }
}

export interface RoomLobby {
    readonly activationId: string;
    readonly expiresAtEpochMs: number | null;
    readonly roomRef: GroupRef;
    readonly capacity: number;
    readonly policy: RoomLobby.Policy;
    readonly revision: number;
    readonly seats: readonly RoomLobby.Seat[];
    readonly waiters: readonly RoomLobby.Waiter[];
    readonly capacityClaims: RoomLobby.CapacityClaims | null;
}

export interface RoomLobbyAccountView {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly seat: {
        readonly roomRef: GroupRef;
        readonly status: 'waiting' | 'offered' | 'arriving' | 'present' | 'away';
        readonly deadlineEpochMs: number | null;
    } | null;
}

export function createRoomLobby(roomRef: GroupRef, capacity: number, policy: RoomLobby.Policy, activationId: string, expiresAtEpochMs: number | null = null): RoomLobby {
    if (expiresAtEpochMs !== null) requireEpoch(expiresAtEpochMs, 'Lobby expiry');
    requireString(activationId, 'Room lobby activation');
    return {
        activationId, expiresAtEpochMs, roomRef: decodeExactGroupRef(roomRef, 'Room lobby'), capacity: decodePositiveLobbyInteger(capacity, 'Lobby capacity'),
        policy: decodeRoomLobbyPolicy(policy), revision: 0, seats: [], waiters: [], capacityClaims: null
    };
}

function decodeWindow(value: unknown, revision: number): RoomLobby.ReturnWindow | null {
    if (value === null) return null;
    const window = requireRecord(value, 'Seat window');
    requireExactKeys(window, ['generation', 'dueAtEpochMs'], 'Seat window');
    const generation = decodePositiveLobbyInteger(window.generation, 'Seat window generation');
    if (generation > revision) throw new TypeError('Seat window is newer than lobby revision');
    requireEpoch(window.dueAtEpochMs, 'Seat deadline');
    return { generation, dueAtEpochMs: window.dueAtEpochMs };
}

function decodeCapacityClaims(value: unknown, revision: number, capacity: number): RoomLobby.CapacityClaims | null {
    if (value === null) return null;
    const claims = requireRecord(value, 'Capacity claims');
    requireExactKeys(claims, ['generation', 'dueAtEpochMs', 'principalIds'], 'Capacity claims');
    const generation = decodePositiveLobbyInteger(claims.generation, 'Capacity claim generation');
    requireEpoch(claims.dueAtEpochMs, 'Capacity claim expiry');
    if (generation > revision || !Array.isArray(claims.principalIds) || !claims.principalIds.length || claims.principalIds.length > capacity) {
        throw new TypeError('Invalid lobby capacity claims');
    }
    const principalIds = claims.principalIds.map((id: unknown) => {
        requireString(id, 'Capacity claim account');
        return id;
    });
    if (principalIds.some((id, index) => index > 0 && principalIds[index - 1] >= id)) throw new TypeError('Invalid capacity claim order');
    return { principalIds, generation, dueAtEpochMs: claims.dueAtEpochMs };
}

export function decodeRoomLobby(value: unknown): RoomLobby {
    const record = requireRecord(value, 'Room lobby');
    requireExactKeys(record, ['activationId', 'expiresAtEpochMs', 'roomRef', 'capacity', 'policy', 'revision', 'seats', 'waiters', 'capacityClaims'], 'Room lobby');
    const expiresAtEpochMs = record.expiresAtEpochMs;
    if (expiresAtEpochMs !== null) requireEpoch(expiresAtEpochMs, 'Lobby expiry');
    requireString(record.activationId, 'Room lobby activation');
    const roomRef = decodeExactGroupRef(record.roomRef, 'Room lobby');
    const capacity = decodePositiveLobbyInteger(record.capacity, 'Lobby capacity');
    const policy = decodeRoomLobbyPolicy(record.policy);
    const revision = record.revision;
    requireEpoch(revision, 'Lobby revision');
    if (!Array.isArray(record.seats) || record.seats.length > capacity || (revision === 0 && record.seats.length > 0)) {
        throw new TypeError('Invalid lobby occupancy');
    }
    const principals = new Set<string>();
    const seats = record.seats.map((value): RoomLobby.Seat => {
        const seat = requireRecord(value, 'Lobby seat');
        requireExactKeys(seat, ['principalId', 'present', 'admissionWindow', 'returnWindow', 'offerWindow'], 'Lobby seat');
        requireString(seat.principalId, 'Lobby seat account');
        if (principals.has(seat.principalId) || typeof seat.present !== 'boolean') throw new TypeError('Invalid lobby seat');
        principals.add(seat.principalId);
        const admissionWindow = decodeWindow(seat.admissionWindow, revision);
        const returnWindow = decodeWindow(seat.returnWindow, revision);
        const offerWindow = decodeWindow(seat.offerWindow, revision);
        if ([admissionWindow, returnWindow, offerWindow, seat.present].filter(Boolean).length > 1) {
            throw new TypeError('Invalid lobby seat windows');
        }
        return { principalId: seat.principalId, present: seat.present, admissionWindow, returnWindow, offerWindow };
    });
    const full = seats.filter(seat => seat.admissionWindow === null && seat.offerWindow === null).length === capacity;
    if (seats.some(seat => (seat.returnWindow !== null) !== (full && !seat.present))) {
        throw new TypeError('Return windows require a full roster');
    }
    const capacityClaims = decodeCapacityClaims(record.capacityClaims, revision, capacity);
    const occupied = new Set([...principals, ...(capacityClaims?.principalIds ?? [])]);
    if (occupied.size > capacity || !Array.isArray(record.waiters) || (record.waiters.length && occupied.size !== capacity)) {
        throw new TypeError('Invalid lobby queue');
    }
    let previousGeneration = 0;
    const waiters = record.waiters.map((value): RoomLobby.Waiter => {
        const waiter = requireRecord(value, 'Lobby waiter');
        requireExactKeys(waiter, ['principalId', 'eligibleUntilEpochMs', 'generation'], 'Lobby waiter');
        requireString(waiter.principalId, 'Waiting account');
        const eligibleUntilEpochMs = waiter.eligibleUntilEpochMs;
        if (eligibleUntilEpochMs !== null) requireEpoch(eligibleUntilEpochMs, 'Lobby eligibility deadline');
        const generation = decodePositiveLobbyInteger(waiter.generation, 'Waiter generation');
        if (occupied.has(waiter.principalId) || principals.has(waiter.principalId) || generation > revision || generation <= previousGeneration) {
            throw new TypeError('Invalid lobby queue order or duplicate account');
        }
        previousGeneration = generation;
        principals.add(waiter.principalId);
        return { principalId: waiter.principalId, generation, eligibleUntilEpochMs };
    });
    return { activationId: record.activationId, expiresAtEpochMs, roomRef, capacity, policy, revision, seats, waiters, capacityClaims };
}

export function projectRoomLobbySeat(roomRef: GroupRef, seat: RoomLobby.Seat | undefined, waiting = false): RoomLobbyAccountView['seat'] {
    if (!seat) return waiting ? { roomRef, status: 'waiting', deadlineEpochMs: null } : null;
    return {
        roomRef, status: seat.offerWindow ? 'offered' : seat.present ? 'present' : seat.admissionWindow ? 'arriving' : 'away',
        deadlineEpochMs: (seat.offerWindow ?? seat.admissionWindow ?? seat.returnWindow)?.dueAtEpochMs ?? null
    };
}

export function projectRoomLobbyAccount(scope: StateScope, principalId: string, lobby: RoomLobby | null): RoomLobbyAccountView {
    if (lobby && !isSameGroupScope(lobby.roomRef, scope)) throw new TypeError('Room lobby is outside the account scope');
    return { scope, principalId, seat: lobby ? projectRoomLobbySeat(lobby.roomRef, lobby.seats.find(seat => seat.principalId === principalId), lobby.waiters.some(waiter => waiter.principalId === principalId)) : null };
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
    const status = requireOneOf(seat.status, ['present', 'arriving', 'away', 'waiting', 'offered'], 'Lobby seat status');
    const deadlineEpochMs = seat.deadlineEpochMs;
    if (deadlineEpochMs !== null) requireEpoch(deadlineEpochMs, 'Lobby seat deadline');
    if (((status === 'present' || status === 'waiting') && deadlineEpochMs !== null) || ((status === 'arriving' || status === 'offered') && deadlineEpochMs === null)) {
        throw new TypeError('Invalid deadline for lobby seat status');
    }
    return { scope, principalId: view.principalId, seat: { roomRef, status, deadlineEpochMs } };
}
