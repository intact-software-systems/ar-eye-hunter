import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { decodeGroupPublicationGrantList } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { validatePersistedGroupPresenceSession } from '../persistence/validate-persisted-group-presence.ts';
import { validatePersistedGroup, validatePersistedGroupMember } from '../persistence/validate-persisted-group.ts';

interface PersistedGroupSnapshotValidation {
    readonly snapshot: ApiJsonObject;
    readonly group: ApiJsonObject;
    readonly ref: GroupRef;
}

/** Validates the complete persisted GroupSnapshot contract at storage boundaries. */
export function validatePersistedGroupSnapshot(value: unknown): asserts value is GroupSnapshot {
    const snapshot = decodeSnapshotRecord(value, 'Stored group snapshot');
    assertExactRequiredKeys(snapshot, [
        'causalRevision',
        'group',
        'members',
        'activeSessions',
        'memberCount',
        'onlineMemberCount',
        'publicationGrants'
    ]);
    const group = decodeSnapshotRecord(snapshot.group, 'Stored group snapshot group');
    const ref = canonicalGroupRef(group);
    validatePersistedGroup(group, ref);
    const validation = { snapshot, group, ref };
    validatePersistedGroupSnapshotRevisions(validation);
    const activeMembers = validatePersistedGroupSnapshotRoster(validation);
    validatePersistedGroupSnapshotPresence(validation, activeMembers);
    validatePersistedGroupSnapshotPublicationGrants(validation);
}

function validatePersistedGroupSnapshotPublicationGrants(validation: PersistedGroupSnapshotValidation): void {
    const { snapshot, ref } = validation;
    const memberIds = new Set((snapshot.members as readonly ApiJsonObject[]).map((member) => member.principalId));
    const grants = decodeGroupPublicationGrantList(snapshot.publicationGrants, ref).fold(
        () => null,
        (decoded) => decoded
    );
    if (grants === null || grants.some((grant) => !memberIds.has(grant.principalId))) {
        throw new TypeError('Stored group snapshot publication grants are invalid');
    }
}

function validatePersistedGroupSnapshotRevisions(
    validation: PersistedGroupSnapshotValidation
): void {
    const { snapshot, group } = validation;
    const causal = decodeSnapshotRecord(snapshot.causalRevision, 'Stored group snapshot causal revision');
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

function validatePersistedGroupSnapshotRoster(
    validation: PersistedGroupSnapshotValidation
): ReadonlyMap<string, { role: string; }> {
    const { snapshot, group, ref } = validation;
    if (!Array.isArray(snapshot.members)) {
        throw new TypeError('Stored group snapshot members are invalid');
    }
    const memberIds = new Set<string>();
    const activeMembers = new Map<string, { role: string; }>();
    for (const member of snapshot.members) {
        validatePersistedGroupMember(member, ref);
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

function validatePersistedGroupSnapshotPresence(
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
        validatePersistedGroupPresenceSession(session, ref);
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

function canonicalGroupRef(group: ApiJsonObject): GroupRef {
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

function decodeSnapshotRecord(value: unknown, label: string): ApiJsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as ApiJsonObject;
}

function assertExactRequiredKeys(value: ApiJsonObject, keys: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new TypeError('Stored group snapshot has invalid keys');
    }
}

function requireSafeInteger(value: ApiJsonValue, minimum: number, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`Stored group snapshot ${label} is invalid`);
    }
}
