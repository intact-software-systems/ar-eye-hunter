import { readActiveGroupSessionRole } from '@shared/api/group-spectating.ts';
import { describe, expect, it } from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

const snapshot = createGroupSnapshotFixture({ applicationId: 'app', workspaceId: 'default', groupId: 'room', sessionIds: ['alice'] });

describe('live scoped group session role', () => {
    it('returns the active role only while group and session are live', () => {
        expect(readActiveGroupSessionRole(snapshot, 'alice', 59_999)).toBe('owner');
        expect(readActiveGroupSessionRole(snapshot, 'alice', 60_000)).toBeUndefined();
        expect(readActiveGroupSessionRole({ ...snapshot, group: { ...snapshot.group, expiresAtEpochMs: 1_000 } }, 'alice', 1_000)).toBeUndefined();
        expect(
            readActiveGroupSessionRole(
                { ...snapshot, group: { ...snapshot.group, status: 'archived', archived: snapshot.group.created, deleted: null } },
                'alice',
                999
            )
        )
            .toBeUndefined();
    });

    it('requires active membership and presence instead of trusting cached session identifiers', () => {
        expect(readActiveGroupSessionRole(undefined, 'alice', 999)).toBeUndefined();
        expect(readActiveGroupSessionRole(snapshot, undefined, 999)).toBeUndefined();
        expect(readActiveGroupSessionRole(snapshot, 'stranger', 999)).toBeUndefined();
        expect(
            readActiveGroupSessionRole(
                {
                    ...snapshot,
                    members: snapshot.members.map((member) => ({ ...member, status: 'left', left: snapshot.group.created, removed: null, banned: null }))
                },
                'alice',
                999
            )
        ).toBeUndefined();
        expect(
            readActiveGroupSessionRole(
                {
                    ...snapshot,
                    activeSessions: snapshot.activeSessions.map((session) => ({
                        ...session,
                        status: 'disconnected',
                        disconnectedAtEpochMs: 998,
                        disconnectReason: 'left'
                    }))
                },
                'alice',
                999
            )
        ).toBeUndefined();
        expect(readActiveGroupSessionRole({ ...snapshot, members: snapshot.members.map((member) => ({ ...member, role: 'spectator' })) }, 'alice', 999)).toBe(
            'spectator'
        );
    });
});
