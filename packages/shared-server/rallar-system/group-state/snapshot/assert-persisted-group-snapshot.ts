import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { validatePresenceSession } from '../persistence/validate-persisted-group-presence.ts';
import { validateStoredGroup, validateStoredMember } from '../persistence/validate-persisted-group.ts';

interface PersistedGroupSnapshotValidation {
    readonly snapshot: Record<string, unknown>;
    readonly group: Record<string, unknown>;
    readonly ref: GroupRef;
}

/** Asserts the complete persisted GroupSnapshot contract at storage boundaries. */
export function assertPersistedGroupSnapshot(value: unknown): asserts value is GroupSnapshot {
    const snapshot = requireRecord(value, 'Stored group snapshot');
    assertExactRequiredKeys(snapshot, [
        'causalRevision',
        'group',
        'members',
        'activeSessions',
        'memberCount',
        'onlineMemberCount'
    ]);
    const group = requireRecord(snapshot.group, 'Stored group snapshot group');
    const ref = canonicalGroupRef(group);
    const persistedGroupIssues = validateStoredGroup(group, ref);
    if (persistedGroupIssues.length > 0) {
        throw persistedGroupIssues[0].cause;
    }
    const validation = { snapshot, group, ref };
    assertPersistedGroupSnapshotRevisions(validation);
    const activeMembers = assertPersistedGroupSnapshotRoster(validation);
    assertPersistedGroupSnapshotPresence(validation, activeMembers);
}

function assertPersistedGroupSnapshotRevisions(
    validation: PersistedGroupSnapshotValidation
): void {
    const { snapshot, group } = validation;
    const causal = requireRecord(snapshot.causalRevision, 'Stored group snapshot causal revision');
    assertExactRequiredKeys(causal, ['groupRevision', 'presenceRevision']);
    requireSafeInteger(causal.groupRevision, 1, 'group revision');
    requireSafeInteger(causal.presenceRevision, 0, 'presence revision');
    requireSafeInteger(snapshot.memberCount, 0, 'member count');
    requireSafeInteger(snapshot.onlineMemberCount, 0, 'online member count');
    if (
        group.presenceVersion !== causal.presenceRevision
    ) {
        throw new TypeError('Stored group snapshot revisions are inconsistent');
    }
}

function assertPersistedGroupSnapshotRoster(
    validation: PersistedGroupSnapshotValidation
): ReadonlyMap<string, { role: string; }> {
    const { snapshot, group, ref } = validation;
    if (!Array.isArray(snapshot.members)) {
        throw new TypeError('Stored group snapshot members are invalid');
    }
    const memberIds = new Set<string>();
    const activeMembers = new Map<string, { role: string; }>();
    for (const member of snapshot.members) {
        const persistedGroupMemberIssues = validateStoredMember(member, ref, 'Stored group member');
        if (persistedGroupMemberIssues.length > 0) {
            throw persistedGroupMemberIssues[0].cause;
        }
        if (memberIds.has(member.principalId)) {
            throw new TypeError('Stored group snapshot has duplicate members');
        }
        memberIds.add(member.principalId);
        if (member.status === 'active') {
            activeMembers.set(member.principalId, { role: member.role });
        }
    }
    const activeOwners = [...activeMembers].filter(([, member]) => member.role === 'owner');
    if (
        activeMembers.size !== snapshot.memberCount ||
        activeMembers.size !== group.activeMemberCount ||
        activeOwners.length !== 1 ||
        activeOwners[0]![0] !== group.ownerPrincipalId
    ) {
        throw new TypeError('Stored group snapshot roster facts are inconsistent');
    }
    return activeMembers;
}

function assertPersistedGroupSnapshotPresence(
    validation: PersistedGroupSnapshotValidation,
    activeMembers: ReadonlyMap<string, { role: string; }>
): void {
    const { snapshot, group, ref } = validation;
    if (!Array.isArray(snapshot.activeSessions)) {
        throw new TypeError('Stored group snapshot active sessions are invalid');
    }
    const sessionIds = new Set<string>();
    const onlinePrincipals = new Set<string>();
    for (const session of snapshot.activeSessions) {
        const persistedGroupPresenceSessionIssues = validatePresenceSession(
            session,
            ref,
            'Stored group presence session'
        );
        if (persistedGroupPresenceSessionIssues.length > 0) {
            throw persistedGroupPresenceSessionIssues[0].cause;
        }
        if (
            sessionIds.has(session.sessionId) ||
            !activeMembers.has(session.principalId) ||
            session.disconnectedAtEpochMs !== null
        ) {
            throw new TypeError('Stored group snapshot active session is inconsistent');
        }
        sessionIds.add(session.sessionId);
        onlinePrincipals.add(session.principalId);
    }
    if (
        onlinePrincipals.size !== snapshot.onlineMemberCount ||
        (snapshot.onlineMemberCount as number) > (snapshot.memberCount as number) ||
        (group.status !== 'active' && snapshot.activeSessions.length !== 0)
    ) {
        throw new TypeError('Stored group snapshot presence facts are inconsistent');
    }
}

function canonicalGroupRef(group: Record<string, unknown>): GroupRef {
    if (
        typeof group.applicationId !== 'string' ||
        group.applicationId.length === 0 ||
        typeof group.workspaceId !== 'string' ||
        group.workspaceId.length === 0 ||
        typeof group.groupId !== 'string' ||
        group.groupId.length === 0
    ) {
        throw new TypeError('Stored group snapshot group identity is invalid');
    }
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId
    };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as Record<string, unknown>;
}

function assertExactRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new TypeError('Stored group snapshot has invalid keys');
    }
}

function requireSafeInteger(value: unknown, minimum: number, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`Stored group snapshot ${label} is invalid`);
    }
}

