import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import {
    createRallarGroupDirectorAppointment,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorFromSnapshot
} from '@shared/api/group-director.ts';
import type { AuditStamp, Group, GroupEventType, GroupStatus } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { toExpiredAwareInsertCandidate } from '../../presence/group-expired-state-authority.ts';
import {
    nextInitialGroupSnapshotVersion,
    toInitialGroupPresenceSummaryCandidate
} from '../../presence/group-initial-presence-summary.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import {
    auditStamp,
    computeGroupMutationJoinCode,
    computeGroupMutationWriteResult,
    noOp,
    rejected,
    requireGroup
} from '../group-mutation-result.ts';
import {
    createInitialGroup,
    createInitialOwner,
    createInitialPresenceSummary
} from './create-initial-group-mutation.ts';
import {
    assertGovernance,
    computeGroupCreationRejection,
    toPolicySnapshot,
    validateGroupDirectorAppointment,
    validateGroupUpdate
} from './group-aggregate-mutation-policy.ts';

const RALLAR_GROUP_JOIN_CODE_METADATA_KEY = 'rallarJoinCode';
const RALLAR_GROUP_JOIN_CODE_VERSION = 1;

interface GroupWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly group: Group;
    readonly eventType: GroupEventType;
}

interface JoinCodeMetadata extends ApiJsonObject {
    readonly version: number;
    readonly verifier: string;
    readonly expiresAtEpochMs: number;
    readonly rotatedAtEpochMs: number;
}

export function computeCreate(
    command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const rejection = computeGroupCreationRejection(command, read);
    if (rejection !== null) {
        return rejected({ command, read, facts, ...rejection });
    }
    const audit = auditStamp(command, facts, command.input.createdByPrincipalId);
    const snapshotVersion = nextInitialGroupSnapshotVersion(read.expiredGroupEntry, read.presenceSummary);
    const group = createInitialGroup({ command, audit, snapshotVersion });
    const owner = createInitialOwner(command, audit);
    const summary = createInitialPresenceSummary({ command, read, facts, snapshotVersion });
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: { kind: 'group', ...toExpiredAwareInsertCandidate(read.expiredGroupEntry, group) },
        members: [owner],
        initialPresenceSummary: toInitialGroupPresenceSummaryCandidate(summary, read.presenceSummary),
        presenceAdmission: null,
        eventType: 'group-created',
        presenceSummaryWork: 'enqueue'
    });
}

export function computeUpdate(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const issues = validateGroupUpdate({
        command,
        group: stored.value,
        actorMember: read.actorMember,
        nowEpochMs: facts.nowEpochMs
    });
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const current = stored.value;
    const status = command.input.status ?? current.status;
    const next = transitionGroupLifecycle(
        {
            ...current,
            slug: command.input.slug ?? current.slug,
            displayName: command.input.displayName ?? current.displayName,
            description: command.input.description ?? current.description,
            kind: command.input.kind ?? current.kind,
            joinMode: command.input.joinMode ?? current.joinMode,
            maxMembers: command.input.maxMembers ?? current.maxMembers,
            maxSessionsPerMember: command.input.maxSessionsPerMember ?? current.maxSessionsPerMember,
            metadata: command.input.metadata === null ? current.metadata : structuredClone(command.input.metadata),
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
    if (sameGroupIgnoringVersions(current, next)) {
        return noOp(command, read, facts);
    }
    return groupWrite({
        command,
        read,
        facts,
        group: next,
        eventType: status === 'archived'
            ? 'group-archived'
            : status === 'deleted'
            ? 'group-deleted'
            : 'group-updated'
    });
}

export function computeDirector(
    command: Extract<GroupMutationCommand, { operation: 'appointDirector'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const issues = validateGroupDirectorAppointment(command, read, facts);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    const principalId = command.input.actorPrincipalId as string;
    const sessionId = command.input.actorSessionId as string;
    const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs);
    const appointment = createRallarGroupDirectorAppointment({
        session: { clientId: principalId, sessionId },
        previous: readRallarGroupDirectorFromSnapshot(snapshot),
        now: facts.nowEpochMs,
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
    assertGovernance({ command, read, facts, action: 'invite' });
    const materialized = computeGroupMutationJoinCode(command, facts);
    if (!facts.joinCodeVerifier) {
        throw new GroupMutationRejectedError('Join code verifier is required');
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
        presenceSummaryWork: 'enqueue'
    });
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
        ? (candidate as JoinCodeMetadata)
        : undefined;
}

function mergeJoinCode(metadata: Group['metadata'], joinCode: JoinCodeMetadata): Group['metadata'] {
    return { ...metadata, [RALLAR_GROUP_JOIN_CODE_METADATA_KEY]: joinCode };
}
