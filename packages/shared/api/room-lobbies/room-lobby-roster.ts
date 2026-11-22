import { requireEpoch, requireString } from '../exact-object-decoding.ts';
import { allocateLobbyPlaces, occupiedLobbyPlaces } from './room-lobby-allocation.ts';
import { decodeRoomLobbyPolicy } from './room-lobby-policy.ts';
import { changeRegistration } from './room-lobby-registration.ts';
import { makeSeatWindow, reconcileReturnWindows, settleDueSeats } from './room-lobby-windows.ts';
import type { RoomLobby } from './room-lobby.ts';

interface AccountPlaces {
    readonly principalId: string;
    readonly priorSeat: RoomLobby.Seat | undefined;
    readonly seat: RoomLobby.Seat | undefined;
    readonly waiter: RoomLobby.Waiter | undefined;
}

function withSeat(lobby: RoomLobby, seat: RoomLobby.Seat): RoomLobby {
    const seats = lobby.seats.some(current => current.principalId === seat.principalId)
        ? lobby.seats.map(current => current.principalId === seat.principalId ? seat : current)
        : [...lobby.seats, seat];
    return { ...lobby, seats };
}

function hasDueWindow(lobby: RoomLobby, wake: RoomLobby.ReturnWindow, now: number): boolean {
    if (wake.dueAtEpochMs > now) return false;
    const matches = (window: RoomLobby.ReturnWindow | null) =>
        window?.generation === wake.generation && window.dueAtEpochMs === wake.dueAtEpochMs;
    return matches(lobby.capacityClaims) ||
        lobby.seats.some(seat => matches(seat.admissionWindow ?? seat.returnWindow ?? seat.offerWindow)) ||
        lobby.waiters.some(waiter => waiter.generation === wake.generation && waiter.eligibleUntilEpochMs === wake.dueAtEpochMs);
}

export function changeRoomLobby(lobby: RoomLobby, command: RoomLobby.Command, now: number): RoomLobby.Change {
    requireEpoch(now, 'Lobby time');
    if (command.kind === 'set-registration-cutoff' || command.kind === 'close-registration') {
        return changeRegistration(lobby, command, now);
    }
    if (command.kind === 'expire' && !hasDueWindow(lobby, command, now)) return { lobby, rejection: null };
    const revision = lobby.revision + 1;
    const allocated = allocateLobbyPlaces(lobby, now, revision);
    const change = command.kind === 'expire'
        ? { lobby: allocated, rejection: null }
        : changeParticipation(allocated, lobby, command, now);
    if (change.lobby === lobby) return change;
    requireEpoch(revision, 'Lobby revision');
    const final = allocateLobbyPlaces({ ...change.lobby, revision }, now, revision);
    return { lobby: reconcileReturnWindows(final, now), rejection: change.rejection };
}

function changeParticipation(
    lobby: RoomLobby, before: RoomLobby, command: Extract<RoomLobby.Command, { principalId: string }>, now: number
): RoomLobby.Change {
    const { principalId } = command;
    requireString(principalId, 'Lobby seat account');
    const account: AccountPlaces = { principalId,
        priorSeat: before.seats.find(seat => seat.principalId === principalId),
        seat: lobby.seats.find(seat => seat.principalId === principalId),
        waiter: lobby.waiters.find(waiter => waiter.principalId === principalId) };
    switch (command.kind) {
        case 'wait': {
            const until = command.eligibleUntilEpochMs;
            if (until !== null) requireEpoch(until, 'Lobby eligibility deadline');
            if (account.seat || account.waiter) return { lobby, rejection: null };
            if (lobby.registration.closed) return { lobby, rejection: 'registration-closed' };
            if (until !== null && until <= now) return { lobby, rejection: 'eligibility-expired' };
            const waiter = { principalId, eligibleUntilEpochMs: until, generation: lobby.revision + 1 };
            return { lobby: { ...lobby, waiters: [...lobby.waiters, waiter] }, rejection: null };
        }
        case 'limit':
            return { lobby: shortenEligibility(lobby, account, command.eligibleUntilEpochMs), rejection: null };
        case 'away':
            return { lobby: account.seat?.present ? withSeat(lobby, { ...account.seat, present: false }) : lobby, rejection: null };
        case 'release':
            if (account.waiter) return { lobby: { ...lobby, waiters: lobby.waiters.filter(waiter => waiter !== account.waiter) }, rejection: null };
            if (account.seat) return { lobby: { ...lobby, seats: lobby.seats.filter(seat => seat !== account.seat) }, rejection: null };
            return { lobby, rejection: null };
        case 'arrive':
        case 'reserve':
            return takePlace(lobby, account, command.kind, now);
    }
}

function shortenEligibility(lobby: RoomLobby, { waiter, seat }: AccountPlaces, until: number): RoomLobby {
    requireEpoch(until, 'Lobby eligibility deadline');
    if (waiter && (waiter.eligibleUntilEpochMs === null || until < waiter.eligibleUntilEpochMs)) {
        return { ...lobby, waiters: lobby.waiters.map(current =>
            current === waiter ? { ...waiter, eligibleUntilEpochMs: until } : current) };
    }
    if (seat?.offerWindow && until < seat.offerWindow.dueAtEpochMs) {
        return withSeat(lobby, { ...seat, offerWindow: { generation: lobby.revision + 1, dueAtEpochMs: until } });
    }
    return lobby;
}

function takePlace(lobby: RoomLobby, account: AccountPlaces, kind: 'arrive' | 'reserve', now: number): RoomLobby.Change {
    const { principalId, seat, priorSeat } = account;
    if (seat && (seat.present || kind === 'reserve')) return { lobby, rejection: null };
    if (!seat) {
        if (lobby.registration.closed) return { lobby, rejection: 'registration-closed' };
        if (priorSeat && (kind === 'arrive' || priorSeat.offerWindow)) {
            return { lobby, rejection: priorSeat.admissionWindow || priorSeat.offerWindow ? 'admission-expired' : 'return-expired' };
        }
        const occupied = occupiedLobbyPlaces(lobby.seats, lobby.capacityClaims);
        if (!occupied.has(principalId) && occupied.size >= lobby.capacity) return { lobby, rejection: 'full' };
    }
    return { lobby: withSeat(lobby, { principalId, present: kind === 'arrive', returnWindow: null, offerWindow: null,
        admissionWindow: kind === 'reserve' ? makeSeatWindow(lobby.revision + 1, now, lobby.policy.claimWindowMs) : null }), rejection: null };
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
