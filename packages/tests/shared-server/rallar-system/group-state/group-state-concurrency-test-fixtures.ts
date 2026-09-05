import type { GroupJoinCodeMutationWritten } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceAdmission } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../create-test-group.ts';
import type { GroupStateTestService } from './group-state-test-runtime.ts';
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

export function rekey<T>(stored: RuntimeStateEntryValue<T>, key: string): RuntimeStateEntryValue<T> {
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
    written: Awaited<ReturnType<GroupStateTestService['rotateGroupJoinCode']>>
): GroupJoinCodeMutationWritten {
    return written.result;
}

export function createMutationCommand(): Extract<GroupMutationCommand, { operation: 'updateGroup'; }>;
export function createMutationCommand<Operation extends GroupMutationCommand['operation']>(
    overrides: GroupMutationFixtureCommand & { readonly operation: Operation; }
): GroupMutationCommand & { readonly operation: Operation; };
export function createMutationCommand(overrides?: GroupMutationFixtureCommand): GroupMutationCommand {
    if (overrides !== undefined) {
        return { aggregateRef: groupRef('pure-room'), commandId: 'pure-command', requestId: 'pure-command', ...overrides };
    }
    return {
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
        operation: 'updateGroup'
    };
}

type GroupMutationFixtureCommand<Command extends GroupMutationCommand = GroupMutationCommand> = Command extends GroupMutationCommand ?
    Omit<Command, 'aggregateRef' | 'commandId' | 'requestId'> & Partial<Pick<Command, 'aggregateRef' | 'commandId' | 'requestId'>> :
    never;

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
        activeMemberPrincipalIds: null,
        plannedLayoutRow: null,
        connectTriggerLatch: null,
        acceptedLayoutRow: null
    };
}

function createStoredMutationGroup(audit: AuditStamp): RuntimeStateEntryValue<Group> {
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
    readonly entry: RuntimeStateEntryValue<GroupMember>;
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
        capacity: { defaultMaxMembers: null },
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
