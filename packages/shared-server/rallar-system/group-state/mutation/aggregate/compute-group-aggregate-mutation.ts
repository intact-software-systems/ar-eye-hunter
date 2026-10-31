import {
    createRallarGroupDirectorAppointment,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorFromSnapshot,
    resolveRallarGroupDirectorAppointmentEligibility
} from '@shared/api/group-director.ts';
import {
    GROUP_DIRECTORY_LISTING_METADATA_KEY,
    type GroupDirectoryListing
} from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import { GROUP_RETENTION_METADATA_KEY, readGroupRetentionState } from '@shared/api/group-retention.ts';
import {
    GROUP_SESSION_SCHEDULE_METADATA_KEY,
    readGroupSessionSchedule
} from '@shared/api/group-sessions/group-session-schedule.ts';
import {
    countGroupPlayers,
    GROUP_SPECTATOR_CAPACITY_METADATA_KEY,
    isGroupSpectator,
    readGroupSpectatorCapacity
} from '@shared/api/group-spectating.ts';
import type { AuditStamp, Group, GroupEventType, GroupStatus } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { countGroupSessionOccupiedSeats } from '../../schedule/group-session-reservations.ts';

import { canGovernGroupMember } from '../../policy/group-governance-policy.ts';
import { canMutateActiveGroup } from '../../policy/group-lifecycle-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import {
    auditStamp,
    computeGroupMutationWriteResult,
    materializedRotateJoinCode,
    noOp,
    rejected,
    rejectedByGroupPolicy,
    requireGroup
} from '../group-mutation-result.ts';
import { toPolicySnapshot } from './group-aggregate-mutation-policy.ts';

const RALLAR_GROUP_JOIN_CODE_METADATA_KEY = 'rallarJoinCode';
const RALLAR_GROUP_JOIN_CODE_VERSION = 1;

interface GroupWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly group: Group;
    readonly eventType: GroupEventType;
}

export function computeUpdate(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const authorityDenial = toUpdateAuthorityDenial(command, read);
    if (authorityDenial) {
        return rejectedByGroupPolicy({ command, read, facts, denial: authorityDenial });
    }
    if (
        readGroupRetentionState(stored.value.metadata) !== null &&
        (command.input.expiresAtEpochMs !== null || command.input.purgeAfterEpochMs !== null ||
            command.input.emptySinceEpochMs !== null)
    ) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: 'Temporary room deadlines and idle observations are server-owned.'
        });
    }
    const allowsArchivedDeletion = stored.value.status === 'archived' && command.input.status === 'deleted';
    if (!allowsArchivedDeletion) {
        const active = canMutateActiveGroup({ group: stored.value, nowEpochMs: facts.attemptAtEpochMs });
        if (!active.allowed) {
            return rejectedByGroupPolicy({ command, read, facts, denial: active });
        }
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const current = stored.value;
    const next = computeUpdatedGroup(command, current, audit);
    const capacityRefusal = toGroupCapacityRefusal(next, read, facts.attemptAtEpochMs);
    if (capacityRefusal !== null) {
        return rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message: capacityRefusal });
    }
    if (sameGroupIgnoringVersions(current, next)) {
        return noOp(command, read, facts);
    }
    return groupWrite({
        command,
        read,
        facts,
        group: next,
        eventType: next.status === 'archived'
            ? 'group-archived'
            : next.status === 'deleted'
            ? 'group-deleted'
            : 'group-updated'
    });
}

/** Capacity changes preserve occupied players, outstanding reservations and spectators. */
function toGroupCapacityRefusal(next: Group, read: GroupMutationRead, nowEpochMs: number): string | null {
    const schedule = readGroupSessionSchedule(next.metadata);
    if (schedule !== null && (next.kind !== 'room' || next.maxMembers === null || next.maxMembers > 64)) {
        return 'Scheduled rooms require a player capacity of 1 to 64.';
    }
    const snapshot = toPolicySnapshot(read, next, nowEpochMs);
    const occupiedSeats = schedule === null
        ? countGroupPlayers(snapshot)
        : countGroupSessionOccupiedSeats({
            schedule,
            reservations: requireSessionReservations(read),
            activePlayerPrincipalIds: snapshot.members.filter((member) =>
                member.status === 'active' && !isGroupSpectator(member)
            )
                .map((member) => member.principalId),
            nowEpochMs
        });
    if (next.maxMembers !== null && next.maxMembers < occupiedSeats) {
        return 'Group maxMembers cannot be lower than the occupied and reserved player seats.';
    }
    if (readGroupSpectatorCapacity(next.metadata) < (read.activeMembers ?? []).filter(isGroupSpectator).length) {
        return 'Spectator capacity cannot be lower than the spectator count.';
    }
    return null;
}

export function computeDirector(
    command: Extract<GroupMutationCommand, { operation: 'appointDirector'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const active = canMutateActiveGroup({ group: stored.value, nowEpochMs: facts.attemptAtEpochMs });
    if (!active.allowed) {
        return rejectedByGroupPolicy({ command, read, facts, denial: active });
    }
    const principalId = command.input.actorPrincipalId;
    const sessionId = command.input.actorSessionId;
    if (!principalId || !sessionId) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: 'Forbidden: Cannot appoint a director without a local session.'
        });
    }
    const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs);
    const eligibility = resolveRallarGroupDirectorAppointmentEligibility({
        snapshot,
        principalId,
        sessionId
    });
    if (!eligibility.allowed) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Forbidden: ${eligibility.reason ?? 'Cannot appoint the browser director.'}`
        });
    }
    const appointment = createRallarGroupDirectorAppointment({
        session: { clientId: principalId, sessionId },
        previous: readRallarGroupDirectorFromSnapshot(snapshot),
        now: facts.attemptAtEpochMs,
        heartbeatTtlMs: command.input.heartbeatTtlMs
    });
    const next: Group = {
        ...stored.value,
        metadata: mergeRallarGroupDirectorMetadata(stored.value.metadata, appointment),
        snapshotVersion: stored.value.snapshotVersion + 1,
        metadataVersion: stored.value.metadataVersion + 1,
        updated: auditStamp(command, facts, principalId)
    };
    return groupWrite({ command, read, facts, group: next, eventType: 'group-updated' });
}

export function computeRotateJoinCode(
    command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const active = canMutateActiveGroup({ group: stored.value, nowEpochMs: facts.attemptAtEpochMs });
    if (!active.allowed) {
        return rejectedByGroupPolicy({ command, read, facts, denial: active });
    }
    const governance = canGovernGroupMember({
        snapshot: toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs),
        actor: {
            principalId: command.input.actorPrincipalId ?? undefined,
            sessionId: command.input.actorSessionId ?? undefined
        },
        targetPrincipalId: `${command.aggregateRef.groupId}:join-code`,
        action: 'invite'
    });
    if (!governance.allowed) {
        return rejectedByGroupPolicy({ command, read, facts, denial: governance });
    }
    const materialized = materializedRotateJoinCode(command, facts);
    if (!facts.joinCodeVerifier) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: 'Join code verifier is required'
        });
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const next: Group = {
        ...stored.value,
        metadata: mergeJoinCode(stored.value.metadata, {
            version: RALLAR_GROUP_JOIN_CODE_VERSION,
            verifier: facts.joinCodeVerifier,
            expiresAtEpochMs: materialized.expiresAtEpochMs,
            rotatedAtEpochMs: facts.nowEpochMs
        }),
        snapshotVersion: stored.value.snapshotVersion + 1,
        metadataVersion: stored.value.metadataVersion + 1,
        updated: audit
    };
    return groupWrite({ command, read, facts, group: next, eventType: 'group-updated' });
}

function groupWrite(input: GroupWriteInput): GroupMutationComputed {
    const { command, eventType, facts, group, read } = input;
    const stored = requireGroup(read, command.aggregateRef);
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            operation: 'update',
            value: group,
            expectedRevision: stored.entry.revision
        },
        members: [],
        initialPresenceSummary: null,
        eventType,
        lifecyclePolicy: null,
        publicationGrantEffects: [],
        presenceSummaryWork: 'enqueue'
    });
}

function toUpdateAuthorityDenial(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup'; }>,
    read: GroupMutationRead
): GroupPolicyDenied | null {
    const actor = read.actorMember;
    if (
        !command.input.actorPrincipalId ||
        actor?.principalId !== command.input.actorPrincipalId ||
        actor.status !== 'active' ||
        (actor.role !== 'owner' && actor.role !== 'admin')
    ) {
        return {
            allowed: false,
            code: 'forbidden-role',
            message: 'Only active group owners/admins can update groups.'
        };
    }
    return null;
}

function computeUpdatedGroup(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup'; }>,
    current: Group,
    audit: AuditStamp
): Group {
    const status = command.input.status ?? current.status;
    return transitionGroupLifecycle(
        {
            ...current,
            slug: command.input.slug ?? current.slug,
            displayName: command.input.displayName ?? current.displayName,
            description: command.input.description ?? current.description,
            kind: command.input.kind ?? current.kind,
            joinMode: command.input.joinMode ?? current.joinMode,
            maxMembers: command.input.maxMembers ?? current.maxMembers,
            maxSessionsPerMember: command.input.maxSessionsPerMember ?? current.maxSessionsPerMember,
            metadata: computeUpdatedGroupMetadata({
                current: current.metadata,
                replacement: command.input.metadata,
                directoryListing: command.input.directoryListing,
                maxSpectators: command.input.maxSpectators
            }),
            snapshotVersion: current.snapshotVersion + 1,
            metadataVersion: current.metadataVersion + 1,
            updated: audit,
            expiresAtEpochMs: command.input.expiresAtEpochMs ?? current.expiresAtEpochMs,
            emptySinceEpochMs: command.input.emptySinceEpochMs ?? current.emptySinceEpochMs,
            purgeAfterEpochMs: command.input.purgeAfterEpochMs ?? current.purgeAfterEpochMs
        },
        status,
        audit
    );
}

function transitionGroupLifecycle(group: Group, status: GroupStatus, audit: AuditStamp): Group {
    if (status === 'active') {
        return { ...group, status, archived: null, deleted: null };
    }
    if (status === 'archived') {
        return {
            ...group,
            status,
            archived: group.archived ?? audit,
            deleted: null
        };
    }
    return {
        ...group,
        status,
        archived: group.archived,
        deleted: group.deleted ?? audit
    };
}

function sameGroupIgnoringVersions(current: Group, next: Group): boolean {
    return jsonEquals(
        { ...current, snapshotVersion: 0, metadataVersion: 0, updated: null },
        { ...next, snapshotVersion: 0, metadataVersion: 0, updated: null }
    );
}

export function readJoinCode(metadata: Group['metadata']): JoinCodeMetadata | undefined {
    const value = metadata[RALLAR_GROUP_JOIN_CODE_METADATA_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as Group['metadata'];
    return typeof candidate.version === 'number' &&
            typeof candidate.verifier === 'string' &&
            typeof candidate.expiresAtEpochMs === 'number' &&
            typeof candidate.rotatedAtEpochMs === 'number'
        ? {
            version: candidate.version,
            verifier: candidate.verifier,
            expiresAtEpochMs: candidate.expiresAtEpochMs,
            rotatedAtEpochMs: candidate.rotatedAtEpochMs
        }
        : undefined;
}

interface JoinCodeMetadata {
    readonly version: number;
    readonly verifier: string;
    readonly expiresAtEpochMs: number;
    readonly rotatedAtEpochMs: number;
}

function mergeJoinCode(metadata: Group['metadata'], joinCode: JoinCodeMetadata): Group['metadata'] {
    return { ...metadata, [RALLAR_GROUP_JOIN_CODE_METADATA_KEY]: { ...joinCode } };
}

interface ComputeUpdatedGroupMetadataInput {
    readonly current: Group['metadata'];
    readonly replacement: Group['metadata'] | null;
    readonly directoryListing: GroupDirectoryListing | undefined;
    readonly maxSpectators: number | null;
}

function computeUpdatedGroupMetadata(
    { current, replacement, directoryListing, maxSpectators }: ComputeUpdatedGroupMetadataInput
): Group['metadata'] {
    const metadata = { ...structuredClone(replacement ?? current) };
    // Generic metadata replacement does not own discovery policy, even when it carries a stale copy.
    delete metadata[GROUP_DIRECTORY_LISTING_METADATA_KEY];
    const setting = directoryListing ?? current[GROUP_DIRECTORY_LISTING_METADATA_KEY];
    if (setting !== undefined) {
        metadata[GROUP_DIRECTORY_LISTING_METADATA_KEY] = setting;
    }
    delete metadata[GROUP_SPECTATOR_CAPACITY_METADATA_KEY];
    const spectatorCapacity = maxSpectators ?? current[GROUP_SPECTATOR_CAPACITY_METADATA_KEY];
    if (spectatorCapacity !== undefined) {
        metadata[GROUP_SPECTATOR_CAPACITY_METADATA_KEY] = spectatorCapacity;
    }
    delete metadata[GROUP_RETENTION_METADATA_KEY];
    const retention = readGroupRetentionState(current);
    if (retention !== null) {
        metadata[GROUP_RETENTION_METADATA_KEY] = { ...retention };
    }
    delete metadata[GROUP_SESSION_SCHEDULE_METADATA_KEY];
    const schedule = readGroupSessionSchedule(current);
    if (schedule !== null) {
        metadata[GROUP_SESSION_SCHEDULE_METADATA_KEY] = { ...schedule };
    }
    return metadata;
}

function requireSessionReservations(read: GroupMutationRead) {
    if (read.sessionReservations === null) {
        throw new TypeError('Scheduled room capacity requires reservation state');
    }
    return read.sessionReservations.value;
}
