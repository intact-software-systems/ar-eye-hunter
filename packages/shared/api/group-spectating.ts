import type { ApiJsonObject } from './api-json-value.ts';
import type { GroupMember, GroupRole, GroupSnapshot } from './group-types.ts';

export const GROUP_SPECTATOR_CAPACITY_METADATA_KEY = 'rallarSpectatorCapacity';

export function readGroupSpectatorCapacity(metadata: ApiJsonObject): number {
    const capacity = metadata[GROUP_SPECTATOR_CAPACITY_METADATA_KEY];
    return typeof capacity === 'number' && Number.isInteger(capacity) && capacity >= 0 && capacity <= 64
        ? capacity
        : 0;
}

export function isGroupSpectator(member: GroupMember | null | undefined): boolean {
    return member?.status === 'active' && member.role === 'spectator';
}

export function countGroupPlayers(snapshot: GroupSnapshot): number {
    return snapshot.group.activeMemberCount - snapshot.members.filter(isGroupSpectator).length;
}

export function countOnlineGroupPlayers(snapshot: GroupSnapshot): number {
    const spectators = new Set(snapshot.members.filter(isGroupSpectator).map((member) => member.principalId));
    const onlineSpectators = new Set(
        snapshot.activeSessions.filter((session) => spectators.has(session.principalId)).map((session) =>
            session.principalId
        )
    );
    return snapshot.onlineMemberCount - onlineSpectators.size;
}

/** Reads live room authority from the canonical snapshot, never from cached online labels. */
export function readActiveGroupSessionRole(
    snapshot: GroupSnapshot | undefined,
    sessionId: string | undefined,
    nowEpochMs: number
): GroupRole | undefined {
    if (
        !snapshot || !sessionId || snapshot.group.status !== 'active' ||
        (snapshot.group.expiresAtEpochMs !== null && snapshot.group.expiresAtEpochMs <= nowEpochMs)
    ) {
        return undefined;
    }
    const session = snapshot.activeSessions.find((entry) =>
        entry.sessionId === sessionId &&
        entry.status === 'active' && entry.expiresAtEpochMs > nowEpochMs
    );
    return session
        ? snapshot.members.find((member) => member.principalId === session.principalId && member.status === 'active')
            ?.role
        : undefined;
}
