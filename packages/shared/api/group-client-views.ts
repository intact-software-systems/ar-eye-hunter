import type { ClientInfo } from './api-config.ts';
import type { ClientSnapshot } from './client-types.ts';
import type {
    GroupSnapshot,
    GroupStateCausalRevision,
} from './group-types.ts';

export type AnyClientPresence = ClientInfo | ClientSnapshot;
export type AnyGroupPresence = GroupSnapshot;

export function readActiveClientSessionIds(
    snapshot: AnyClientPresence,
): readonly string[] {
    if ('principal' in snapshot) {
        return snapshot.activeSessions.map((session) => session.sessionId);
    }

    return snapshot.isOnline ? [snapshot.sessionId] : [];
}

export function readGroupId(snapshot: AnyGroupPresence): string {
    return snapshot.group.groupId;
}

export function readGroupDisplayName(snapshot: AnyGroupPresence): string {
    return snapshot.group.displayName;
}

export function readGroupCreatedByPrincipalId(
    snapshot: AnyGroupPresence,
): string {
    const owner = snapshot.members.find((member) => member.role === 'owner');
    return owner?.principalId ??
        snapshot.group.created.byPrincipalId ??
        snapshot.group.groupId;
}

export function readGroupCreatedAtEpochMs(snapshot: AnyGroupPresence): number {
    return snapshot.group.created.atEpochMs;
}

export function readGroupUpdatedAtEpochMs(snapshot: AnyGroupPresence): number {
    return snapshot.group.updated.atEpochMs;
}

export function readGroupVersion(snapshot: AnyGroupPresence): number {
    return snapshot.group.snapshotVersion;
}

export function readGroupStateRevision(snapshot: AnyGroupPresence): number {
    return snapshot.stateRevision;
}

export function readGroupCausalRevision(
    snapshot: AnyGroupPresence,
): GroupStateCausalRevision {
    return snapshot.causalRevision;
}

export type GroupCausalRevisionOrder =
    | 'equal'
    | 'dominates'
    | 'dominated'
    | 'concurrent';

/** Compare the authoritative group/presence tuple as a partial order. */
export function compareGroupCausalRevision(
    left: GroupStateCausalRevision,
    right: GroupStateCausalRevision,
): GroupCausalRevisionOrder {
    const groupComparison = Math.sign(
        left.groupRevision - right.groupRevision,
    );
    const presenceComparison = Math.sign(
        left.presenceRevision - right.presenceRevision,
    );
    if (groupComparison === 0 && presenceComparison === 0) return 'equal';
    if (groupComparison >= 0 && presenceComparison >= 0) return 'dominates';
    if (groupComparison <= 0 && presenceComparison <= 0) return 'dominated';
    return 'concurrent';
}

export function readClientVersion(snapshot: ClientSnapshot): number {
    return snapshot.principal.snapshotVersion;
}

export function readClientStateRevision(snapshot: ClientSnapshot): number {
    return snapshot.stateRevision;
}

export function isGroupActive(snapshot: AnyGroupPresence): boolean {
    return snapshot.group.status === 'active';
}

export function readGroupMemberSessionIds(
    snapshot: AnyGroupPresence,
): readonly string[] {
    return [
        ...new Set(snapshot.activeSessions.map((session) => session.sessionId)),
    ];
}

export function isSessionInGroup(
    snapshot: AnyGroupPresence,
    sessionId: string,
): boolean {
    return readGroupMemberSessionIds(snapshot).includes(sessionId);
}
