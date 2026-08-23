import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { AuditStamp, GroupMember, GroupPresenceAdmission } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../create-test-group.ts';
import type { TestAuthenticatedGroupStateService } from './group-state-test-runtime.ts';
import { groupMemberStorageKey, groupRef, groupStorageKey, storagePart, storedEntry } from './mutation/group-mutation-test-runtime.ts';

export const BASE_EPOCH_MS = Date.now();

export function requireMutationGroupAndActor(
    read: GroupMutationRead
): asserts read is
    & GroupMutationRead
    & Readonly<{
        group: NonNullable<GroupMutationRead['group']>;
        actorMember: GroupMember;
    }> {
    if (!read.group || !read.actorMember) {
        throw new Error('Mutation test fixture requires a group and actor member.');
    }
}

export function groupAdmissionStorageKey(principalId: string): string {
    return `${groupStorageKey()}:${storagePart('principal', principalId)}`;
}

export function groupIdempotencyStorageKey(requestId: string): string {
    return `${groupStorageKey()}:${storagePart('request', requestId)}`;
}

export function groupPresenceSummaryStorageKey(): string {
    return groupStorageKey();
}

export function rekey<T>(stored: ReturnType<typeof storedEntry<T>>, key: string) {
    return { ...stored, entry: { ...stored.entry, key } };
}

export function memberFor(principalId: string): GroupMember {
    const audit = auditStamp(1_000, 'alice', 'seed');
    return {
        ...groupRef('pure-room'),
        principalId,
        role: 'member',
        status: 'active',
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
        joined: audit,
        updated: audit
    };
}

export function requireJoinCodeResult(
    written: Awaited<ReturnType<TestAuthenticatedGroupStateService['rotateGroupJoinCode']>>
) {
    return written.result;
}

export function createMutationCommand(
    overrides: Partial<GroupMutationCommand> = {}
): GroupMutationCommand {
    return {
        operation: 'updateGroup',
        aggregateRef: groupRef('pure-room'),
        commandId: 'pure-command',
        requestId: 'pure-command',
        input: {
            slug: null,
            displayName: 'After',
            description: null,
            kind: null,
            status: null,
            joinMode: null,
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: null,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            reason: null,
            traceId: null
        },
        ...overrides
    } as GroupMutationCommand;
}

export function auditStamp(
    atEpochMs: number,
    principalId: string,
    requestId: string | null
): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId
    };
}

export function createMutationRead(): GroupMutationRead {
    const audit = auditStamp(1_000, 'alice', 'seed');
    const group = createStoredMutationGroup(audit);
    const actor = createMutationActor(audit);

    return {
        idempotency: null,
        group,
        expiredGroupEntry: null,
        actorMember: actor.member,
        targetMember: null,
        authorityMember: null,
        directorMember: null,
        actorMemberEntry: actor.entry,
        targetMemberEntry: null,
        authorityMemberEntry: null,
        directorMemberEntry: null,
        targetPresence: null,
        expiredTargetPresenceEntry: null,
        targetAdmission: null,
        authorityAdmission: null,
        directorAdmission: null,
        authorityPresenceSessions: [],
        authorityPresenceSessionEntries: [],
        presenceSummary: null,
        lifecyclePolicy: null,
        activeMemberPrincipalIds: null
    } as GroupMutationRead;
}

function createStoredMutationGroup(audit: AuditStamp) {
    const group = createTestGroup({
        ...groupRef('pure-room'),
        displayName: 'Before',
        activeMemberCount: 1,
        ownerPrincipalId: 'alice',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: audit,
        updated: audit
    });

    return storedEntry(groupStorageKey(), group);
}

interface MutationActorFixture {
    readonly member: GroupMember;
    readonly entry: ReturnType<typeof storedEntry<GroupMember>>;
}

function createMutationActor(audit: AuditStamp): MutationActorFixture {
    const member = {
        ...groupRef('pure-room'),
        principalId: 'alice',
        role: 'owner' as const,
        status: 'active' as const,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
        joined: audit,
        updated: audit
    };

    return {
        member,
        entry: storedEntry(groupMemberStorageKey('alice'), member)
    };
}

export function createMutationFacts(): GroupMutationFacts {
    return {
        nowEpochMs: 2_000,
        expireAtEpochMs: 253_402_300_799_999,
        serviceId: 'group-service',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
        attemptCount: 1,
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        authenticatedAuthority: {
            principalId: 'alice',
            sessionId: 'alice-session'
        }
    };
}

export function admissionFor(
    principalId: string,
    admittedSessions: GroupPresenceAdmission['admittedSessions']
): GroupPresenceAdmission {
    return {
        ...groupRef('pure-room'),
        principalId,
        admittedSessions,
        updatedAtEpochMs: 1_000
    };
}
