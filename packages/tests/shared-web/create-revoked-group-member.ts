import type { GroupMember } from '@shared/api/group-types.ts';

export function createRevokedGroupMember(member: GroupMember, status: 'banned' | 'removed'): GroupMember {
    return status === 'banned'
        ? { ...member, status, left: null, removed: null, banned: member.updated }
        : { ...member, status, left: null, removed: member.updated, banned: null };
}
