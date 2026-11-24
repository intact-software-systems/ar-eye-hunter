import type { Group, GroupMember } from './group-types.ts';
import { readRoomTimeline } from './group-deadlines/room-timeline.ts';

export const GUEST_PLAY_TIMELINE = 'guest-play';

/** Room access after the initial lease is limited to the occurrence that was active at expiry. */
export function roomGuestAccessMode(group: Group, member: GroupMember, nowEpochMs: number): 'room' | 'finish-round' | 'expired' {
    const lease = member.guestLease;
    if (!lease || member.status !== 'active' || group.status !== 'active' || group.kind !== 'room' ||
        member.applicationId !== group.applicationId || member.workspaceId !== group.workspaceId || member.groupId !== group.groupId ||
        nowEpochMs < lease.admittedAtEpochMs || (group.expiresAtEpochMs !== null && nowEpochMs >= group.expiresAtEpochMs)) {
        return 'expired';
    }
    if (nowEpochMs < lease.expiresAtEpochMs) {
        return 'room';
    }
    const round = readRoomTimeline(group.metadata, GUEST_PLAY_TIMELINE);
    const participation = round?.guestParticipants?.find(entry => entry.principalId === member.principalId &&
        entry.leaseExpiresAtEpochMs === lease.expiresAtEpochMs);
    return participation && nowEpochMs < participation.endsAtEpochMs ? 'finish-round' : 'expired';
}
