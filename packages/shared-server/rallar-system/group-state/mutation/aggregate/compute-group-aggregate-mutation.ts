import {
    createRallarGroupDirectorAppointment,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorFromSnapshot,
    resolveRallarGroupDirectorAppointmentEligibility
} from '@shared/api/group-director.ts';
import { validateGroupLifecyclePolicy } from '@shared/api/group-lifecycle/validate-group-lifecycle-policy.ts';
import type { AuditStamp, Group, GroupEventType, GroupStatus } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
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
    computeGroupMutationWriteResult,
    materializedRotateJoinCode,
    noOp,
    rejected,
    requireGroup
} from '../group-mutation-result.ts';
import {
    createInitialGroup,
    createInitialOwner,
    createInitialPresenceSummary
} from './create-initial-group-mutation.ts';
import { assertActive, assertGovernance, toPolicySnapshot } from './group-aggregate-mutation-policy.ts';

const RALLAR_GROUP_JOIN_CODE_METADATA_KEY = 'rallarJoinCode';
const RALLAR_GROUP_JOIN_CODE_VERSION = 1;

interface GroupWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly group: Group;
    readonly eventType: GroupEventType;
}

export function computeCreate(
    command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    if (command.input.actorPrincipalId !== command.input.createdByPrincipalId) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: 'Creator authority does not match createdByPrincipalId'
        });
    }
    if (read.group) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-already-exists',
            message: `Group already exists: ${command.aggregateRef.groupId}`
        });
    }
    const policyIssues = command.input.lifecyclePolicy === undefined
        ? []
        : (validateGroupLifecyclePolicy(command.input.lifecyclePolicy).left ?? []);
    if (policyIssues.length > 0) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Group lifecycle policy is not coherent: ${
                policyIssues
                    .map((issue) => `${issue.field} ${issue.code}`)
                    .join('; ')
            }`
        });
    }
    const audit = auditStamp(command, facts, command.input.createdByPrincipalId);
    const snapshotVersion = nextInitialGroupSnapshotVersion(
        read.expiredGroupEntry,
        read.presenceSummary
    );
    const group = createInitialGroup({ command, audit, snapshotVersion });
    const owner = createInitialOwner(command, audit);
    const summary = createInitialPresenceSummary({ command, read, facts, snapshotVersion });
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            ...toExpiredAwareInsertCandidate(read.expiredGroupEntry, group)
        },
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
    assertUpdateAuthority(command, read);
    const allowsArchivedDeletion = stored.value.status === 'archived' && command.input.status === 'deleted';
    if (!allowsArchivedDeletion) {
        assertActive(stored.value, facts.nowEpochMs);
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
            metadata: command.input.metadata === null ? current.metadata : cloneRecord(command.input.metadata),
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
    if (next.maxMembers !== null && next.maxMembers < next.activeMemberCount) {
        throw new GroupMutationRejectedError(
            'Group maxMembers cannot be lower than activeMemberCount.'
        );
    }
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
    assertActive(stored.value, facts.nowEpochMs);
    const principalId = command.input.actorPrincipalId;
    const sessionId = command.input.actorSessionId;
    if (!principalId || !sessionId) {
        throw new GroupMutationRejectedError(
            'Forbidden: Cannot appoint a director without a local session.'
        );
    }
    const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs);
    const eligibility = resolveRallarGroupDirectorAppointmentEligibility({
        snapshot,
        principalId,
        sessionId
    });
    if (!eligibility.allowed) {
        throw new GroupMutationRejectedError(
            `Forbidden: ${eligibility.reason ?? 'Cannot appoint the browser director.'}`
        );
    }
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
    const materialized = materializedRotateJoinCode(command, facts);
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

function assertUpdateAuthority(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup'; }>,
    read: GroupMutationRead
): void {
    const actor = read.actorMember;
    if (
        !command.input.actorPrincipalId ||
        actor?.principalId !== command.input.actorPrincipalId ||
        actor.status !== 'active' ||
        (actor.role !== 'owner' && actor.role !== 'admin')
    ) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'forbidden-role',
            message: 'Only active group owners/admins can update groups.'
        });
    }
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

type JoinCodeMetadata = Readonly<{
    version: number;
    verifier: string;
    expiresAtEpochMs: number;
    rotatedAtEpochMs: number;
}>;

function mergeJoinCode(metadata: Group['metadata'], joinCode: JoinCodeMetadata): Group['metadata'] {
    return { ...metadata, [RALLAR_GROUP_JOIN_CODE_METADATA_KEY]: joinCode };
}

function cloneRecord(value: Group['metadata']): Group['metadata'] {
    return structuredClone(value) as Group['metadata'];
}
