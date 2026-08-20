import { describe, expect, it } from 'vitest';
import { toPendingMemberGroupSnapshot } from '@shared/api/group-client-views.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };

function snapshotWithPendingParker(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        ...SCOPE,
        groupId: 'room-1',
        sessionIds: ['alice-session'],
    });
    const parker: GroupMember = {
        ...snapshot.members[0],
        principalId: 'parker',
        status: 'pending',
        joined: null,
        left: null,
        removed: null,
        banned: null,
    };
    return { ...snapshot, members: [...snapshot.members, parker] };
}

describe('toPendingMemberGroupSnapshot', () => {
    // A parked requester gets the invite visibility tier: their own row and
    // the aggregate facts, never the roster or the live sessions.
    it('redacts the roster and sessions for a parked pending requester', () => {
        const snapshot = snapshotWithPendingParker();

        const redacted = toPendingMemberGroupSnapshot(snapshot, 'parker');

        expect(redacted.members.map((member) => member.principalId)).toEqual(['parker']);
        expect(redacted.activeSessions).toEqual([]);
        expect(redacted.group).toBe(snapshot.group);
    });

    it('returns the snapshot unchanged for active members and strangers', () => {
        const snapshot = snapshotWithPendingParker();
        const activePrincipalId = snapshot.members[0].principalId;

        expect(toPendingMemberGroupSnapshot(snapshot, activePrincipalId)).toBe(snapshot);
        expect(toPendingMemberGroupSnapshot(snapshot, 'stranger')).toBe(snapshot);
    });
});
