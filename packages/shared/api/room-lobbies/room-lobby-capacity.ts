import { requireEpoch, requireExactKeys, requireRecord, requireString } from '../exact-object-decoding.ts';
import { allocateLobbyPlaces, occupiedLobbyPlaces } from './room-lobby-allocation.ts';
import { decodePositiveLobbyInteger, decodeRoomLobbyPolicy } from './room-lobby-policy.ts';
import { reconcileReturnWindows, settleDueSeats } from './room-lobby-windows.ts';
import type { RoomLobby } from './room-lobby.ts';

export function decodeCapacityClaims(value: unknown, revision: number, capacity: number): RoomLobby.CapacityClaims | null {
    if (value === null) return null;
    const claims = requireRecord(value, 'Capacity claims');
    requireExactKeys(claims, ['generation', 'dueAtEpochMs', 'principalIds'], 'Capacity claims');
    const generation = decodePositiveLobbyInteger(claims.generation, 'Capacity claim generation');
    requireEpoch(claims.dueAtEpochMs, 'Capacity claim expiry');
    if (generation > revision || !Array.isArray(claims.principalIds) || !claims.principalIds.length || claims.principalIds.length > capacity) {
        throw new TypeError('Invalid lobby capacity claims');
    }
    const principalIds = claims.principalIds.map(id => {
        requireString(id, 'Capacity claim account');
        return id;
    });
    if (principalIds.some((id, index) => index > 0 && principalIds[index - 1] >= id)) throw new TypeError('Invalid capacity claim order');
    return { principalIds, generation, dueAtEpochMs: claims.dueAtEpochMs };
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
    if (settled.seats === lobby.seats && settled.waiters === lobby.waiters && settled.registration === lobby.registration && settled.capacityClaims === lobby.capacityClaims && (full || unchanged)) return { lobby, rejection: full ? 'full' : null };
    const revision = lobby.revision + 1;
    requireEpoch(revision, 'Lobby revision');
    return { lobby: reconcileReturnWindows({ ...settled, revision }, nowEpochMs), rejection: full ? 'full' : null };
}
