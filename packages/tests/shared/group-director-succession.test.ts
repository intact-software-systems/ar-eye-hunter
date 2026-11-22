import { isRallarGroupDirectorSessionActive, readRallarGroupDirectorFromSnapshot } from '@shared/api/group-director.ts';
import { changeRoomDirectorSuccession, observeRoomDirectorLoss, observeRoomDirectorPresence, observeRoomDirectorMembership, readRoomDirectorSuccession, recoverRoomDirector, type RoomDirectorSuccession } from '@shared/api/group-director-succession.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { expect, it } from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

const room = { applicationId: 'sports', workspaceId: 'season', groupId: 'court' };
function players(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...room, sessionIds: ['owner', 'first', 'deputy', 'other'] });
    return { ...snapshot, members: snapshot.members.map(member => member.principalId === 'deputy' ? { ...member, role: 'spectator' } : member) };
}
function act(snapshot: GroupSnapshot, principalId: string, command: RoomDirectorSuccession.Command, nowEpochMs: number) {
    return changeRoomDirectorSuccession({ snapshot, actor: { principalId, sessionId: principalId }, command, nowEpochMs });
}
function accept(snapshot: GroupSnapshot, principalId: string, command: RoomDirectorSuccession.Command, now: number): GroupSnapshot {
    const decision = act(snapshot, principalId, command, now);
    if ('rejectionCode' in decision) throw new Error(decision.message);
    return { ...snapshot, group: { ...snapshot.group, metadata: decision.metadata } };
}
const appoint = { operation: 'appoint', expectedDirectorEpoch: 0, targetPrincipalId: 'first', targetSessionId: 'first' } as const;

it('permits an owner off-room to appoint a present spectator and fences a simultaneous replacement', () => {
    const original = players();
    const snapshot = { ...original, activeSessions: original.activeSessions.filter(session => session.principalId !== 'owner') };
    const command = { ...appoint, targetPrincipalId: 'deputy', targetSessionId: 'deputy' };
    expect(act(snapshot, 'other', command, 2)).toHaveProperty('rejectionCode');
    expect(act(snapshot, 'owner', { ...command, targetSessionId: 'other' }, 2)).toHaveProperty('rejectionCode');
    const appointed = accept(snapshot, 'owner', command, 2);
    const appointment = readRallarGroupDirectorFromSnapshot(appointed);
    expect(appointment).toMatchObject({ principalId: 'deputy', sessionId: 'deputy', epoch: 1 });
    expect(isRallarGroupDirectorSessionActive(appointed, appointment, 2)).toBe(true);
    expect(act(appointed, 'owner', appoint, 2)).toHaveProperty('rejectionCode', 'room-director-changed');
    expect(readRoomDirectorSuccession(appointed.group.metadata)).toMatchObject({ reconnectWindowMs: 30000, deputyWindowMs: 30000 });
});

it('orders director recovery, exclusive deputy claim and organizer override by the server deadlines', () => {
    const appointed = accept(players(), 'owner', appoint, 1);
    const configured = accept(appointed, 'owner', { operation: 'configure', expectedRevision: 1, expectedDirectorEpoch: 1,
        reconnectWindowMs: 30, deputyWindowMs: 20, deputyPrincipalId: 'deputy' }, 2);
    const metadata = observeRoomDirectorLoss(configured.group.metadata, 50);
    expect(observeRoomDirectorLoss(metadata, 65)).toBe(metadata);
    const lost = { ...configured, group: { ...configured.group, metadata } };
    const claim = { operation: 'claim-deputy', expectedDirectorEpoch: 1 } as const;
    expect(isRallarGroupDirectorSessionActive(lost, readRallarGroupDirectorFromSnapshot(lost), 51)).toBe(false);
    expect(readRoomDirectorSuccession(recoverRoomDirector(metadata, 'first', 'first', 79))?.loss).toBeNull();
    expect(recoverRoomDirector(metadata, 'first', 'first', 80)).toBe(metadata);
    expect(act(lost, 'deputy', claim, 79)).toHaveProperty('rejectionCode');
    expect(act(lost, 'other', claim, 80)).toHaveProperty('rejectionCode');
    expect(act(lost, 'deputy', claim, 100)).toHaveProperty('rejectionCode');
    const replacement = accept(lost, 'deputy', claim, 80);
    expect(readRallarGroupDirectorFromSnapshot(replacement)).toMatchObject({ principalId: 'deputy', epoch: 2 });
    expect(isRallarGroupDirectorSessionActive(replacement, readRallarGroupDirectorFromSnapshot(replacement), 81)).toBe(true);
    expect(act(replacement, 'deputy', claim, 81)).toHaveProperty('rejectionCode', 'room-director-changed');
    const declined = accept(lost, 'deputy', { operation: 'decline-deputy', expectedDirectorEpoch: 1 }, 81);
    expect(act(declined, 'deputy', claim, 82)).toHaveProperty('rejectionCode');
    const override = accept(lost, 'owner', { ...appoint, expectedDirectorEpoch: 1, targetPrincipalId: 'other', targetSessionId: 'other' }, 60);
    expect(readRoomDirectorSuccession(override.group.metadata)?.loss).toBeNull();
    expect(readRallarGroupDirectorFromSnapshot(override)?.principalId).toBe('other');
});


it('configures a deputy with defaults and retains customized windows when the designation changes', () => {
    const policy = { operation: 'configure', expectedDirectorEpoch: 0, expectedRevision: 0, deputyPrincipalId: 'deputy' } as const;
    const configured = accept(players(), 'owner', policy, 1);
    expect(readRoomDirectorSuccession(configured.group.metadata)).toMatchObject({ reconnectWindowMs: 30000, deputyWindowMs: 30000 });
    const custom = accept(configured, 'owner', { ...policy, expectedRevision: 1, reconnectWindowMs: 12, deputyWindowMs: 25 }, 2);
    const changed = accept(custom, 'owner', { ...policy, expectedRevision: 2, deputyPrincipalId: 'other' }, 3);
    expect(readRoomDirectorSuccession(changed.group.metadata)).toMatchObject({ reconnectWindowMs: 12, deputyWindowMs: 25, deputyPrincipalId: 'other' });
});

it('derives a missed absence from the last confirmed lease and refuses a return after its grace', () => {
    const initial = accept(players(), 'owner', appoint, 1);
    const configured = accept(initial, 'owner', { operation: 'configure', expectedRevision: 1, expectedDirectorEpoch: 1,
        deputyPrincipalId: 'deputy', reconnectWindowMs: 30, deputyWindowMs: 20 }, 2);
    const healthy = observeRoomDirectorPresence(configured.group.metadata, 'first', 'first', 20, 60500);
    const health = readRoomDirectorSuccession(healthy)!;
    expect(health.directorLeaseExpiresAtEpochMs).toBe(60500);
    expect(health.revision).toBe(2);
    const expired = observeRoomDirectorPresence(healthy, 'first', 'first', 60530, 61000);
    expect(readRoomDirectorSuccession(expired)?.loss).toMatchObject({ lostAtEpochMs: 60500, reconnectUntilEpochMs: 60530 });
    const stillPresent = { ...configured, group: { ...configured.group, metadata: healthy },
        activeSessions: configured.activeSessions.map(session => ({ ...session, expiresAtEpochMs: 61000 })) };
    expect(act(stillPresent, 'deputy', { operation: 'claim-deputy', expectedDirectorEpoch: 1 }, 60530)).toHaveProperty('metadata');
});

it('records a shortened accepted lease and loses the director immediately on an already-due renewal', () => {
    const appointed = accept(players(), 'owner', appoint, 1);
    const shorter = observeRoomDirectorPresence(appointed.group.metadata, 'first', 'first', 100, 500);
    expect(readRoomDirectorSuccession(shorter)?.directorLeaseExpiresAtEpochMs).toBe(500);
    const due = observeRoomDirectorPresence(shorter, 'first', 'first', 200, 200);
    expect(readRoomDirectorSuccession(due)?.loss?.lostAtEpochMs).toBe(200);
});

it('revokes a demoted director immediately and clears a departed deputy’s exclusive claim', () => {
    const initial = accept(players(), 'owner', appoint, 1);
    const configured = accept(initial, 'owner', { operation: 'configure', expectedRevision: 1, expectedDirectorEpoch: 1,
        deputyPrincipalId: 'deputy', reconnectWindowMs: 30, deputyWindowMs: 20 }, 2);
    const member = configured.members.find(member => member.principalId === 'first')!;
    const revoked = observeRoomDirectorMembership(configured.group.metadata, { ...member, role: 'spectator' }, 50);
    expect(readRoomDirectorSuccession(revoked)?.loss).toMatchObject({ lostAtEpochMs: 50, reconnectUntilEpochMs: 50 });
    expect(recoverRoomDirector(revoked, 'first', 'first', 49)).toBe(revoked);
    expect(recoverRoomDirector(revoked, 'first', 'first', 50)).toBe(revoked);
    const deputy = configured.members.find(member => member.principalId === 'deputy')!;
    const cleared = observeRoomDirectorMembership(revoked, { ...deputy, status: 'removed', joined: null, left: null, banned: null, removed: deputy.updated }, 51);
    expect(readRoomDirectorSuccession(cleared)).toMatchObject({ deputyPrincipalId: null, loss: { declined: true } });
});

it('opens the player claim after grace and deputy priority, including an explicit decline', () => {
    const appointed = accept(players(), 'owner', appoint, 1);
    const policy = { operation: 'configure', expectedRevision: 1, expectedDirectorEpoch: 1,
        reconnectWindowMs: 30, deputyWindowMs: 20 } as const;
    const claim = { operation: 'claim-player', expectedDirectorEpoch: 1 } as const;
    function lose(deputyPrincipalId: string | null) {
        const snapshot = accept(appointed, 'owner', { ...policy, deputyPrincipalId }, 2);
        return { ...snapshot, group: { ...snapshot.group, metadata: observeRoomDirectorLoss(snapshot.group.metadata, 50) } };
    }
    const noDeputy = lose(null);
    expect(act(appointed, 'other', claim, 100)).toHaveProperty('rejectionCode');
    expect(act(noDeputy, 'other', claim, 79)).toHaveProperty('rejectionCode');
    expect(act(noDeputy, 'deputy', claim, 80)).toHaveProperty('rejectionCode');
    expect(act({ ...noDeputy, activeSessions: [] }, 'other', claim, 80)).toHaveProperty('rejectionCode');
    expect(act(noDeputy, 'other', claim, 80)).toHaveProperty('metadata');
    const protectedRoom = lose('deputy');
    expect(act(protectedRoom, 'other', claim, 99)).toHaveProperty('rejectionCode');
    const declined = accept(protectedRoom, 'deputy', { operation: 'decline-deputy', expectedDirectorEpoch: 1 }, 81);
    expect(act(declined, 'other', claim, 81)).toHaveProperty('metadata');
    const won = accept(protectedRoom, 'other', claim, 100);
    expect(readRallarGroupDirectorFromSnapshot(won)).toMatchObject({ principalId: 'other', sessionId: 'other', epoch: 2 });
    expect(act(won, 'owner', claim, 100)).toHaveProperty('rejectionCode', 'room-director-changed');
});
