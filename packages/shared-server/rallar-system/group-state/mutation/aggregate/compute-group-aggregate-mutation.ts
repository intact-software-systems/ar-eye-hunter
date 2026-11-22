import { allocateLobbyPlaces } from '@shared/api/room-lobbies/room-lobby-allocation.ts';
import { mergeJoinCode } from '../../policy/group-join-code.ts';
import { readRoomLobbyPolicy, ROOM_LOBBY_METADATA_KEY } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import { ROOM_CLOCKS_METADATA_KEY } from '@shared/api/group-deadlines/room-clock.ts';
import { ROOM_DEADLINES_METADATA_KEY } from '@shared/api/group-deadlines/room-deadline.ts';
import {
    createRallarGroupDirectorAppointment,
    isRallarGroupDirectorForSession,
    mergeRallarGroupDirectorMetadata,
    RALLAR_GROUP_DIRECTOR_METADATA_KEY,
    readRallarGroupDirectorAppointment,
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
import { computeGroupClockUpdate } from './compute-group-clock-change.ts';
import { computeGroupDeadlineChange, refuseDirectorTimeChange } from './compute-group-deadline-change.ts';
import { toPolicySnapshot } from './group-aggregate-mutation-policy.ts';

const RALLAR_GROUP_JOIN_CODE_VERSION = 1;

interface GroupWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly group: Group;
    readonly eventType: GroupEventType | null;
}

export function computeUpdate(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const lobbyChange = command.input.roomLobby;
    if (lobbyChange && Object.entries(command.input).some(([key, value]) =>
        !['roomLobby', 'actorPrincipalId', 'actorSessionId', 'reason'].includes(key) && value != null)) {
        return rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message: 'A room lobby change must be a separate update.' });
    }
    if (lobbyChange && lobbyChange.operation !== 'configure' && !command.input.actorPrincipalId) {
        return rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message: 'Releasing a seat requires its account.' });
    }
    if (lobbyChange?.operation === 'wait' && !read.lobbyState?.lobby) {
        return rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message: 'This room has no lobby queue.' });
    }
    const directorEpoch = command.input.roomClock?.expectedDirectorEpoch ?? command.input.roomDeadline?.expectedDirectorEpoch;
    if (directorEpoch !== undefined) {
        const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs);
        const refusal = refuseDirectorTimeChange({
            update: command.input,
            snapshot,
            expectedEpoch: directorEpoch,
            nowEpochMs: facts.attemptAtEpochMs
        });
        if (refusal) {
            return rejected({ command, read, facts, ...refusal });
        }
    }
    else if (!lobbyChange || lobbyChange.operation === 'configure') {
        const authorityDenial = toUpdateAuthorityDenial(command, read);
        if (authorityDenial) {
            return rejectedByGroupPolicy({ command, read, facts, denial: authorityDenial });
        }
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
    if (lobbyChange && lobbyChange.operation !== 'configure') {
        const roster = read.lobbyState?.lobby?.value;
        const principalId = command.input.actorPrincipalId;
        // Settle old offers at the command time even if their expiry delivery is delayed.
        const places = roster && lobbyChange.operation === 'wait'
            ? allocateLobbyPlaces(roster, facts.attemptAtEpochMs, roster.revision + 1)
            : roster;
        const committed = places?.seats.some(seat => seat.principalId === principalId) ||
            places?.waiters.some(waiter => waiter.principalId === principalId);
        if (lobbyChange.operation === 'wait' ? committed : !committed) return noOp(command, read, facts);
        // Serialize with room access changes while keeping the account, trace and request out of public room events.
        return groupWrite({ command, read, facts, group: stored.value, eventType: null });
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const current = stored.value;
    let next = computeUpdatedGroup(command, current, audit);
    if (lobbyChange?.operation === 'configure') {
        const metadata = { ...next.metadata };
        if (lobbyChange.policy) metadata[ROOM_LOBBY_METADATA_KEY] = { ...lobbyChange.policy };
        else delete metadata[ROOM_LOBBY_METADATA_KEY];
        next = { ...next, metadata };
    }
    const change = command.input.roomDeadline;
    if (change !== undefined) {
        const deadline = computeGroupDeadlineChange({ current, next, change, nowEpochMs: facts.attemptAtEpochMs });
        if ('rejectionCode' in deadline) {
            return rejected({ command, read, facts, ...deadline });
        }
        next = deadline;
    }
    const clockCommand = command.input.roomClock;
    if (clockCommand) {
        const updated = computeGroupClockUpdate(next, clockCommand, facts.attemptAtEpochMs);
        if ('rejectionCode' in updated) {
            return rejected({ command, read, facts, ...updated });
        }
        next = updated;
    }
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
    const lobby = readRoomLobbyPolicy(next.metadata);
    if (lobby && (next.kind !== 'room' || next.maxMembers === null || next.maxMembers < 1)) return 'A lobby requires finite room capacity.';
    const schedule = readGroupSessionSchedule(next.metadata);
    if (schedule !== null && (next.kind !== 'room' || next.maxMembers === null || next.maxMembers > 64)) {
        return 'Scheduled rooms require a player capacity of 1 to 64.';
    }
    const snapshot = toPolicySnapshot(read, next, nowEpochMs);
    const occupiedSeats = lobby ? 0 : schedule === null
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
        subscriptionEffects: [],
        subscriptionOutcome: null,
        presenceSummaryWork: eventType === null ? 'none' : 'enqueue'
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
                maxSpectators: command.input.maxSpectators,
                actor: { clientId: command.input.actorPrincipalId, sessionId: command.input.actorSessionId }
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

interface ComputeUpdatedGroupMetadataInput {
    readonly current: Group['metadata'];
    readonly replacement: Group['metadata'] | null;
    readonly directoryListing: GroupDirectoryListing | undefined;
    readonly maxSpectators: number | null;
    readonly actor: GroupMutationActorSession;
}

interface GroupMutationActorSession {
    readonly clientId: string | null;
    readonly sessionId: string | null;
}

function computeUpdatedGroupMetadata(
    { current, replacement, directoryListing, maxSpectators, actor }: ComputeUpdatedGroupMetadataInput
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
    if (Object.hasOwn(current, ROOM_LOBBY_METADATA_KEY)) metadata[ROOM_LOBBY_METADATA_KEY] = current[ROOM_LOBBY_METADATA_KEY];
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
    delete metadata[RALLAR_GROUP_DIRECTOR_METADATA_KEY];
    if (
        Object.hasOwn(current, RALLAR_GROUP_DIRECTOR_METADATA_KEY) &&
        !isDirectorResignation({ current, replacement, actor })
    ) {
        metadata[RALLAR_GROUP_DIRECTOR_METADATA_KEY] = current[RALLAR_GROUP_DIRECTOR_METADATA_KEY];
    }
    if (Object.hasOwn(current, ROOM_CLOCKS_METADATA_KEY)) {
        metadata[ROOM_CLOCKS_METADATA_KEY] = current[ROOM_CLOCKS_METADATA_KEY];
    }
    if (Object.hasOwn(current, ROOM_DEADLINES_METADATA_KEY)) {
        metadata[ROOM_DEADLINES_METADATA_KEY] = current[ROOM_DEADLINES_METADATA_KEY];
    }
    return metadata;
}

function isDirectorResignation(
    { current, replacement, actor }: Pick<ComputeUpdatedGroupMetadataInput, 'current' | 'replacement' | 'actor'>
): boolean {
    if (replacement === null || Object.hasOwn(replacement, RALLAR_GROUP_DIRECTOR_METADATA_KEY)) {
        return false;
    }
    if (actor.clientId === null || actor.sessionId === null) {
        return false;
    }
    return isRallarGroupDirectorForSession(
        readRallarGroupDirectorAppointment(current),
        { clientId: actor.clientId, sessionId: actor.sessionId }
    );
}

function requireSessionReservations(read: GroupMutationRead) {
    if (read.sessionReservations === null) {
        throw new TypeError('Scheduled room capacity requires reservation state');
    }
    return read.sessionReservations.value;
}
