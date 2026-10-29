import { readRallarGameParticipants } from '@shared/rallar-game/read-rallar-game-participants.ts';
import { describe, expect, it } from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

const snapshot = createGroupSnapshotFixture({ applicationId: 'game', workspaceId: 'default', groupId: 'room', sessionIds: ['alice', 'bob'] });

describe('game participation authority', () => {
    it('includes only live player memberships and excludes watchers, expired leases and archived rooms', () => {
        expect(readRallarGameParticipants(snapshot, 1).map((entry) => entry.sessionId)).toEqual(['alice', 'bob']);
        expect(readRallarGameParticipants({ ...snapshot, members: snapshot.members.map((member) => ({ ...member, role: 'spectator' })) }, 1)).toEqual([]);
        expect(readRallarGameParticipants(snapshot, 60_000)).toEqual([]);
        expect(readRallarGameParticipants(undefined, 1)).toEqual([]);
        expect(readRallarGameParticipants({ ...snapshot, group: { ...snapshot.group, expiresAtEpochMs: 1 } }, 1)).toEqual([]);
    });

    it('preserves consent identity through heartbeat and transport reconnect but changes it on membership replacement', () => {
        const initial = readRallarGameParticipants(snapshot, 1);
        const reconnected = {
            ...snapshot,
            activeSessions: snapshot.activeSessions.map((session) => ({
                ...session,
                connectionGenerationId: 'new-socket',
                lastHeartbeatAtEpochMs: 2,
                expiresAtEpochMs: 60_002
            }))
        };
        expect(readRallarGameParticipants(reconnected, 2)).toEqual(initial);
        const rejoined = {
            ...reconnected,
            members: snapshot.members.map((member) => ({ ...member, updated: { ...member.updated, requestId: 'join-again' } }))
        };
        expect(readRallarGameParticipants(rejoined, 2).map((entry) => entry.participationKey)).not.toEqual(initial.map((entry) => entry.participationKey));
    });
});
