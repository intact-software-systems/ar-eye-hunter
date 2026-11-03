import { computeGroupMemberPresence } from '@shared/api/group-member-presence.ts';
import { describe, expect, it } from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

const snapshot = createGroupSnapshotFixture({ applicationId: 'app', workspaceId: 'default', groupId: 'room', sessionIds: ['alice', 'bob'] });

describe('retained membership presence', () => {
    it('keeps the disconnected member visible as away without implying lost access', () => {
        const result = computeGroupMemberPresence({ ...snapshot, activeSessions: snapshot.activeSessions.slice(0, 1) }, 1000);
        expect(result.map(({ member, presence }) => [member.principalId, member.status, presence])).toEqual([
            [snapshot.members[0].principalId, 'active', 'present'],
            [snapshot.members[1].principalId, 'active', 'away']
        ]);
    });

    it('expires presence without removing membership and does not display former members', () => {
        expect(computeGroupMemberPresence(snapshot, 60000).map((entry) => entry.presence)).toEqual(['away', 'away']);
        const departed = {
            ...snapshot,
            members: snapshot.members.map((member) => ({ ...member, status: 'left' as const, left: snapshot.group.created, removed: null, banned: null }))
        };
        expect(computeGroupMemberPresence(departed, 1000)).toEqual([]);
    });

    it('shows a live spectator as present while preserving their spectator role', () => {
        const watching = { ...snapshot, members: snapshot.members.map((member) => ({ ...member, role: 'spectator' as const })) };
        expect(computeGroupMemberPresence(watching, 1000).map(({ member, presence }) => [member.role, presence])).toEqual([['spectator', 'present'], [
            'spectator',
            'present'
        ]]);
    });
});
