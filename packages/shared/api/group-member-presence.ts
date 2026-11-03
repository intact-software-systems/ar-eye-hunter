import { readActiveGroupSessionRole } from './group-spectating.ts';
import type { GroupMember, GroupSnapshot } from './group-types.ts';

export interface GroupMemberPresence {
    readonly member: GroupMember;
    readonly presence: 'present' | 'away';
}

/** Membership grants access; only an unexpired, authorized session makes that member present. */
export function computeGroupMemberPresence(
    snapshot: GroupSnapshot,
    nowEpochMs: number
): readonly GroupMemberPresence[] {
    const present = new Set(
        snapshot.activeSessions
            .filter((session) => readActiveGroupSessionRole(snapshot, session.sessionId, nowEpochMs) !== undefined)
            .map((session) => session.principalId)
    );
    return snapshot.members.filter((member) => member.status === 'active').map((member) => ({
        member,
        presence: present.has(member.principalId) ? 'present' : 'away'
    }));
}
