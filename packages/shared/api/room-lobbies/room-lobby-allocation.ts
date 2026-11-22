import { requireEpoch, requireString } from '../exact-object-decoding.ts';
import { makeSeatWindow, reconcileReturnWindows, settleDueSeats } from './room-lobby-windows.ts';
import type { RoomLobby } from './room-lobby.ts';

export function occupiedLobbyPlaces(seats: readonly RoomLobby.Seat[], claims: RoomLobby['capacityClaims']): Set<string> {
    return new Set([...seats.map(seat => seat.principalId), ...(claims?.principalIds ?? [])]);
}

/** Shared by admission, directory reads and deadline delivery. Expiry and exclusive allocation
 * are one decision: an unrelated walk-in cannot take the vacancy between them. */
export function allocateLobbyPlaces(lobby: RoomLobby, now: number, generation: number): RoomLobby {
    const seats = settleDueSeats(lobby, now);
    const claims = lobby.capacityClaims && lobby.capacityClaims.dueAtEpochMs <= now ? null : lobby.capacityClaims;
    const occupied = occupiedLobbyPlaces(seats, claims);
    const waiters: RoomLobby.Waiter[] = [];
    const offers: RoomLobby.Seat[] = [];
    for (const waiter of lobby.waiters) {
        if (waiter.eligibleUntilEpochMs !== null && waiter.eligibleUntilEpochMs <= now) continue;
        if (!occupied.has(waiter.principalId) && occupied.size >= lobby.capacity) {
            waiters.push(waiter);
            continue;
        }
        occupied.add(waiter.principalId);
        const window = makeSeatWindow(generation, now, lobby.policy.claimWindowMs);
        offers.push({
            principalId: waiter.principalId, present: false, admissionWindow: null, returnWindow: null,
            offerWindow: { generation, dueAtEpochMs: Math.min(window.dueAtEpochMs, waiter.eligibleUntilEpochMs ?? Infinity) }
        });
    }
    if (seats === lobby.seats && claims === lobby.capacityClaims && waiters.length === lobby.waiters.length) return lobby;
    return { ...lobby, capacityClaims: claims, seats: offers.length ? [...seats, ...offers] : seats,
        waiters: waiters.length === lobby.waiters.length ? lobby.waiters : waiters };
}

export function configureRoomLobbyCapacityClaims(
    lobby: RoomLobby, requested: Pick<RoomLobby.CapacityClaims, 'principalIds' | 'dueAtEpochMs'> | null, now: number
): RoomLobby.Change {
    requireEpoch(now, 'Lobby time');
    if (requested) requireEpoch(requested.dueAtEpochMs, 'Capacity claim expiry');
    const current = lobby.capacityClaims;
    const active = requested && requested.dueAtEpochMs > now && requested.principalIds.length ? requested : null;
    const principals = [...new Set(active?.principalIds ?? [])].sort();
    for (const id of principals) requireString(id, 'Capacity claim account');
    if (!active && !current || active && current && active.dueAtEpochMs === current.dueAtEpochMs &&
        principals.length === current.principalIds.length && principals.every((id, index) => id === current.principalIds[index])) {
        return { lobby, rejection: null };
    }
    const revision = lobby.revision + 1;
    requireEpoch(revision, 'Lobby revision');
    const capacityClaims = active ? { principalIds: principals, dueAtEpochMs: active.dueAtEpochMs, generation: revision } : null;
    const allocated = allocateLobbyPlaces({ ...lobby, capacityClaims, revision }, now, revision);
    if (occupiedLobbyPlaces(allocated.seats, capacityClaims).size > lobby.capacity) return { lobby, rejection: 'full' };
    return { lobby: reconcileReturnWindows(allocated, now), rejection: null };
}
