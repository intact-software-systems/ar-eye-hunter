import { changeRegistration } from './room-lobby-registration.ts';
import { changeLobbyWait } from './change-lobby-wait.ts';
import { allocateLobbyPlaces, occupiedLobbyPlaces } from './room-lobby-allocation.ts';
import { requireEpoch, requireString } from '../exact-object-decoding.ts';
import type { RoomLobby } from './room-lobby.ts';

import { lobbyWindows, makeSeatWindow, reconcileReturnWindows } from './room-lobby-windows.ts';

function updateSeat(seats: readonly RoomLobby.Seat[], seat: RoomLobby.Seat): readonly RoomLobby.Seat[] {
    return seats.some(current => current.principalId === seat.principalId)
        ? seats.map(current => current.principalId === seat.principalId ? seat : current)
        : [...seats, seat];
}

export function changeRoomLobby(lobby: RoomLobby, command: RoomLobby.Command, nowEpochMs: number): RoomLobby.Change {
    requireEpoch(nowEpochMs, 'Lobby time');
    if (command.kind === 'set-registration-cutoff' || command.kind === 'close-registration') return changeRegistration(lobby, command, nowEpochMs);
    if (command.kind === 'expire' && (command.dueAtEpochMs > nowEpochMs ||
        !lobbyWindows(lobby).has(JSON.stringify([command.generation, command.dueAtEpochMs])))) {
        return { lobby, rejection: null };
    }

    const generation = lobby.revision + 1;
    const allocated = allocateLobbyPlaces(lobby, nowEpochMs, generation);
    let { seats, waiters } = allocated;
    let rejection: RoomLobby.Change['rejection'] = null;
    if (command.kind !== 'expire') {
        requireString(command.principalId, 'Lobby seat account');
        const existing = seats.find(seat => seat.principalId === command.principalId);
        const reservedPlace = allocated.capacityClaims?.principalIds.includes(command.principalId);
        const prior = lobby.seats.find(seat => seat.principalId === command.principalId);
        const waiter = waiters.find(candidate => candidate.principalId === command.principalId);
        if (command.kind === 'wait' || command.kind === 'limit') {
            const queued = changeLobbyWait(allocated, command, nowEpochMs);
            seats = queued.lobby.seats;
            waiters = queued.lobby.waiters;
            rejection = queued.rejection;
        }
        else if (command.kind === 'release' && waiter) {
            waiters = waiters.filter(candidate => candidate !== waiter);
        }
        else if (!existing && !reservedPlace && allocated.registration.closed && (command.kind === 'reserve' || command.kind === 'arrive')) {
            rejection = 'registration-closed';
        }
        else if ((command.kind === 'arrive' || (command.kind === 'reserve' && prior?.offerWindow)) && prior && !existing) {
            rejection = (prior.admissionWindow || prior.offerWindow) ? 'admission-expired' : 'return-expired';
        }
        else if (!existing && (command.kind === 'arrive' || command.kind === 'reserve') && !reservedPlace && occupiedLobbyPlaces(seats, allocated.capacityClaims).size >= lobby.capacity) {
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
