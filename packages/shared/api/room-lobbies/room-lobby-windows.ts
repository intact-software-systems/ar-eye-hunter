import { requireEpoch } from '../exact-object-decoding.ts';
import type { RoomLobby } from './room-lobby.ts';

export function makeSeatWindow(generation: number, now: number, duration: number): RoomLobby.ReturnWindow {
    const dueAtEpochMs = now + duration;
    requireEpoch(dueAtEpochMs, 'Seat deadline');
    return { generation, dueAtEpochMs };
}

/** At the first return expiry the roster reopens. Equally due holders lose their seats together;
 * every later return window is cancelled, even if a delayed worker observes several deadlines. */
export function settleDueSeats(lobby: RoomLobby, now: number): readonly RoomLobby.Seat[] {
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

export function reconcileReturnWindows(lobby: RoomLobby, nowEpochMs: number): RoomLobby {
    const { seats, capacity, policy, revision } = lobby;
    const full = seats.filter(seat => seat.admissionWindow === null).length === capacity;
    const roster = seats.map(seat => {
        if (!full && seat.returnWindow) return { ...seat, returnWindow: null };
        if (full && !seat.present && !seat.returnWindow) {
            return { ...seat, returnWindow: makeSeatWindow(revision, nowEpochMs, policy.returnWindowMs) };
        }
        return seat;
    });
    return { ...lobby, seats: roster };
}
