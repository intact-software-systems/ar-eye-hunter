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
                admissionWindow: makeSeatWindow(generation, nowEpochMs, lobby.policy.claimWindowMs) }];
        }
        else if (command.kind === 'away' && existing?.present) {
            seats = updateSeat(seats, { ...existing, present: false });
        }
        else if (command.kind === 'release' && existing) {
            seats = seats.filter(seat => seat !== existing);
        }
    }
    if (seats === lobby.seats) return { lobby, rejection };
    requireEpoch(generation, 'Lobby revision');
    return { lobby: reconcileReturnWindows({ ...lobby, revision: generation, seats }, nowEpochMs), rejection };
}

export function configureRoomLobby(
    lobby: RoomLobby, { capacity, policy }: Pick<RoomLobby, 'capacity' | 'policy'>, nowEpochMs: number
): RoomLobby.Change {
    requireEpoch(nowEpochMs, 'Lobby time');
    requireEpoch(capacity, 'Lobby capacity');
    if (capacity === 0) throw new TypeError('Lobby capacity must be positive');
    const selected = decodeRoomLobbyPolicy(policy);
    const seats = settleDueSeats(lobby, nowEpochMs);
    const full = seats.length > capacity;
    const unchanged = lobby.capacity === capacity && lobby.policy.returnWindowMs === selected.returnWindowMs &&
        lobby.policy.claimWindowMs === selected.claimWindowMs;
    if (seats === lobby.seats && (full || unchanged)) return { lobby, rejection: full ? 'full' : null };
    const revision = lobby.revision + 1;
    requireEpoch(revision, 'Lobby revision');
    if (full) return { lobby: { ...lobby, revision, seats }, rejection: 'full' };
    return { lobby: reconcileReturnWindows({ ...lobby, revision, seats, capacity, policy: selected }, nowEpochMs), rejection: null };
}
