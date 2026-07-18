import type {
    AuditStamp,
    Group,
    GroupEvent,
    GroupEventType,
    GroupJoinMode,
    GroupMember,
    GroupMemberStatus,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupRole,
    GroupSnapshot,
    GroupStateCausalRevision,
    GroupStatus,
} from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type { GroupStateMutationCausalRevision } from '../repositories/StateMutationOutboxRepository.ts';
import {
    canActivateGroupMember,
    canConnectGroupPresenceSession,
    canGovernGroupMember,
    canJoinGroup,
    canMutateActiveGroup,
    type GroupGovernanceAction,
    GroupPolicyDeniedError,
} from '../group-policy.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type {
    ConnectGroupPresenceSessionRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
} from '@shared/api/state-types.ts';
import {
    createRallarGroupDirectorAppointment,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorFromSnapshot,
    resolveRallarGroupDirectorAppointmentEligibility,
} from '@shared/api/group-director.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { toGroupSnapshotStateRevision } from '../repositories/GroupStateRepository.ts';

const DEFAULT_GROUP_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GROUP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RALLAR_GROUP_JOIN_CODE_METADATA_KEY = 'rallarJoinCode';
const RALLAR_GROUP_JOIN_CODE_VERSION = 1;

type NullableActorInput = Readonly<{
    actorPrincipalId: string | null;
    actorSessionId: string | null;
    reason: string | null;
    traceId: string | null;
}>;

type GroupMutationCommandBase = Readonly<{
    aggregateRef: GroupRef;
    commandId: string;
    requestId: string | null;
}>;

export type GroupMutationCommand =
    | (GroupMutationCommandBase & Readonly<{
        operation: 'createGroup';
        input: NullableActorInput & Readonly<{
            slug: string | null;
            displayName: string;
            description: string | null;
            kind: Group['kind'];
            joinMode: GroupJoinMode;
            maxMembers: number | null;
            maxSessionsPerMember: number | null;
            metadata: Readonly<Record<string, unknown>>;
            createdByPrincipalId: string;
            expiresAtEpochMs: number | null;
            purgeAfterEpochMs: number | null;
        }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'updateGroup';
        input: NullableActorInput & Readonly<{
            slug: string | null;
            displayName: string | null;
            description: string | null;
            kind: Group['kind'] | null;
            status: GroupStatus | null;
            joinMode: GroupJoinMode | null;
            maxMembers: number | null;
            maxSessionsPerMember: number | null;
            metadata: Readonly<Record<string, unknown>> | null;
            expiresAtEpochMs: number | null;
            emptySinceEpochMs: number | null;
            purgeAfterEpochMs: number | null;
        }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'appointDirector';
        input: NullableActorInput & Readonly<{ heartbeatTtlMs: number }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'joinGroup' | 'acceptGroupInvite';
        targetPrincipalId: string;
        input: NullableActorInput & Readonly<{
            inviteToken: string | null;
            joinCode: string | null;
        }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'createGroupInvite';
        targetPrincipalId: string;
        input: NullableActorInput & Readonly<{
            invitationExpiresAtEpochMs: number | null;
        }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'revokeGroupInvite' | 'removeGroupMember' |
            'banGroupMember' | 'unbanGroupMember';
        targetPrincipalId: string;
        input: NullableActorInput;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'setGroupMemberRole';
        targetPrincipalId: string;
        input: NullableActorInput & Readonly<{ role: GroupRole }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'transferGroupOwnership';
        targetPrincipalId: string;
        input: NullableActorInput;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'upsertMember';
        targetPrincipalId: string;
        input: NullableActorInput & Readonly<{
            role: GroupRole | null;
            status: GroupMemberStatus;
            invitedByPrincipalId: string | null;
            invitationExpiresAtEpochMs: number | null;
        }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'rotateGroupJoinCode';
        input: NullableActorInput & Readonly<{
            joinCode: string;
            expiresAtEpochMs: number;
        }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'connectPresence';
        sessionId: string;
        input: NullableActorInput & Readonly<{
            principalId: string;
            generationId: string;
            connectedAtEpochMs: number | null;
            lastHeartbeatAtEpochMs: number | null;
            expiresAtEpochMs: number | null;
        }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'heartbeatPresence';
        sessionId: string;
        input: NullableActorInput & Readonly<{
            principalId: string | null;
            generationId: string;
            lastHeartbeatAtEpochMs: number | null;
            expiresAtEpochMs: number | null;
        }>;
    }>)
    | (GroupMutationCommandBase & Readonly<{
        operation: 'disconnectPresence';
        sessionId: string;
        input: NullableActorInput & Readonly<{
            principalId: string | null;
            generationId: string;
            generationVersion: number | null;
            observedExpiresAtEpochMs: number | null;
            disconnectedAtEpochMs: number | null;
            lastHeartbeatAtEpochMs: number | null;
            expiresAtEpochMs: number | null;
        }>;
    }>);

export type GroupMutationReceipt = Readonly<{
    commandId: string;
    commandHash: string;
    outcome: 'applied' | 'no-op' | 'rejected';
    stateRevision: number;
    snapshotVersion: number;
    causalRevision: GroupStateCausalRevision;
    event: Readonly<{ kind: 'none' }> |
        Readonly<{ kind: 'group'; event: GroupEvent }>;
    joinCode: string | null;
    joinCodeExpiresAtEpochMs: number | null;
    rejection: string | null;
}>;

export type GroupMutationIdempotencyRecord = Readonly<{
    requestId: string;
    commandHash: string;
    receipt: GroupMutationReceipt;
}>;

export type GroupMutationRead = Readonly<{
    idempotency: RuntimeStateEntryValue<GroupMutationIdempotencyRecord> | null;
    group: RuntimeStateEntryValue<Group> | null;
    members: readonly GroupMember[];
    targetPresence: RuntimeStateEntryValue<GroupPresenceSession> | null;
    presenceSummary: RuntimeStateEntryValue<GroupPresenceSummary> | null;
    presenceSessions: readonly GroupPresenceSession[];
}>;

export type GroupMutationFacts = Readonly<{
    nowEpochMs: number;
    serviceId: string;
    eventId: string;
    commandHash: string;
    joinCodeVerifier: string | null;
}>;

export type GroupPresenceSummaryRead = Readonly<{
    group: RuntimeStateEntryValue<Group>;
    members: readonly GroupMember[];
    presenceSessions: readonly GroupPresenceSession[];
    current: RuntimeStateEntryValue<GroupPresenceSummary> | null;
}>;

export type GroupPresenceSummaryComputed =
    | Readonly<{
        outcome: 'no-op';
        summary: GroupPresenceSummary;
    }>
    | Readonly<{
        outcome: 'write';
        operation: 'insert' | 'update';
        expectedRevision: number | null;
        summary: GroupPresenceSummary;
    }>;

type GroupGuardCandidate =
    | Readonly<{ kind: 'group'; operation: 'insert'; value: Group }>
    | Readonly<{
        kind: 'group';
        operation: 'update';
        value: Group;
        expectedRevision: number;
    }>;

type PresenceGuardCandidate =
    | Readonly<{
        kind: 'presence';
        operation: 'insert';
        value: GroupPresenceSession;
    }>
    | Readonly<{
        kind: 'presence';
        operation: 'update';
        value: GroupPresenceSession;
        expectedRevision: number;
    }>;

export type GroupMutationOutboxCandidate = Readonly<{
    kind: 'group';
    aggregateRef: GroupRef;
    commandId: string;
    commandHash: string;
    createdAtEpochMs: number;
    acceptedCausalRevision: GroupStateMutationCausalRevision;
    effects: readonly ['group-state-sync', 'group-presence-summary'];
    event: Readonly<{ kind: 'group'; event: GroupEvent }>;
}>;

export type GroupMutationComputed =
    | Readonly<{ outcome: 'replay'; receipt: GroupMutationReceipt }>
    | Readonly<{
        outcome: 'idempotency-conflict';
        existingCommandHash: string;
        receivedCommandHash: string;
    }>
    | Readonly<{
        outcome: 'no-op' | 'rejected';
        receipt: GroupMutationReceipt;
        persistIdempotency: boolean;
    }>
    | Readonly<{
        outcome: 'write';
        guard: GroupGuardCandidate | PresenceGuardCandidate;
        members: readonly GroupMember[];
        initialPresenceSummary: GroupPresenceSummary | null;
        event: GroupEvent;
        receipt: GroupMutationReceipt;
        idempotency: GroupMutationIdempotencyRecord | null;
        outbox: GroupMutationOutboxCandidate;
    }>;

export class GroupMutationRejectedError extends Error {
    readonly status = 400;
    readonly code = 'group-mutation-rejected';

    constructor(message: string) {
        super(message);
        this.name = 'GroupMutationRejectedError';
    }
}

export function validateGroupPresenceMutationRequest(
    operation: 'connectPresence',
    request: unknown,
): asserts request is ConnectGroupPresenceSessionRequest;
export function validateGroupPresenceMutationRequest(
    operation: 'heartbeatPresence',
    request: unknown,
): asserts request is HeartbeatGroupPresenceSessionRequest;
export function validateGroupPresenceMutationRequest(
    operation: 'disconnectPresence',
    request: unknown,
): asserts request is DisconnectGroupPresenceSessionRequest;
export function validateGroupPresenceMutationRequest(
    operation: 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence',
    request: unknown,
): void {
    const value = requireRecord(request, `Group ${operation} request`);
    requireNonEmptyString(
        value.generationId,
        `Group ${operation} generationId`,
    );
    const timestampFields = operation === 'connectPresence'
        ? ['connectedAtEpochMs', 'lastHeartbeatAtEpochMs', 'expiresAtEpochMs']
        : operation === 'heartbeatPresence'
        ? ['lastHeartbeatAtEpochMs', 'expiresAtEpochMs']
        : [
            'disconnectedAtEpochMs',
            'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs',
        ];
    for (const field of timestampFields) {
        const timestamp = value[field];
        if (
            timestamp !== undefined &&
            (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0)
        ) {
            throw new GroupMutationRejectedError(
                `Group ${operation} ${field} must be a non-negative safe integer`,
            );
        }
    }
    const heartbeatAt = value.lastHeartbeatAtEpochMs as number | undefined;
    const expiresAt = value.expiresAtEpochMs as number | undefined;
    if (
        heartbeatAt !== undefined && expiresAt !== undefined &&
        expiresAt < heartbeatAt
    ) {
        throw new GroupMutationRejectedError(
            `Group ${operation} expiresAtEpochMs must not predate lastHeartbeatAtEpochMs`,
        );
    }
    if (operation === 'connectPresence') {
        const connectedAt = value.connectedAtEpochMs as number | undefined;
        if (
            connectedAt !== undefined && heartbeatAt !== undefined &&
            heartbeatAt < connectedAt
        ) {
            throw new GroupMutationRejectedError(
                'Group connectPresence lastHeartbeatAtEpochMs must not predate connectedAtEpochMs',
            );
        }
    }
    if (operation === 'disconnectPresence') {
        const disconnectedAt = value.disconnectedAtEpochMs as number | undefined;
        if (
            disconnectedAt !== undefined && heartbeatAt !== undefined &&
            disconnectedAt < heartbeatAt
        ) {
            throw new GroupMutationRejectedError(
                'Group disconnectPresence disconnectedAtEpochMs must not predate lastHeartbeatAtEpochMs',
            );
        }
    }
}

export function validateGroupMutationCommand(
    command: unknown,
): asserts command is GroupMutationCommand {
    requireJsonSafe(command, 'Group mutation command');
    const value = requireRecord(command, 'Group mutation command');
    if ('commandHash' in value) {
        throw new TypeError('Group mutation command must not contain commandHash');
    }
    requireNonEmptyString(value.operation, 'Group mutation operation');
    if (!GROUP_MUTATION_OPERATIONS.has(value.operation)) {
        throw new TypeError('Group mutation operation is invalid');
    }
    requireNonEmptyString(value.commandId, 'Group mutation commandId');
    if (value.requestId !== null) {
        requireNonEmptyString(value.requestId, 'Group mutation requestId');
    }
    validateGroupRef(value.aggregateRef);
    const input = requireRecord(value.input, 'Group mutation input');
    for (const key of ['actorPrincipalId', 'actorSessionId', 'reason', 'traceId']) {
        if (input[key] !== null) requireNonEmptyString(input[key], `Group mutation ${key}`);
    }
    if ('sessionId' in value) requireNonEmptyString(value.sessionId, 'Group session id');
    if ('targetPrincipalId' in value) {
        requireNonEmptyString(value.targetPrincipalId, 'Group target principal id');
    }
    if (
        value.operation === 'connectPresence' ||
        value.operation === 'heartbeatPresence' ||
        value.operation === 'disconnectPresence'
    ) {
        requireNonEmptyString(input.generationId, 'Group presence generationId');
    }
}

export function computeGroupMutation(input: Readonly<{
    command: GroupMutationCommand;
    read: GroupMutationRead;
    facts: GroupMutationFacts;
}>): GroupMutationComputed {
    const { command, read, facts } = input;
    validateGroupMutationCommand(command);
    validateFacts(facts);
    if (read.idempotency) {
        return read.idempotency.value.commandHash === facts.commandHash
            ? { outcome: 'replay', receipt: read.idempotency.value.receipt }
            : {
                outcome: 'idempotency-conflict',
                existingCommandHash: read.idempotency.value.commandHash,
                receivedCommandHash: facts.commandHash,
            };
    }

    switch (command.operation) {
        case 'createGroup':
            return computeCreate(command, read, facts);
        case 'updateGroup':
            return computeUpdate(command, read, facts);
        case 'appointDirector':
            return computeDirector(command, read, facts);
        case 'joinGroup':
        case 'acceptGroupInvite':
            return computeJoin(command, read, facts);
        case 'createGroupInvite':
            return computeInvite(command, read, facts);
        case 'revokeGroupInvite':
            return computeRevokeInvite(command, read, facts);
        case 'rotateGroupJoinCode':
            return computeRotateJoinCode(command, read, facts);
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'setGroupMemberRole':
            return computeGovernedMember(command, read, facts);
        case 'transferGroupOwnership':
            return computeTransfer(command, read, facts);
        case 'upsertMember':
            return computeUpsertMember(command, read, facts);
        case 'connectPresence':
            return computeConnectPresence(command, read, facts);
        case 'heartbeatPresence':
            return computeHeartbeatPresence(command, read, facts);
        case 'disconnectPresence':
            return computeDisconnectPresence(command, read, facts);
    }
}

export function validateGroupMutation(input: Readonly<{
    command: GroupMutationCommand;
    read: GroupMutationRead;
    facts: GroupMutationFacts;
    computed: GroupMutationComputed;
}>): void {
    validateGroupMutationCommand(input.command);
    validateFacts(input.facts);
    if (input.computed.outcome === 'idempotency-conflict') return;
    const receipt = input.computed.receipt;
    if (receipt.commandHash !== input.facts.commandHash) {
        throw new TypeError('Group mutation receipt hash differs from facts');
    }
    if (input.computed.outcome === 'write') {
        if (input.computed.outbox.commandHash !== input.facts.commandHash) {
            throw new TypeError('Group mutation outbox hash differs from facts');
        }
        if (!jsonEquals(input.computed.event, receipt.event.kind === 'group'
            ? receipt.event.event
            : null)) {
            throw new TypeError('Group mutation receipt event differs from write event');
        }
        if (input.computed.guard.kind === 'presence' && input.computed.members.length > 0) {
            throw new TypeError('Presence mutation must not write group members');
        }
    }
}

export function computeGroupPresenceSummary(input: Readonly<{
    ref: GroupRef;
    read: GroupPresenceSummaryRead;
    nowEpochMs: number;
}>): GroupPresenceSummaryComputed {
    const { ref, read, nowEpochMs } = input;
    const activeMemberIds = new Set(read.members
        .filter((member) => member.status === 'active')
        .map((member) => member.principalId));
    const activeSessions = (read.group.value.status === 'active'
        ? read.presenceSessions.filter((session) =>
            activeMemberIds.has(session.principalId) &&
            session.disconnectedAtEpochMs === undefined &&
            session.expiresAtEpochMs > nowEpochMs
        )
        : [])
        .toSorted((left, right) =>
            left.sessionId.localeCompare(right.sessionId) ||
            left.generationVersion - right.generationVersion
        );
    const activePrincipalIds = [...new Set(
        activeSessions.map((session) => session.principalId),
    )].toSorted();
    const groupRevision = read.group.entry.revision + 1;
    const content = {
        activePrincipalIds,
        activeSessionIds: activeSessions.map((session) => session.sessionId),
        activeSessions,
        activePrincipalCount: activePrincipalIds.length,
        activeSessionCount: activeSessions.length,
    } as const;
    const current = read.current?.value;
    if (current &&
        current.causalRevision.groupRevision === groupRevision &&
        jsonEquals(summaryContent(current), content)) {
        return { outcome: 'no-op', summary: current };
    }
    const summary: GroupPresenceSummary = {
        ...ref,
        causalRevision: {
            groupRevision,
            presenceRevision:
                (current?.causalRevision.presenceRevision ?? 0) + 1,
        },
        ...content,
        computedAtEpochMs: nowEpochMs,
    };
    return {
        outcome: 'write',
        operation: read.current ? 'update' : 'insert',
        expectedRevision: read.current?.entry.revision ?? null,
        summary,
    };
}

export function validateGroupPresenceSummary(input: Readonly<{
    ref: GroupRef;
    read: GroupPresenceSummaryRead;
    computed: GroupPresenceSummaryComputed;
}>): void {
    const { ref, read, computed } = input;
    const summary = computed.summary;
    if (
        summary.applicationId !== ref.applicationId ||
        summary.workspaceId !== ref.workspaceId ||
        summary.groupId !== ref.groupId
    ) {
        throw new TypeError('Group presence summary scope differs from work');
    }
    if (summary.causalRevision.groupRevision !== read.group.entry.revision + 1) {
        throw new TypeError('Group presence summary group revision is stale');
    }
    if (
        !Number.isSafeInteger(summary.causalRevision.presenceRevision) ||
        summary.causalRevision.presenceRevision < 0 ||
        summary.activePrincipalCount !== summary.activePrincipalIds.length ||
        summary.activeSessionCount !== summary.activeSessions.length ||
        summary.activeSessionCount !== summary.activeSessionIds.length
    ) {
        throw new TypeError('Group presence summary counts or revision are invalid');
    }
    if (!jsonEquals(
        summary.activeSessionIds,
        summary.activeSessions.map((session) => session.sessionId),
    )) {
        throw new TypeError('Group presence summary session ids differ from sessions');
    }
    if (read.current) {
        const comparison = compareGroupCausalRevision(
            summary.causalRevision,
            read.current.value.causalRevision,
        );
        if (computed.outcome === 'write' && comparison <= 0) {
            throw new TypeError('Group presence summary write must advance its causal tuple');
        }
        if (
            comparison === 0 &&
            !jsonEquals(summaryContent(summary), summaryContent(read.current.value))
        ) {
            throw new TypeError('Equal group presence summary tuple has different content');
        }
    }
}

function computeCreate(
    command: Extract<GroupMutationCommand, { operation: 'createGroup' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    if (read.group) {
        return rejected(command, read, facts, `Group already exists: ${command.aggregateRef.groupId}`);
    }
    const audit = auditStamp(command, facts, command.input.createdByPrincipalId);
    const group: Group = {
        ...command.aggregateRef,
        ...(command.input.slug === null ? {} : { slug: command.input.slug }),
        displayName: command.input.displayName,
        ...(command.input.description === null ? {} : { description: command.input.description }),
        kind: command.input.kind,
        status: 'active',
        joinMode: command.input.joinMode,
        ...(command.input.maxMembers === null ? {} : { maxMembers: command.input.maxMembers }),
        ...(command.input.maxSessionsPerMember === null
            ? {}
            : { maxSessionsPerMember: command.input.maxSessionsPerMember }),
        metadata: cloneRecord(command.input.metadata),
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: audit,
        updated: audit,
        ...(command.input.expiresAtEpochMs === null
            ? {}
            : { expiresAtEpochMs: command.input.expiresAtEpochMs }),
        ...(command.input.purgeAfterEpochMs === null
            ? {}
            : { purgeAfterEpochMs: command.input.purgeAfterEpochMs }),
    };
    const owner: GroupMember = {
        ...command.aggregateRef,
        principalId: command.input.createdByPrincipalId,
        role: 'owner',
        status: 'active',
        joined: audit,
        updated: audit,
    };
    const summary: GroupPresenceSummary = {
        ...command.aggregateRef,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        activePrincipalIds: [],
        activeSessionIds: [],
        activeSessions: [],
        activePrincipalCount: 0,
        activeSessionCount: 0,
        computedAtEpochMs: facts.nowEpochMs,
    };
    return writeResult(command, read, facts, {
        guard: { kind: 'group', operation: 'insert', value: group },
        members: [owner],
        initialPresenceSummary: summary,
        eventType: 'group-created',
    });
}

function computeUpdate(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const allowsArchivedDeletion = stored.value.status === 'archived' &&
        command.input.status === 'deleted';
    if (!allowsArchivedDeletion) {
        assertActive(stored.value, facts.nowEpochMs);
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const current = stored.value;
    const status = command.input.status ?? current.status;
    const next: Group = {
        ...current,
        ...(command.input.slug === null ? {} : { slug: command.input.slug }),
        displayName: command.input.displayName ?? current.displayName,
        ...(command.input.description === null
            ? {}
            : { description: command.input.description }),
        kind: command.input.kind ?? current.kind,
        status,
        joinMode: command.input.joinMode ?? current.joinMode,
        maxMembers: command.input.maxMembers ?? current.maxMembers,
        maxSessionsPerMember:
            command.input.maxSessionsPerMember ?? current.maxSessionsPerMember,
        metadata: command.input.metadata === null
            ? current.metadata
            : cloneRecord(command.input.metadata),
        snapshotVersion: current.snapshotVersion + 1,
        metadataVersion: current.metadataVersion + 1,
        updated: audit,
        ...(status === 'archived' ? { archived: audit } : {}),
        ...(status === 'deleted' ? { deleted: audit } : {}),
        expiresAtEpochMs: command.input.expiresAtEpochMs ?? current.expiresAtEpochMs,
        emptySinceEpochMs: command.input.emptySinceEpochMs ?? current.emptySinceEpochMs,
        purgeAfterEpochMs: command.input.purgeAfterEpochMs ?? current.purgeAfterEpochMs,
    };
    if (sameGroupIgnoringVersions(current, next)) return noOp(command, read, facts);
    return groupWrite(command, read, facts, next,
        status === 'archived' ? 'group-archived' :
        status === 'deleted' ? 'group-deleted' : 'group-updated');
}

function computeDirector(
    command: Extract<GroupMutationCommand, { operation: 'appointDirector' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertActive(stored.value, facts.nowEpochMs);
    const principalId = command.input.actorPrincipalId;
    const sessionId = command.input.actorSessionId;
    if (!principalId || !sessionId) {
        throw new GroupMutationRejectedError(
            'Forbidden: Cannot appoint a director without a local session.',
        );
    }
    const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
    const eligibility = resolveRallarGroupDirectorAppointmentEligibility({
        snapshot,
        principalId,
        sessionId,
    });
    if (!eligibility.allowed) {
        throw new GroupMutationRejectedError(
            `Forbidden: ${eligibility.reason ?? 'Cannot appoint the browser director.'}`,
        );
    }
    const appointment = createRallarGroupDirectorAppointment({
        session: { clientId: principalId, sessionId },
        previous: readRallarGroupDirectorFromSnapshot(snapshot),
        now: facts.nowEpochMs,
        heartbeatTtlMs: command.input.heartbeatTtlMs,
    });
    const next: Group = {
        ...stored.value,
        metadata: mergeRallarGroupDirectorMetadata(stored.value.metadata, appointment),
        snapshotVersion: stored.value.snapshotVersion + 1,
        metadataVersion: stored.value.metadataVersion + 1,
        updated: auditStamp(command, facts, principalId),
    };
    return groupWrite(command, read, facts, next, 'group-updated');
}

function computeJoin(
    command: Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
    const joinCodeMetadata = readJoinCode(stored.value.metadata);
    assertAllowed(canJoinGroup({
        snapshot,
        actor: {
            principalId: command.input.actorPrincipalId ?? undefined,
            sessionId: command.input.actorSessionId ?? undefined,
        },
        nowEpochMs: facts.nowEpochMs,
        inviteToken: command.input.inviteToken ?? undefined,
        joinCode: command.input.joinCode ?? undefined,
        joinCodeVerifier: facts.joinCodeVerifier ?? undefined,
        expectedJoinCodeVerifier: stored.value.joinMode === 'code'
            ? joinCodeMetadata?.verifier ?? ''
            : undefined,
        joinCodeExpiresAtEpochMs: joinCodeMetadata?.expiresAtEpochMs,
    }));
    const existing = read.members.find((member) =>
        member.principalId === command.targetPrincipalId
    );
    if (existing?.status === 'active') return noOp(command, read, facts);
    const audit = auditStamp(command, facts, command.targetPrincipalId);
    const member: GroupMember = {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: existing?.role ?? 'member',
        status: 'active',
        joined: existing?.joined ?? audit,
        updated: audit,
        ...(existing?.left ? { left: existing.left } : {}),
        ...(existing?.removed ? { removed: existing.removed } : {}),
        ...(existing?.banned ? { banned: existing.banned } : {}),
        ...(existing?.invitedByPrincipalId
            ? { invitedByPrincipalId: existing.invitedByPrincipalId }
            : {}),
        ...(existing?.invitationExpiresAtEpochMs === undefined
            ? {}
            : { invitationExpiresAtEpochMs: existing.invitationExpiresAtEpochMs }),
    };
    return memberWrite(command, read, facts, [member], 'member-joined');
}

function computeInvite(
    command: Extract<GroupMutationCommand, { operation: 'createGroupInvite' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance(command, read, facts, 'invite');
    const existing = findTargetMember(command, read);
    if (existing?.status === 'active') return noOp(command, read, facts);
    if (existing?.status === 'banned') {
        throw new GroupMutationRejectedError('Cannot invite a banned group member.');
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const member: GroupMember = {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: existing?.role ?? 'member',
        status: 'invited',
        joined: existing?.joined ?? audit,
        updated: audit,
        ...(existing?.left ? { left: existing.left } : {}),
        ...(existing?.removed ? { removed: existing.removed } : {}),
        ...(existing?.banned ? { banned: existing.banned } : {}),
        ...(command.input.actorPrincipalId
            ? { invitedByPrincipalId: command.input.actorPrincipalId }
            : {}),
        invitationExpiresAtEpochMs: command.input.invitationExpiresAtEpochMs ??
            facts.nowEpochMs + DEFAULT_GROUP_INVITE_TTL_MS,
    };
    return memberWrite(command, read, facts, [member], 'member-invited');
}

function computeRevokeInvite(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance(command, read, facts, 'remove');
    const existing = findTargetMember(command, read);
    if (existing?.status !== 'invited') return noOp(command, read, facts);
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    return memberWrite(command, read, facts, [{
        ...existing,
        status: 'left',
        updated: audit,
        left: audit,
    }], 'member-left');
}

function computeRotateJoinCode(
    command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertGovernance(command, read, facts, 'invite');
    if (!facts.joinCodeVerifier) {
        throw new GroupMutationRejectedError('Join code verifier is required');
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const next: Group = {
        ...stored.value,
        metadata: mergeJoinCode(stored.value.metadata, {
            version: RALLAR_GROUP_JOIN_CODE_VERSION,
            verifier: facts.joinCodeVerifier,
            expiresAtEpochMs: command.input.expiresAtEpochMs,
            rotatedAtEpochMs: facts.nowEpochMs,
        }),
        snapshotVersion: stored.value.snapshotVersion + 1,
        metadataVersion: stored.value.metadataVersion + 1,
        updated: audit,
    };
    return groupWrite(command, read, facts, next, 'group-updated');
}

function computeGovernedMember(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const action: GroupGovernanceAction = command.operation === 'banGroupMember'
        ? 'ban'
        : command.operation === 'unbanGroupMember'
        ? 'unban'
        : command.operation === 'setGroupMemberRole'
        ? 'promote'
        : 'remove';
    assertGovernance(command, read, facts, action);
    const existing = findTargetMember(command, read);
    if (!existing && command.operation === 'unbanGroupMember') return noOp(command, read, facts);
    if (!existing && command.operation === 'setGroupMemberRole') {
        throw new GroupMutationRejectedError(`Group member not found: ${command.targetPrincipalId}`);
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const base: GroupMember = existing ?? {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: 'member',
        status: 'left',
        joined: audit,
        updated: audit,
    };
    const status = command.operation === 'banGroupMember'
        ? 'banned'
        : command.operation === 'unbanGroupMember'
        ? 'left'
        : command.operation === 'removeGroupMember'
        ? 'removed'
        : base.status;
    const role = command.operation === 'setGroupMemberRole'
        ? command.input.role
        : base.role;
    if (base.status === status && base.role === role) return noOp(command, read, facts);
    assertNotLastOwner(read.members, base, status, role);
    const member: GroupMember = {
        ...base,
        role,
        status,
        updated: audit,
        ...(status === 'removed' ? { removed: audit } : {}),
        ...(status === 'banned' ? { banned: audit } : {}),
    };
    const eventType: GroupEventType = command.operation === 'banGroupMember'
        ? 'member-banned'
        : command.operation === 'unbanGroupMember'
        ? 'member-unbanned'
        : command.operation === 'setGroupMemberRole'
        ? 'member-role-changed'
        : 'member-removed';
    return memberWrite(command, read, facts, [member], eventType);
}

function computeTransfer(
    command: Extract<GroupMutationCommand, { operation: 'transferGroupOwnership' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance(command, read, facts, 'transfer-ownership');
    const actor = read.members.find((member) =>
        member.principalId === command.input.actorPrincipalId
    );
    const target = findTargetMember(command, read);
    if (!actor || actor.status !== 'active' || actor.role !== 'owner') {
        throw new GroupMutationRejectedError('Only an active owner can transfer ownership.');
    }
    if (!target || target.status !== 'active') {
        throw new GroupMutationRejectedError('Ownership target must be active.');
    }
    if (actor.principalId === target.principalId) return noOp(command, read, facts);
    const audit = auditStamp(command, facts, actor.principalId);
    return memberWrite(command, read, facts, [
        { ...actor, role: 'admin', updated: audit },
        { ...target, role: 'owner', updated: audit },
    ], 'ownership-transferred');
}

function computeUpsertMember(
    command: Extract<GroupMutationCommand, { operation: 'upsertMember' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
    if (command.input.status === 'active') {
        assertAllowed(command.input.actorPrincipalId === command.targetPrincipalId
            ? canJoinGroup({
                snapshot,
                actor: {
                    principalId: command.input.actorPrincipalId ?? undefined,
                    sessionId: command.input.actorSessionId ?? undefined,
                },
                nowEpochMs: facts.nowEpochMs,
            })
            : canActivateGroupMember({
                snapshot,
                targetPrincipalId: command.targetPrincipalId,
                nowEpochMs: facts.nowEpochMs,
            }));
    }
    const existing = findTargetMember(command, read);
    const audit = auditStamp(command, facts,
        command.input.actorPrincipalId ?? command.targetPrincipalId);
    const member: GroupMember = {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: command.input.role ?? existing?.role ?? 'member',
        status: command.input.status,
        joined: existing?.joined ?? audit,
        updated: audit,
        ...(command.input.status === 'left' ? { left: audit } : existing?.left
            ? { left: existing.left }
            : {}),
        ...(command.input.status === 'removed' ? { removed: audit } : existing?.removed
            ? { removed: existing.removed }
            : {}),
        ...(command.input.status === 'banned' ? { banned: audit } : existing?.banned
            ? { banned: existing.banned }
            : {}),
        ...(command.input.invitedByPrincipalId
            ? { invitedByPrincipalId: command.input.invitedByPrincipalId }
            : existing?.invitedByPrincipalId
            ? { invitedByPrincipalId: existing.invitedByPrincipalId }
            : {}),
        ...(command.input.invitationExpiresAtEpochMs !== null
            ? { invitationExpiresAtEpochMs: command.input.invitationExpiresAtEpochMs }
            : existing?.invitationExpiresAtEpochMs !== undefined
            ? { invitationExpiresAtEpochMs: existing.invitationExpiresAtEpochMs }
            : {}),
    };
    if (existing && jsonEquals(existing, member)) return noOp(command, read, facts);
    assertNotLastOwner(read.members, existing, member.status, member.role);
    return memberWrite(command, read, facts, [member], memberEventType(member.status));
}

function computeConnectPresence(
    command: Extract<GroupMutationCommand, { operation: 'connectPresence' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const member = read.members.find((entry) =>
        entry.principalId === command.input.principalId
    );
    if (!member || member.status !== 'active') {
        throw new GroupMutationRejectedError(
            `Forbidden: active group member required for presence: ${command.input.principalId}`,
        );
    }
    assertAllowed(canConnectGroupPresenceSession({
        snapshot: toPolicySnapshot(read, facts.nowEpochMs),
        actor: {
            principalId: command.input.principalId,
            sessionId: command.input.actorSessionId ?? undefined,
        },
        sessionId: command.sessionId,
        nowEpochMs: facts.nowEpochMs,
    }));
    const existing = read.targetPresence;
    const connectedAt = command.input.connectedAtEpochMs ?? facts.nowEpochMs;
    if (
        existing && existing.value.generationId !== command.input.generationId &&
        connectedAt <= existing.value.connectedAtEpochMs
    ) {
        return noOp(command, read, facts);
    }
    if (
        existing && existing.value.generationId === command.input.generationId &&
        existing.value.disconnectedAtEpochMs !== undefined
    ) {
        return noOp(command, read, facts);
    }
    const generationVersion = !existing
        ? 1
        : existing.value.generationId === command.input.generationId
        ? existing.value.generationVersion
        : existing.value.generationVersion + 1;
    const session: GroupPresenceSession = {
        ...command.aggregateRef,
        sessionId: command.sessionId,
        principalId: command.input.principalId,
        generationId: command.input.generationId,
        generationVersion,
        connectedAtEpochMs: existing?.value.generationId === command.input.generationId
            ? existing.value.connectedAtEpochMs
            : connectedAt,
        lastHeartbeatAtEpochMs: command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs,
        expiresAtEpochMs: command.input.expiresAtEpochMs ??
            facts.nowEpochMs + DEFAULT_GROUP_SESSION_TTL_MS,
    };
    if (existing && jsonEquals(existing.value, session)) return noOp(command, read, facts);
    return presenceWrite(command, read, facts, session,
        existing ? 'update' : 'insert', 'session-connected');
}

function computeHeartbeatPresence(
    command: Extract<GroupMutationCommand, { operation: 'heartbeatPresence' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const group = requireGroup(read, command.aggregateRef);
    assertActive(group.value, facts.nowEpochMs);
    const existing = read.targetPresence;
    if (!existing) throw new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`);
    if (
        existing.value.generationId !== command.input.generationId ||
        existing.value.disconnectedAtEpochMs !== undefined
    ) return noOp(command, read, facts);
    const member = read.members.find((entry) =>
        entry.principalId === existing.value.principalId
    );
    if (!member || member.status !== 'active') return noOp(command, read, facts);
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (heartbeatAt < existing.value.lastHeartbeatAtEpochMs) return noOp(command, read, facts);
    const session: GroupPresenceSession = {
        ...existing.value,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: command.input.expiresAtEpochMs ?? existing.value.expiresAtEpochMs,
    };
    if (jsonEquals(existing.value, session)) return noOp(command, read, facts);
    return presenceWrite(command, read, facts, session, 'update', 'session-heartbeat');
}

function computeDisconnectPresence(
    command: Extract<GroupMutationCommand, { operation: 'disconnectPresence' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const existing = read.targetPresence;
    if (!existing) throw new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`);
    if (
        existing.value.generationId !== command.input.generationId ||
        (command.input.generationVersion !== null &&
            existing.value.generationVersion !== command.input.generationVersion) ||
        (command.input.observedExpiresAtEpochMs !== null &&
            existing.value.expiresAtEpochMs !== command.input.observedExpiresAtEpochMs) ||
        existing.value.disconnectedAtEpochMs !== undefined
    ) return noOp(command, read, facts);
    const disconnectedAt = command.input.disconnectedAtEpochMs ?? facts.nowEpochMs;
    const session: GroupPresenceSession = {
        ...existing.value,
        lastHeartbeatAtEpochMs: command.input.lastHeartbeatAtEpochMs ??
            existing.value.lastHeartbeatAtEpochMs,
        expiresAtEpochMs: command.input.expiresAtEpochMs ?? existing.value.expiresAtEpochMs,
        disconnectedAtEpochMs: disconnectedAt,
        disconnectReason: command.input.reason ?? 'closed',
    };
    return presenceWrite(command, read, facts, session, 'update', 'session-disconnected');
}

function groupWrite(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    group: Group,
    eventType: GroupEventType,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    return writeResult(command, read, facts, {
        guard: {
            kind: 'group',
            operation: 'update',
            value: group,
            expectedRevision: stored.entry.revision,
        },
        members: [],
        initialPresenceSummary: null,
        eventType,
    });
}

function memberWrite(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    members: readonly GroupMember[],
    eventType: GroupEventType,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const audit = auditStamp(command, facts,
        command.input.actorPrincipalId ?? undefined);
    const group: Group = {
        ...stored.value,
        snapshotVersion: stored.value.snapshotVersion + 1,
        rosterVersion: stored.value.rosterVersion + 1,
        updated: audit,
    };
    return writeResult(command, read, facts, {
        guard: {
            kind: 'group',
            operation: 'update',
            value: group,
            expectedRevision: stored.entry.revision,
        },
        members,
        initialPresenceSummary: null,
        eventType,
    });
}

function presenceWrite(
    command: Extract<GroupMutationCommand, {
        operation: 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence';
    }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    session: GroupPresenceSession,
    operation: 'insert' | 'update',
    eventType: GroupEventType,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const guard = operation === 'insert'
        ? { kind: 'presence', operation: 'insert', value: session } as const
        : {
            kind: 'presence',
            operation: 'update',
            value: session,
            expectedRevision: read.targetPresence!.entry.revision,
        } as const;
    return writeResult(command, read, facts, {
        guard,
        members: [],
        initialPresenceSummary: null,
        eventType,
        eventGroup: stored.value,
    });
}

function writeResult(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    input: Readonly<{
        guard: GroupGuardCandidate | PresenceGuardCandidate;
        members: readonly GroupMember[];
        initialPresenceSummary: GroupPresenceSummary | null;
        eventType: GroupEventType;
        eventGroup?: Group;
    }>,
): GroupMutationComputed {
    const group = input.eventGroup ??
        (input.guard.kind === 'group' ? input.guard.value : requireGroup(read, command.aggregateRef).value);
    const groupRevision = input.guard.kind === 'group'
        ? input.guard.operation === 'insert'
            ? 1
            : input.guard.expectedRevision + 2
        : requireGroup(read, command.aggregateRef).entry.revision + 1;
    const presenceRevision = read.presenceSummary?.value.causalRevision.presenceRevision ?? 0;
    const causalRevision = { groupRevision, presenceRevision };
    const event = newGroupEvent(input.eventType, group, command, facts);
    const receipt = receiptFor(command, facts, {
        outcome: 'applied',
        causalRevision,
        snapshotVersion: group.snapshotVersion,
        event: { kind: 'group', event },
        rejection: null,
    });
    const idempotency = command.requestId === null ? null : {
        requestId: command.requestId,
        commandHash: facts.commandHash,
        receipt,
    };
    return {
        outcome: 'write',
        guard: input.guard,
        members: input.members,
        initialPresenceSummary: input.initialPresenceSummary,
        event,
        receipt,
        idempotency,
        outbox: {
            kind: 'group',
            aggregateRef: command.aggregateRef,
            commandId: command.commandId,
            commandHash: facts.commandHash,
            createdAtEpochMs: facts.nowEpochMs,
            acceptedCausalRevision: {
                kind: 'group',
                stateRevision: toGroupSnapshotStateRevision(
                    causalRevision.groupRevision,
                    causalRevision.presenceRevision,
                ),
                snapshotVersion: group.snapshotVersion,
                metadataVersion: group.metadataVersion,
                rosterVersion: group.rosterVersion,
                presenceVersion: causalRevision.presenceRevision,
            },
            effects: ['group-state-sync', 'group-presence-summary'],
            event: { kind: 'group', event },
        },
    };
}

function noOp(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const causalRevision = currentCausalRevision(read);
    return {
        outcome: 'no-op',
        receipt: receiptFor(command, facts, {
            outcome: 'no-op',
            causalRevision,
            snapshotVersion: stored.value.snapshotVersion,
            event: { kind: 'none' },
            rejection: null,
        }),
        persistIdempotency: command.requestId !== null,
    };
}

function rejected(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    message: string,
): GroupMutationComputed {
    const causalRevision = currentCausalRevision(read);
    return {
        outcome: 'rejected',
        receipt: receiptFor(command, facts, {
            outcome: 'rejected',
            causalRevision,
            snapshotVersion: read.group?.value.snapshotVersion ?? 0,
            event: { kind: 'none' },
            rejection: message,
        }),
        persistIdempotency: command.requestId !== null,
    };
}

function receiptFor(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    input: Readonly<{
        outcome: GroupMutationReceipt['outcome'];
        causalRevision: GroupStateCausalRevision;
        snapshotVersion: number;
        event: GroupMutationReceipt['event'];
        rejection: string | null;
    }>,
): GroupMutationReceipt {
    return {
        commandId: command.commandId,
        commandHash: facts.commandHash,
        outcome: input.outcome,
        stateRevision: toGroupSnapshotStateRevision(
            input.causalRevision.groupRevision,
            input.causalRevision.presenceRevision,
        ),
        snapshotVersion: input.snapshotVersion,
        causalRevision: input.causalRevision,
        event: input.event,
        joinCode: command.operation === 'rotateGroupJoinCode'
            ? command.input.joinCode
            : null,
        joinCodeExpiresAtEpochMs: command.operation === 'rotateGroupJoinCode'
            ? command.input.expiresAtEpochMs
            : null,
        rejection: input.rejection,
    };
}

function currentCausalRevision(read: GroupMutationRead): GroupStateCausalRevision {
    return {
        groupRevision: read.group ? read.group.entry.revision + 1 : 0,
        presenceRevision: read.presenceSummary?.value.causalRevision.presenceRevision ?? 0,
    };
}

function toPolicySnapshot(read: GroupMutationRead, nowEpochMs: number): GroupSnapshot {
    const stored = requireGroup(read, { applicationId: '', groupId: '' });
    const activeMemberIds = new Set(read.members
        .filter((member) => member.status === 'active')
        .map((member) => member.principalId));
    const activeSessions = read.presenceSessions.filter((session) =>
        activeMemberIds.has(session.principalId) &&
        session.disconnectedAtEpochMs === undefined &&
        session.expiresAtEpochMs > nowEpochMs
    );
    const activePrincipals = new Set(activeSessions.map((session) => session.principalId));
    const causalRevision = currentCausalRevision(read);
    return {
        stateRevision: toGroupSnapshotStateRevision(
            causalRevision.groupRevision,
            causalRevision.presenceRevision,
        ),
        causalRevision,
        group: {
            ...stored.value,
            presenceVersion: causalRevision.presenceRevision,
        },
        members: read.members,
        activeSessions,
        memberCount: activeMemberIds.size,
        onlineMemberCount: [...activeMemberIds]
            .filter((principalId) => activePrincipals.has(principalId)).length,
    };
}

function requireGroup(
    read: GroupMutationRead,
    ref: GroupRef,
): RuntimeStateEntryValue<Group> {
    if (!read.group) throw new GroupMutationRejectedError(`Group not found: ${ref.groupId}`);
    return read.group;
}

function assertActive(group: Group, nowEpochMs: number): void {
    assertAllowed(canMutateActiveGroup({ group, nowEpochMs }));
}

function assertGovernance(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string }> |
        Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    action: GroupGovernanceAction,
): void {
    const stored = requireGroup(read, command.aggregateRef);
    assertActive(stored.value, facts.nowEpochMs);
    assertAllowed(canGovernGroupMember({
        snapshot: toPolicySnapshot(read, facts.nowEpochMs),
        actor: {
            principalId: command.input.actorPrincipalId ?? undefined,
            sessionId: command.input.actorSessionId ?? undefined,
        },
        targetPrincipalId: 'targetPrincipalId' in command
            ? command.targetPrincipalId
            : `${command.aggregateRef.groupId}:join-code`,
        action,
    }));
}

function assertAllowed(result: GroupPolicyResult): void {
    if (result.allowed) return;
    throw new GroupPolicyDeniedError(result);
}

function findTargetMember(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
    read: GroupMutationRead,
): GroupMember | undefined {
    return read.members.find((member) =>
        member.principalId === command.targetPrincipalId
    );
}

function assertNotLastOwner(
    members: readonly GroupMember[],
    existing: GroupMember | undefined,
    nextStatus: GroupMemberStatus,
    nextRole: GroupRole,
): void {
    if (!existing || existing.role !== 'owner' || existing.status !== 'active') return;
    if (nextStatus === 'active' && nextRole === 'owner') return;
    const otherOwner = members.some((member) =>
        member.principalId !== existing.principalId &&
        member.role === 'owner' && member.status === 'active'
    );
    if (!otherOwner) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'last-owner',
            message: 'Cannot remove or demote the last active owner.',
        });
    }
}

function auditStamp(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    fallbackPrincipalId: string | undefined,
): AuditStamp {
    return {
        atEpochMs: facts.nowEpochMs,
        ...(command.input.actorPrincipalId ?? fallbackPrincipalId
            ? { byPrincipalId: command.input.actorPrincipalId ?? fallbackPrincipalId }
            : {}),
        ...(command.input.actorSessionId
            ? { bySessionId: command.input.actorSessionId }
            : {}),
        byServiceId: facts.serviceId,
        ...(command.input.reason ? { reason: command.input.reason } : {}),
        ...(command.input.traceId ? { traceId: command.input.traceId } : {}),
        ...(command.requestId ? { requestId: command.requestId } : {}),
    };
}

function newGroupEvent(
    eventType: GroupEventType,
    group: Group,
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
): GroupEvent {
    return {
        applicationId: group.applicationId,
        ...(group.workspaceId ? { workspaceId: group.workspaceId } : {}),
        groupId: group.groupId,
        eventId: facts.eventId,
        eventType,
        snapshotVersion: group.snapshotVersion,
        occurredAtEpochMs: facts.nowEpochMs,
        actor: {
            ...(command.input.actorPrincipalId
                ? { principalId: command.input.actorPrincipalId }
                : {}),
            ...(command.input.actorSessionId
                ? { sessionId: command.input.actorSessionId }
                : {}),
            serviceId: facts.serviceId,
        },
        ...(command.input.reason ? { reason: command.input.reason } : {}),
        ...(command.input.traceId ? { traceId: command.input.traceId } : {}),
        ...(command.requestId ? { requestId: command.requestId } : {}),
    };
}

function sameGroupIgnoringVersions(current: Group, next: Group): boolean {
    return jsonEquals(
        { ...current, snapshotVersion: 0, metadataVersion: 0, updated: null },
        { ...next, snapshotVersion: 0, metadataVersion: 0, updated: null },
    );
}

function memberEventType(status: GroupMemberStatus): GroupEventType {
    switch (status) {
        case 'invited': return 'member-invited';
        case 'active': return 'member-joined';
        case 'left': return 'member-left';
        case 'removed': return 'member-removed';
        case 'banned': return 'member-banned';
    }
}

type JoinCodeMetadata = Readonly<{
    version: number;
    verifier: string;
    expiresAtEpochMs: number;
    rotatedAtEpochMs: number;
}>;

function readJoinCode(metadata: Readonly<Record<string, unknown>>): JoinCodeMetadata | undefined {
    const value = metadata[RALLAR_GROUP_JOIN_CODE_METADATA_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.version === 'number' &&
            typeof candidate.verifier === 'string' &&
            typeof candidate.expiresAtEpochMs === 'number' &&
            typeof candidate.rotatedAtEpochMs === 'number'
        ? candidate as JoinCodeMetadata
        : undefined;
}

function mergeJoinCode(
    metadata: Readonly<Record<string, unknown>>,
    joinCode: JoinCodeMetadata,
): Record<string, unknown> {
    return { ...metadata, [RALLAR_GROUP_JOIN_CODE_METADATA_KEY]: joinCode };
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return structuredClone(value) as Record<string, unknown>;
}

function summaryContent(summary: GroupPresenceSummary): Readonly<{
    activePrincipalIds: readonly string[];
    activeSessionIds: readonly string[];
    activeSessions: readonly GroupPresenceSession[];
    activePrincipalCount: number;
    activeSessionCount: number;
}> {
    return {
        activePrincipalIds: summary.activePrincipalIds,
        activeSessionIds: summary.activeSessionIds,
        activeSessions: summary.activeSessions,
        activePrincipalCount: summary.activePrincipalCount,
        activeSessionCount: summary.activeSessionCount,
    };
}

export function compareGroupCausalRevision(
    left: GroupStateCausalRevision,
    right: GroupStateCausalRevision,
): -1 | 0 | 1 {
    const leftAtLeast = left.groupRevision >= right.groupRevision &&
        left.presenceRevision >= right.presenceRevision;
    const rightAtLeast = right.groupRevision >= left.groupRevision &&
        right.presenceRevision >= left.presenceRevision;
    if (leftAtLeast && rightAtLeast) return 0;
    if (leftAtLeast) return 1;
    if (rightAtLeast) return -1;
    throw new TypeError('Group causal revisions are incomparable');
}

function validateFacts(facts: GroupMutationFacts): void {
    if (!Number.isSafeInteger(facts.nowEpochMs) || facts.nowEpochMs < 0) {
        throw new TypeError('Group mutation timestamp is invalid');
    }
    requireNonEmptyString(facts.serviceId, 'Group mutation serviceId');
    requireNonEmptyString(facts.eventId, 'Group mutation eventId');
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new TypeError('Group mutation commandHash is invalid');
    }
}

function validateGroupRef(value: unknown): void {
    const ref = requireRecord(value, 'Group mutation aggregateRef');
    requireNonEmptyString(ref.applicationId, 'Group applicationId');
    if (ref.workspaceId !== undefined) {
        requireNonEmptyString(ref.workspaceId, 'Group workspaceId');
    }
    requireNonEmptyString(ref.groupId, 'Group groupId');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
}

function requireJsonSafe(value: unknown, label: string): void {
    const seen = new Set<object>();
    const visit = (current: unknown): void => {
        if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
        if (typeof current === 'number') {
            if (!Number.isFinite(current) || Object.is(current, -0)) {
                throw new TypeError(`${label} must contain only JSON-safe numbers`);
            }
            return;
        }
        if (typeof current !== 'object') throw new TypeError(`${label} must be JSON-safe`);
        if (seen.has(current)) throw new TypeError(`${label} must not be cyclic`);
        seen.add(current);
        if (Array.isArray(current)) {
            for (const entry of current) visit(entry);
        } else {
            const prototype = Object.getPrototypeOf(current);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new TypeError(`${label} must use plain objects`);
            }
            for (const [key, entry] of Object.entries(current)) {
                if (entry === undefined) throw new TypeError(`${label}.${key} must be present`);
                visit(entry);
            }
        }
        seen.delete(current);
    };
    visit(value);
}

const GROUP_MUTATION_OPERATIONS = new Set([
    'createGroup',
    'updateGroup',
    'appointDirector',
    'joinGroup',
    'acceptGroupInvite',
    'createGroupInvite',
    'revokeGroupInvite',
    'rotateGroupJoinCode',
    'removeGroupMember',
    'banGroupMember',
    'unbanGroupMember',
    'setGroupMemberRole',
    'transferGroupOwnership',
    'upsertMember',
    'connectPresence',
    'heartbeatPresence',
    'disconnectPresence',
]);
