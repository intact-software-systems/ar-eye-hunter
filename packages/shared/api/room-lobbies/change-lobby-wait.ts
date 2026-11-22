import { requireEpoch } from '../exact-object-decoding.ts';
import type { RoomLobby } from './room-lobby.ts';

export function changeLobbyWait(
    lobby: RoomLobby, command: Extract<RoomLobby.Command, { kind: 'wait' | 'limit' }>, nowEpochMs: number
): RoomLobby.Change {
    const { eligibleUntilEpochMs, principalId } = command;
    if (eligibleUntilEpochMs !== null) requireEpoch(eligibleUntilEpochMs, 'Lobby eligibility deadline');
    const waiter = lobby.waiters.find(candidate => candidate.principalId === principalId);
    const seat = lobby.seats.find(candidate => candidate.principalId === principalId);
    if (command.kind === 'wait') {
        if (seat || waiter) return { lobby, rejection: null };
        if (eligibleUntilEpochMs !== null && eligibleUntilEpochMs <= nowEpochMs) return { lobby, rejection: 'eligibility-expired' };
        const registration = { principalId, eligibleUntilEpochMs, generation: lobby.revision + 1 };
        return { lobby: { ...lobby, waiters: [...lobby.waiters, registration] }, rejection: null };
    }
    const deadline = command.eligibleUntilEpochMs;
    requireEpoch(deadline, 'Lobby eligibility deadline');
    if (waiter && (waiter.eligibleUntilEpochMs === null || deadline < waiter.eligibleUntilEpochMs)) {
        const waiters = lobby.waiters.map(candidate => candidate === waiter ? { ...waiter, eligibleUntilEpochMs: deadline } : candidate);
        return { lobby: { ...lobby, waiters }, rejection: null };
    }
    if (seat?.offerWindow && deadline < seat.offerWindow.dueAtEpochMs) {
        const offerWindow = { generation: lobby.revision + 1, dueAtEpochMs: deadline };
        const seats = lobby.seats.map(candidate => candidate === seat ? { ...seat, offerWindow } : candidate);
        return { lobby: { ...lobby, seats }, rejection: null };
    }
    return { lobby, rejection: null };
}
