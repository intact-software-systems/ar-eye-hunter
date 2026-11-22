import {
    changeRoomLobby, configureRoomLobby, configureRoomLobbyCapacityClaims, createRoomLobby, decodeRoomLobby, decodeRoomLobbyAccountView, projectRoomLobbyAccount, roomLobbyApplicationDefault,
    type RoomLobby
} from '@shared/api/room-lobbies/room-lobby.ts';
import { describe, expect, it } from 'vitest';

const scope = { applicationId: 'sports', workspaceId: 'courts' };
const roomRef = { ...scope, groupId: 'A' };
const policy = { returnWindowMs: 120_000, claimWindowMs: 60_000 };

function apply(lobby: RoomLobby, command: RoomLobby.Command, now: number): RoomLobby {
    const result = changeRoomLobby(lobby, command, now);
    expect(result.rejection).toBeNull();
    return result.lobby;
}

describe('named room lobby seats', () => {
    it('allocates an exclusive offer to the oldest waiter before a walk-in, and confirms only on arrival', () => {
        const first = createRoomLobby(roomRef, 1, policy, 'courts');
        const full = apply(first, { kind: 'arrive', principalId: 'host' }, 10);
        const waiting = apply(full, { kind: 'wait', principalId: 'alice', eligibleUntilEpochMs: null }, 100);
        const queue = apply(waiting, { kind: 'wait', principalId: 'bob', eligibleUntilEpochMs: null }, 90);
        const retry = apply(queue, { kind: 'wait', principalId: 'alice', eligibleUntilEpochMs: null }, 95);
        expect(retry).toBe(queue);
        expect(projectRoomLobbyAccount(scope, 'bob', queue).seat).toEqual({ roomRef, status: 'waiting', deadlineEpochMs: null });
        const offered = apply(queue, { kind: 'release', principalId: 'host' }, 200);
        expect(projectRoomLobbyAccount(scope, 'alice', offered).seat).toEqual({ roomRef, status: 'offered', deadlineEpochMs: 60200 });
        expect(changeRoomLobby(offered, { kind: 'reserve', principalId: 'outsider' }, 201).rejection).toBe('full');
        const joined = apply(offered, { kind: 'reserve', principalId: 'alice' }, 202);
        expect(joined).toBe(offered);
        const arrived = apply(joined, { kind: 'arrive', principalId: 'alice' }, 203);
        expect(projectRoomLobbyAccount(scope, 'alice', arrived).seat?.status).toBe('present');
        const again = apply(arrived, { kind: 'release', principalId: 'alice' }, 204);
        expect(projectRoomLobbyAccount(scope, 'bob', again).seat?.status).toBe('offered');
        expect(decodeRoomLobby(again)).toEqual(again);
    });

    it('expires or declines offers once, skips expired eligibility, and cancels waiting privately', () => {
        const full = apply(createRoomLobby(roomRef, 1, policy, 'courts'), { kind: 'arrive', principalId: 'host' }, 0);
        let lobby = full;
        for (const [principalId, eligibleUntilEpochMs] of [['alice', 20], ['bob', 40], ['carl', null], ['deb', null]] as const) {
            lobby = apply(lobby, { kind: 'wait', principalId, eligibleUntilEpochMs }, 2);
        }
        lobby = apply(lobby, { kind: 'release', principalId: 'deb' }, 3);
        const offered = apply(lobby, { kind: 'release', principalId: 'host' }, 21);
        expect(projectRoomLobbyAccount(scope, 'alice', offered).seat).toBeNull();
        const offer = offered.seats[0]!.offerWindow!;
        expect(offer.dueAtEpochMs).toBe(40);
        const promoted = apply(offered, { kind: 'expire', ...offer }, 40);
        expect(projectRoomLobbyAccount(scope, 'carl', promoted).seat?.status).toBe('offered');
        expect(apply(promoted, { kind: 'expire', ...offer }, 41)).toBe(promoted);
        const declined = apply(promoted, { kind: 'release', principalId: 'carl' }, 42);
        expect(declined.seats).toEqual([]);
        expect(declined.waiters).toEqual([]);
    });

    it('preserves scheduled places, skips a blocked waiter, and offers onward when the held capacity expires', () => {
        const empty = createRoomLobby(roomRef, 1, policy, 'scheduled');
        const held = configureRoomLobbyCapacityClaims(empty, { principalIds: ['bob'], dueAtEpochMs: 100 }, 0).lobby;
        const blocked = apply(held, { kind: 'wait', principalId: 'alice', eligibleUntilEpochMs: null }, 1);
        expect(projectRoomLobbyAccount(scope, 'alice', blocked).seat?.status).toBe('waiting');
        expect(changeRoomLobby(blocked, { kind: 'reserve', principalId: 'outsider' }, 2).rejection).toBe('full');
        const reserved = apply(blocked, { kind: 'wait', principalId: 'bob', eligibleUntilEpochMs: null }, 3);
        expect(projectRoomLobbyAccount(scope, 'bob', reserved).seat?.status).toBe('offered');
        const declined = apply(reserved, { kind: 'release', principalId: 'bob' }, 4);
        expect(decodeRoomLobby(declined)).toEqual(declined);
        expect(declined.seats.length).toBe(0);
        const due = held.capacityClaims!;
        const promoted = apply(declined, { kind: 'expire', generation: due.generation, dueAtEpochMs: 100 }, 100);
        expect(promoted.capacityClaims).toBeNull();
        expect(projectRoomLobbyAccount(scope, 'alice', promoted).seat?.status).toBe('offered');
        expect(apply(promoted, { kind: 'expire', generation: due.generation, dueAtEpochMs: 100 }, 105)).toBe(promoted);
        const withdrawn = configureRoomLobbyCapacityClaims(declined, null, 5).lobby;
        expect(projectRoomLobbyAccount(scope, 'alice', withdrawn).seat?.status).toBe('offered');
    });

    it('resolves only explicit application policies, including valid names shared by object prototypes', () => {
        expect(roomLobbyApplicationDefault(undefined, 'toString')).toBeUndefined();
        expect(roomLobbyApplicationDefault({ sports: policy }, 'toString')).toBeUndefined();
        expect(roomLobbyApplicationDefault({ toString: policy }, 'toString')).toEqual(policy);
    });

    it('starts a return window on actual fill, cancels it on release, and ignores its obsolete wake after refill', () => {
        const initial = createRoomLobby(roomRef, 2, policy, 'lobby-activation');
        const held = apply(initial, { kind: 'arrive', principalId: 'alice' }, 0);
        const away = apply(held, { kind: 'away', principalId: 'alice' }, 1);
        const pending = apply(away, { kind: 'reserve', principalId: 'bob' }, 2);
        expect(pending.seats[0]?.returnWindow).toBeNull();
        expect(changeRoomLobby(pending, { kind: 'arrive', principalId: 'outsider' }, 3).rejection).toBe('full');
        const full = apply(pending, { kind: 'arrive', principalId: 'bob' }, 10);
        const old = full.seats[0]!.returnWindow!;
        expect(old.dueAtEpochMs).toBe(120_010);
        const reopened = apply(full, { kind: 'release', principalId: 'bob' }, 11);
        expect(reopened.seats[0]?.returnWindow).toBeNull();
        const refilled = apply(reopened, { kind: 'arrive', principalId: 'claire' }, 12);
        const stale = apply(refilled, { kind: 'expire', ...old }, old.dueAtEpochMs);
        expect(stale).toEqual(refilled);
        const restored = apply(stale, { kind: 'arrive', principalId: 'alice' }, 120_011);
        expect(projectRoomLobbyAccount(scope, 'alice', restored)).toEqual({
            scope, principalId: 'alice', seat: { roomRef, status: 'present', deadlineEpochMs: null }
        });
    });

    it('releases all equally due seats, cancels later return windows on vacancy, and preserves other accounts', () => {
        const initial = createRoomLobby(roomRef, 4, policy, 'lobby-activation');
        let lobby = initial;
        for (const principalId of ['alice', 'bob', 'claire', 'dan']) {
            lobby = apply(lobby, { kind: 'arrive', principalId }, 0);
        }
        for (const principalId of ['alice', 'bob']) lobby = apply(lobby, { kind: 'away', principalId }, 5);
        lobby = apply(lobby, { kind: 'away', principalId: 'claire' }, 10);
        const deadline = lobby.seats[0]!.returnWindow!;
        const recovered = apply(lobby, { kind: 'expire', ...deadline }, 150_000);
        expect(recovered.seats.map(seat => seat.principalId)).toEqual(['claire', 'dan']);
        expect(recovered.seats[0]?.returnWindow).toBeNull();
    });

    it('fences late arrivals at the inclusive deadline before a maintenance wake runs', () => {
        const initial = createRoomLobby(roomRef, 1, policy, 'lobby-activation');
        const admitted = apply(initial, { kind: 'reserve', principalId: 'alice' }, 0);
        const late = changeRoomLobby(admitted, { kind: 'arrive', principalId: 'alice' }, 60_000);
        expect(late.rejection).toBe('admission-expired');
        expect(late.lobby.seats).toEqual([]);
        const present = apply(initial, { kind: 'arrive', principalId: 'alice' }, 0);
        const away = apply(present, { kind: 'away', principalId: 'alice' }, 10);
        expect(changeRoomLobby(away, { kind: 'arrive', principalId: 'alice' }, 120_010).rejection).toBe('return-expired');
    });

    it('reconciles actual occupancy on reconfiguration and preserves already displayed deadlines', () => {
        const initial = createRoomLobby(roomRef, 3, policy, 'lobby-activation');
        const first = apply(initial, { kind: 'arrive', principalId: 'alice' }, 0);
        const two = apply(first, { kind: 'arrive', principalId: 'bob' }, 1);
        const away = apply(two, { kind: 'away', principalId: 'alice' }, 2);
        expect(configureRoomLobby(away, { capacity: 1, policy }, 3).rejection).toBe('full');
        const full = configureRoomLobby(away, { capacity: 2, policy }, 3).lobby;
        const policyEdit = configureRoomLobby(full, { capacity: 2, policy: { ...policy, returnWindowMs: 5000 } }, 4).lobby;
        expect(policyEdit.seats[0]?.returnWindow).toEqual({ generation: full.revision, dueAtEpochMs: 120003 });
        const expanded = configureRoomLobby(policyEdit, { capacity: 3, policy }, 5).lobby;
        expect(expanded.seats[0]?.returnWindow).toBeNull();
        const expired = configureRoomLobby(policyEdit, { capacity: 1, policy }, 150000);
        expect(expired.rejection).toBeNull();
        expect(expired.lobby.seats.map(seat => seat.principalId)).toEqual(['bob']);
    });

    it('round trips a durable lobby and exposes only the requesting account in its own workspace', () => {
        const initial = createRoomLobby(roomRef, 2, policy, 'lobby-activation');
        const reserved = apply(initial, { kind: 'reserve', principalId: 'alice' }, 10);
        expect(reserved.expiresAtEpochMs).toBeNull();
        const temporary = createRoomLobby(roomRef, 2, policy, 'temporary', 200);
        expect(decodeRoomLobby(temporary).expiresAtEpochMs).toBe(200);
        expect(reserved.activationId).toBe('lobby-activation');
        expect(() => decodeRoomLobby({ ...reserved, activationId: '' })).toThrow();
        expect(decodeRoomLobby(JSON.parse(JSON.stringify(reserved)))).toEqual(reserved);
        expect(() => decodeRoomLobby({ ...reserved, seats: [...reserved.seats, ...reserved.seats] })).toThrow();
        const view = projectRoomLobbyAccount(scope, 'alice', reserved);
        expect(decodeRoomLobbyAccountView(view)).toEqual({
            scope, principalId: 'alice', seat: { roomRef, status: 'arriving', deadlineEpochMs: 60_010 }
        });
        expect(projectRoomLobbyAccount(scope, 'bob', reserved).seat).toBeNull();
        expect(() => decodeRoomLobbyAccountView({ ...view, scope: { ...scope, workspaceId: 'other' } })).toThrow();
    });
});
