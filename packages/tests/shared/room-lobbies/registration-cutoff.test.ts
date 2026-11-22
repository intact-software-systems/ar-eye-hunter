import { changeRoomLobby, createRoomLobby, decodeRoomLobby, projectRoomLobbyAccount, type RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { expect, it } from 'vitest';

const scope = { applicationId: 'courts', workspaceId: 'league' };
const room = { ...scope, groupId: 'a' };
const fresh = () => createRoomLobby({roomRef: room, capacity: 1, policy: { claimWindowMs: 100, returnWindowMs: 200 }, activationId: 'league-day'});

function apply(lobby: RoomLobby, command: RoomLobby.Command, now: number) {
    const change = changeRoomLobby(lobby, command, now);
    expect(change.rejection).toBeNull();
    return change.lobby;
}

it('reschedules or cancels by revision while open and ignores an obsolete unattended wake', () => {
    const empty = fresh();
    const first = apply(empty, { kind: 'set-registration-cutoff', expectedRevision: 0, atEpochMs: 20 }, 1);
    const later = apply(first, { kind: 'set-registration-cutoff', expectedRevision: 1, atEpochMs: 40 }, 2);
    expect(later.registration).toEqual({ revision: 2, atEpochMs: 40, closed: false });
    const stale = changeRoomLobby(later, { kind: 'set-registration-cutoff', expectedRevision: 1, atEpochMs: null }, 3);
    expect(stale.rejection).toBe('revision-conflict');
    expect(apply(later, { kind: 'close-registration', generation: 1, dueAtEpochMs: 20 }, 20)).toBe(later);
    const cancelled = apply(later, { kind: 'set-registration-cutoff', expectedRevision: 2, atEpochMs: null }, 39);
    expect(cancelled.registration).toEqual({ revision: 3, atEpochMs: null, closed: false });
    expect(apply(cancelled, { kind: 'close-registration', generation: 2, dueAtEpochMs: 40 }, 45)).toBe(cancelled);
    const overdue = changeRoomLobby(later, { kind: 'set-registration-cutoff', expectedRevision: 2, atEpochMs: null }, 40);
    expect(overdue.rejection).toBe('registration-closed');
    expect(overdue.lobby.registration.closed).toBe(true);
});

it('closes at the inclusive boundary before a walk-in, clears waiters and honors a live offer without extending it', () => {
    const scheduled = apply(fresh(), { kind: 'set-registration-cutoff', expectedRevision: 0, atEpochMs: 30 }, 1);
    const held = apply(scheduled, { kind: 'arrive', principalId: 'owner' }, 2);
    const waiting = apply(held, { kind: 'wait', principalId: 'player', eligibleUntilEpochMs: null }, 3);
    const more = apply(waiting, { kind: 'wait', principalId: 'other', eligibleUntilEpochMs: null }, 4);
    const offered = apply(more, { kind: 'release', principalId: 'owner' }, 10);
    const denied = changeRoomLobby(offered, { kind: 'reserve', principalId: 'new' }, 30);
    expect(denied.rejection).toBe('registration-closed');
    const closed = denied.lobby;
    expect(closed.waiters).toEqual([]);
    expect(projectRoomLobbyAccount(scope, 'player', closed)).toEqual(projectRoomLobbyAccount(scope, 'player', offered));
    expect(decodeRoomLobby(closed)).toEqual(closed);
    expect(changeRoomLobby(closed, { kind: 'wait', principalId: 'other', eligibleUntilEpochMs: null }, 30).rejection).toBe('registration-closed');
    const claimed = apply(closed, { kind: 'arrive', principalId: 'player' }, 109);
    expect(claimed.seats[0]?.present).toBe(true);
    const expired = apply(closed, { kind: 'expire', ...closed.seats[0]!.offerWindow! }, 110);
    expect(expired.seats).toEqual([]);
    const declined = apply(closed, { kind: 'release', principalId: 'player' }, 35);
    expect(declined.seats).toEqual([]);
    const wake = { kind: 'close-registration', generation: 1, dueAtEpochMs: 30 } as const;
    expect(apply(offered, wake, 35)).toEqual(closed);
    expect(apply(closed, wake, 36)).toBe(closed);
});
