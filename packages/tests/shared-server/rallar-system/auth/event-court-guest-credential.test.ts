import { expect, it } from 'vitest';
import { resolveRoomGuestSeat } from '@shared-server/http/room-guest-request.ts';
import { readRoomGuestCredential, toEventCourtGuestCredential, toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

it('requires the seat-bound secret for a court while retaining the lobby principal and isolating the lobby credential', async () => {
    const initial = createGroupSnapshot(1, ['court-player']);
    const { applicationId, workspaceId, groupId } = initial.group;
    const court = { applicationId, workspaceId, groupId };
    const lobby = await toRoomGuestCredential({ ...court, groupId: 'lobby' }, 'a'.repeat(64));
    const admitted = await toEventCourtGuestCredential(court, lobby.clientId, 'b'.repeat(64));
    const stranger = await toEventCourtGuestCredential(court, lobby.clientId, 'c'.repeat(64));
    const source = { ...initial, group: { ...initial.group, kind: 'room' as const }, members: initial.members.filter(m => m.role === 'member').map(m => ({ ...m, principalId: lobby.clientId })) };
    const originalSeat = { admittedAtEpochMs: 0, expiresAtEpochMs: 14_400_000 };
    const snapshot = { ...source, members: source.members.map(member => ({ ...member, guestLease: {
        ...originalSeat, courtSessionId: admitted.sessionId
    }})) };
    const participant = await readRoomGuestCredential(admitted.accessToken);
    const fake = await readRoomGuestCredential(stranger.accessToken);
    if (!participant || !fake) throw new Error('Court credential did not decode.');
    expect(participant.clientId).toBe(lobby.clientId);
    expect(participant.sessionId).not.toBe(lobby.sessionId);
    expect(resolveRoomGuestSeat(participant, snapshot, 200)).toBe('room');
    expect(resolveRoomGuestSeat(fake, snapshot, 200)).toBe('expired');
    expect(resolveRoomGuestSeat(participant, { ...source, members: source.members.map(m => ({ ...m, guestLease: originalSeat })) }, 200)).toBe('expired');
});
