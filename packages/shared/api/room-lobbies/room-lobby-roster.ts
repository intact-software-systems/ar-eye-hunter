import { allocateLobbyPlaces, occupiedLobbyPlaces } from './room-lobby-allocation.ts';
import { requireEpoch, requireString } from '../exact-object-decoding.ts';
import { decodeRoomLobbyPolicy } from './room-lobby-policy.ts';
import type { RoomLobby } from './room-lobby.ts';

import { makeSeatWindow, reconcileReturnWindows, settleDueSeats } from './room-lobby-windows.ts';

function updateSeat(seats: readonly RoomLobby.Seat[], seat: RoomLobby.Seat): readonly RoomLobby.Seat[] {
    return seats.some(current => current.principalId === seat.principalId)
        ? seats.map(current => current.principalId === seat.principalId ? seat : current)
        : [...seats, seat];
}

export function changeRoomLobby(lobby: RoomLobby, command: RoomLobby.Command, nowEpochMs: number): RoomLobby.Change {
    requireEpoch(nowEpochMs, 'Lobby time');
    if (command.kind === 'expire' && (command.dueAtEpochMs > nowEpochMs || !lobby.seats.some(seat => {
        const window = seat.admissionWindow ?? seat.returnWindow ?? seat.offerWindow;
        return window?.generation === command.generation && window.dueAtEpochMs === command.dueAtEpochMs;
    }) && !(command.generation === lobby.capacityClaims?.generation && command.dueAtEpochMs === lobby.capacityClaims.dueAtEpochMs) && !lobby.waiters.some(waiter => waiter.generation === command.generation && waiter.eligibleUntilEpochMs === command.dueAtEpochMs))) {
        return { lobby, rejection: null };
    }

    const generation = lobby.revision + 1;
    const allocated = allocateLobbyPlaces(lobby, nowEpochMs, generation);
    let { seats, waiters } = allocated;
    let rejection: RoomLobby.Change['rejection'] = null;
    if (command.kind !== 'expire') {
        requireString(command.principalId, 'Lobby seat account');
        const existing = seats.find(seat => seat.principalId === command.principalId);
        const prior = lobby.seats.find(seat => seat.principalId === command.principalId);
        const waiter = waiters.find(candidate => candidate.principalId === command.principalId);
        if (command.kind === 'limit') {
            const until = command.eligibleUntilEpochMs;
            requireEpoch(until, 'Lobby eligibility deadline');
            if (waiter && (waiter.eligibleUntilEpochMs === null || until < waiter.eligibleUntilEpochMs)) {
                waiters = waiters.map(candidate => candidate === waiter ? { ...waiter, eligibleUntilEpochMs: until } : candidate);
            }
            if (existing?.offerWindow && until < existing.offerWindow.dueAtEpochMs) {
                seats = updateSeat(seats, { ...existing, offerWindow: { generation, dueAtEpochMs: until } });
            }
        }
        else if (command.kind === 'wait') {
            if (command.eligibleUntilEpochMs !== null) requireEpoch(command.eligibleUntilEpochMs, 'Lobby eligibility deadline');
            if (!existing && !waiter) {
                if (command.eligibleUntilEpochMs !== null && command.eligibleUntilEpochMs <= nowEpochMs) rejection = 'eligibility-expired';
                else waiters = [...waiters, { principalId: command.principalId, eligibleUntilEpochMs: command.eligibleUntilEpochMs, generation }];
            }
        }
        else if (command.kind === 'release' && waiter) {
            waiters = waiters.filter(candidate => candidate !== waiter);
        }
        else if ((command.kind === 'arrive' || (command.kind === 'reserve' && prior?.offerWindow)) && prior && !existing) {
            rejection = (prior.admissionWindow || prior.offerWindow) ? 'admission-expired' : 'return-expired';
        }
        else if (!existing && (command.kind === 'arrive' || command.kind === 'reserve') && !allocated.capacityClaims?.principalIds.includes(command.principalId) && occupiedLobbyPlaces(seats, allocated.capacityClaims).size >= lobby.capacity) {
            rejection = 'full';
        }
        else if (command.kind === 'arrive' && !existing?.present) {
            seats = updateSeat(seats, { principalId: command.principalId, present: true, admissionWindow: null, returnWindow: null, offerWindow: null });
        }
        else if (command.kind === 'reserve' && !existing) {
            seats = [...seats, { principalId: command.principalId, present: false, returnWindow: null, offerWindow: null,
                admissionWindow: makeSeatWindow(generation, nowEpochMs, lobby.policy.claimWindowMs) }];
        }
        else if (command.kind === 'away' && existing?.present) {
            seats = updateSeat(seats, { ...existing, present: false });
        }
        else if (command.kind === 'release' && existing) {
            seats = seats.filter(seat => seat !== existing);
        }
    }
    if (allocated === lobby && seats === lobby.seats && waiters === lobby.waiters) return { lobby, rejection };
    requireEpoch(generation, 'Lobby revision');
    return { lobby: reconcileReturnWindows(allocateLobbyPlaces({ ...allocated, revision: generation, seats, waiters }, nowEpochMs, generation), nowEpochMs), rejection };
}

export function configureRoomLobby(
    lobby: RoomLobby, { capacity, policy }: Pick<RoomLobby, 'capacity' | 'policy'>, nowEpochMs: number
): RoomLobby.Change {
    requireEpoch(nowEpochMs, 'Lobby time');
    requireEpoch(capacity, 'Lobby capacity');
    if (capacity === 0) throw new TypeError('Lobby capacity must be positive');
    const selected = decodeRoomLobbyPolicy(policy);
    const seats = settleDueSeats(lobby, nowEpochMs);
    const full = occupiedLobbyPlaces(seats, lobby.capacityClaims && lobby.capacityClaims.dueAtEpochMs > nowEpochMs ? lobby.capacityClaims : null).size > capacity;
    const unchanged = lobby.capacity === capacity && lobby.policy.returnWindowMs === selected.returnWindowMs &&
        lobby.policy.claimWindowMs === selected.claimWindowMs;
    const settled = allocateLobbyPlaces({ ...lobby, seats, capacity: full ? lobby.capacity : capacity, policy: full ? lobby.policy : selected }, nowEpochMs, lobby.revision + 1);
    if (settled.seats === lobby.seats && settled.waiters === lobby.waiters && settled.capacityClaims === lobby.capacityClaims && (full || unchanged)) return { lobby, rejection: full ? 'full' : null };
    const revision = lobby.revision + 1;
    requireEpoch(revision, 'Lobby revision');
    return { lobby: reconcileReturnWindows({ ...settled, revision }, nowEpochMs), rejection: full ? 'full' : null };
}
