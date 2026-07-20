import type {
    AuditStamp,
    Group,
    GroupEvent,
    GroupEventType,
    GroupJoinMode,
    GroupMember,
    GroupPresenceAdmission,
    GroupMemberStatus,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupRole,
    GroupSnapshot,
    GroupStateCausalRevision,
    GroupStatus,
} from '@shared/api/group-types.ts';
import {
    compareGroupCausalRevision,
    toGroupSnapshotStateRevision,
} from '@shared/api/group-client-views.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
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
    readRallarGroupDirectorAppointment,
    readRallarGroupDirectorFromSnapshot,
    resolveRallarGroupDirectorAppointmentEligibility,
} from '@shared/api/group-director.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey,
} from '../group-state-storage-keys.ts';
import { toStateMutationOutboxId } from '../repositories/StateMutationOutboxRepository.ts';
import { validateGroupEvent } from '../persisted-group-event.ts';
export {
    normalizePersistedGroupEvent,
    validatePersistedGroupEvent,
} from '../persisted-group-event.ts';

const DEFAULT_GROUP_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GROUP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_GROUP_JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
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
            joinCode: string | null;
            expiresAtEpochMs: number | null;
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
    requestId: string | null;
    commandHash: string;
    aggregateRef: GroupRef;
    outcome: 'applied' | 'no-op' | 'rejected';
    attemptCount: number;
    acceptedStorageRevision: number | null;
    stateRevision: number;
    snapshotVersion: number;
    causalRevision: GroupStateCausalRevision;
    eventId: string | null;
    outboxIds: readonly string[];
    joinCode: string | null;
    joinCodeExpiresAtEpochMs: number | null;
    rejection: string | null;
}>;

export type GroupMutationIdempotencyRecord = Readonly<{
    aggregateRef: GroupRef;
    requestId: string;
    commandHash: string;
    receipt: GroupMutationReceipt;
}>;

export type GroupMutationRead = Readonly<{
    idempotency: RuntimeStateEntryValue<GroupMutationIdempotencyRecord> | null;
    group: RuntimeStateEntryValue<Group> | null;
    actorMember: GroupMember | null;
    targetMember: GroupMember | null;
    authorityMember: GroupMember | null;
    directorMember: GroupMember | null;
    actorMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    targetMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    authorityMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    directorMemberEntry: RuntimeStateEntryValue<GroupMember> | null;
    targetPresence: RuntimeStateEntryValue<GroupPresenceSession> | null;
    targetAdmission: RuntimeStateEntryValue<GroupPresenceAdmission> | null;
    authorityAdmission: RuntimeStateEntryValue<GroupPresenceAdmission> | null;
    directorAdmission: RuntimeStateEntryValue<GroupPresenceAdmission> | null;
    authorityPresenceSessions: readonly GroupPresenceSession[];
    authorityPresenceSessionEntries: readonly RuntimeStateEntryValue<GroupPresenceSession>[];
    presenceSummary: RuntimeStateEntryValue<GroupPresenceSummary> | null;
}>;

export type GroupMutationFacts = Readonly<{
    nowEpochMs: number;
    serviceId: string;
    eventId: string;
    commandHash: string;
    attemptCount: number;
    resolvedJoinCode: string | null;
    joinCodeVerifier: string | null;
    internalAuthority: 'none' | 'expiry' | 'session-cleanup';
    authenticatedAuthority: Readonly<{
        principalId: string;
        sessionId: string;
    }> | null;
}>;

export type GroupPresenceSummaryRead = Readonly<{
    group: RuntimeStateEntryValue<Group>;
    members: readonly RuntimeStateEntryValue<GroupMember>[];
    admissions: readonly RuntimeStateEntryValue<GroupPresenceAdmission>[];
    presenceSessions: readonly RuntimeStateEntryValue<GroupPresenceSession>[];
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
    }>
    | Readonly<{
        kind: 'presence';
        operation: 'delete';
        value: GroupPresenceSession;
        expectedRevision: number;
    }>;

type PresenceAdmissionCandidate =
    | Readonly<{
        operation: 'insert';
        value: GroupPresenceAdmission;
    }>
    | Readonly<{
        operation: 'update';
        value: GroupPresenceAdmission;
        expectedRevision: number;
    }>;

export type GroupMutationOutboxCandidate = Readonly<{
    kind: 'group';
    aggregateRef: GroupRef;
    commandId: string;
    commandHash: string;
    createdAtEpochMs: number;
    acceptedCausalRevision: Readonly<{
        kind: 'group';
        stateRevision: number;
        causalRevision: GroupStateCausalRevision;
        snapshotVersion: number;
        metadataVersion: number;
        rosterVersion: number;
        presenceVersion: number;
    }>;
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
    }>
    | Readonly<{
        outcome: 'write';
        guard: GroupGuardCandidate | PresenceGuardCandidate;
        members: readonly GroupMember[];
        initialPresenceSummary: GroupPresenceSummary | null;
        presenceAdmission: PresenceAdmissionCandidate | null;
        event: GroupEvent;
        receipt: GroupMutationReceipt;
        idempotency: GroupMutationIdempotencyRecord | null;
        outbox: GroupMutationOutboxCandidate;
    }>;

export type GroupMutationIdempotencyProbe =
    | Readonly<{ outcome: 'miss' }>
    | Readonly<{ outcome: 'replay'; receipt: GroupMutationReceipt }>
    | Readonly<{
        outcome: 'idempotency-conflict';
        existingCommandHash: string;
        receivedCommandHash: string;
    }>;

export class GroupMutationRejectedError extends Error {
    readonly status = 400;
    readonly code = 'group-mutation-rejected';

    constructor(message: string) {
        super(message);
        this.name = 'GroupMutationRejectedError';
    }
}

export function validateGroupMutationRequest(
    operation: GroupMutationCommand['operation'],
    request: unknown,
): void {
    requireJsonSafe(request, `Group ${operation} request`);
    const input = requireRecord(request, `Group ${operation} request`);
    assertExactKeys(input, GROUP_MUTATION_REQUEST_KEYS[operation],
        `Group ${operation} request`);
    requireNonEmptyString(input.requestId, `Group ${operation} requestId`);
    requireNonEmptyString(input.actorPrincipalId,
        `Group ${operation} actorPrincipalId`);
    requireNonEmptyString(input.actorSessionId,
        `Group ${operation} actorSessionId`);
    for (const key of ['reason', 'traceId']) {
        if (input[key] !== undefined) {
            requireNonEmptyString(input[key], `Group ${operation} ${key}`);
        }
    }
    const optionalString = (key: string) => {
        if (input[key] !== undefined) {
            requireNonEmptyString(input[key], `Group ${operation} ${key}`);
        }
    };
    const optionalPositiveInteger = (key: string) => {
        if (input[key] !== undefined) {
            requirePositiveSafeInteger(input[key], `Group ${operation} ${key}`);
        }
    };
    switch (operation) {
        case 'createGroup':
            requireNonEmptyString(input.groupId, 'Group createGroup groupId');
            optionalString('slug');
            requireNonEmptyString(input.displayName, 'Group createGroup displayName');
            optionalString('description');
            requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
            if (input.joinMode !== undefined) {
                requireOneOf(input.joinMode, ['invite-only', 'code', 'open'],
                    'Group joinMode');
            }
            optionalPositiveInteger('maxMembers');
            optionalPositiveInteger('maxSessionsPerMember');
            if (input.metadata !== undefined) requireRecord(input.metadata, 'Group metadata');
            requireNonEmptyString(input.createdByPrincipalId,
                'Group createGroup createdByPrincipalId');
            optionalPositiveInteger('expiresAtEpochMs');
            optionalPositiveInteger('purgeAfterEpochMs');
            return;
        case 'updateGroup':
            optionalString('slug');
            optionalString('displayName');
            optionalString('description');
            if (input.kind !== undefined) requireOneOf(input.kind,
                ['party', 'room', 'team', 'custom'], 'Group kind');
            if (input.status !== undefined) requireOneOf(input.status,
                ['active', 'archived', 'deleted'], 'Group status');
            if (input.joinMode !== undefined) requireOneOf(input.joinMode,
                ['invite-only', 'code', 'open'], 'Group joinMode');
            optionalPositiveInteger('maxMembers');
            optionalPositiveInteger('maxSessionsPerMember');
            if (input.metadata !== undefined) requireRecord(input.metadata, 'Group metadata');
            optionalPositiveInteger('expiresAtEpochMs');
            optionalPositiveInteger('emptySinceEpochMs');
            optionalPositiveInteger('purgeAfterEpochMs');
            return;
        case 'appointDirector':
            optionalPositiveInteger('heartbeatTtlMs');
            return;
        case 'joinGroup':
        case 'acceptGroupInvite':
            optionalString('inviteToken');
            optionalString('joinCode');
            return;
        case 'createGroupInvite':
            optionalPositiveInteger('invitationExpiresAtEpochMs');
            return;
        case 'setGroupMemberRole':
            requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
            return;
        case 'transferGroupOwnership':
            requireNonEmptyString(input.newOwnerPrincipalId,
                'Group transferGroupOwnership newOwnerPrincipalId');
            return;
        case 'upsertMember':
            if (input.role !== undefined) {
                requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
            }
            requireOneOf(input.status,
                ['invited', 'active', 'left', 'removed', 'banned'],
                'Group member status');
            optionalString('invitedByPrincipalId');
            optionalPositiveInteger('invitationExpiresAtEpochMs');
            return;
        case 'rotateGroupJoinCode':
            optionalString('joinCode');
            optionalPositiveInteger('expiresAtEpochMs');
            return;
        case 'connectPresence':
            validateGroupPresenceMutationRequest('connectPresence', request);
            return;
        case 'heartbeatPresence':
            validateGroupPresenceMutationRequest('heartbeatPresence', request);
            return;
        case 'disconnectPresence':
            validateGroupPresenceMutationRequest('disconnectPresence', request);
            return;
        case 'revokeGroupInvite':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
            return;
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
    requireJsonSafe(request, `Group ${operation} request`);
    const value = requireRecord(request, `Group ${operation} request`);
    assertExactKeys(value, [
        'requestId', 'actorPrincipalId', 'actorSessionId', 'reason', 'traceId',
        'generationId', 'principalId',
        ...(operation === 'connectPresence' ? ['connectedAtEpochMs'] : []),
        ...(operation === 'disconnectPresence' ? ['disconnectedAtEpochMs'] : []),
        'lastHeartbeatAtEpochMs', 'expiresAtEpochMs',
    ], `Group ${operation} request`);
    requireNonEmptyString(
        value.generationId,
        `Group ${operation} generationId`,
    );
    for (const field of [
        'requestId', 'actorPrincipalId', 'actorSessionId', 'reason', 'traceId',
        'principalId',
    ]) {
        if (value[field] !== undefined) {
            requireNonEmptyString(value[field], `Group ${operation} ${field}`);
        }
    }
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
            (!Number.isSafeInteger(timestamp) || (timestamp as number) <= 0)
        ) {
            throw new GroupMutationRejectedError(
                `Group ${operation} ${field} must be a positive safe integer`,
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
    const operation = value.operation as GroupMutationCommand['operation'];
    const hasTarget = TARGET_GROUP_MUTATION_OPERATIONS.has(operation);
    const hasSession = PRESENCE_GROUP_MUTATION_OPERATIONS.has(operation);
    assertExactKeys(value, [
        'operation', 'aggregateRef', 'commandId', 'requestId', 'input',
        ...(hasTarget ? ['targetPrincipalId'] : []),
        ...(hasSession ? ['sessionId'] : []),
    ], 'Group mutation command');
    requireNonEmptyString(value.commandId, 'Group mutation commandId');
    if (value.requestId !== null) {
        requireNonEmptyString(value.requestId, 'Group mutation requestId');
    }
    validateGroupRef(value.aggregateRef);
    const input = requireRecord(value.input, 'Group mutation input');
    assertExactKeys(input, GROUP_MUTATION_INPUT_KEYS[operation],
        `Group ${operation} input`);
    for (const key of ['actorPrincipalId', 'actorSessionId', 'reason', 'traceId']) {
        if (input[key] !== null) requireNonEmptyString(input[key], `Group mutation ${key}`);
    }
    if ('sessionId' in value) requireNonEmptyString(value.sessionId, 'Group session id');
    if ('targetPrincipalId' in value) {
        requireNonEmptyString(value.targetPrincipalId, 'Group target principal id');
    }
    if (hasSession) {
        requireNonEmptyString(input.generationId, 'Group presence generationId');
    }
    validateOperationInput(operation, input);
}

export function computeGroupMutation(input: Readonly<{
    command: GroupMutationCommand;
    read: GroupMutationRead;
    facts: GroupMutationFacts;
}>): GroupMutationComputed {
    const { command, read, facts } = input;
    validateGroupMutationCommand(command);
    validateGroupMutationRead(read, command);
    validateFacts(facts);
    validateTrustedAuthorityMode(command, facts);
    const idempotency = probeGroupMutationIdempotency(
        command,
        read,
        facts.commandHash,
    );
    if (idempotency.outcome !== 'miss') return idempotency;

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

export function probeGroupMutationIdempotency(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    commandHash: string,
): GroupMutationIdempotencyProbe {
    validateGroupMutationCommand(command);
    validateGroupMutationRead(read, command);
    validateCommandHash(commandHash, 'Group mutation commandHash');
    if (!read.idempotency) return { outcome: 'miss' };
    const record = read.idempotency.value;
    if (record.receipt.commandId !== command.commandId) {
        throw new TypeError(
            'Stored group idempotency receipt command differs from command identity',
        );
    }
    return record.commandHash === commandHash
        ? { outcome: 'replay', receipt: record.receipt }
        : {
            outcome: 'idempotency-conflict',
            existingCommandHash: record.commandHash,
            receivedCommandHash: commandHash,
        };
}

export function validateGroupMutation(input: Readonly<{
    command: GroupMutationCommand;
    read: GroupMutationRead;
    facts: GroupMutationFacts;
    computed: GroupMutationComputed;
}>): void {
    validateGroupMutationCommand(input.command);
    validateGroupMutationRead(input.read, input.command);
    validateFacts(input.facts);
    validateTrustedAuthorityMode(input.command, input.facts);
    requireJsonSafe(input.computed, 'Group mutation computed result');
    validateComputedMutationShape(
        input.command,
        input.read,
        input.facts,
        input.computed,
    );
    const canonical = computeGroupMutation({
        command: input.command,
        read: input.read,
        facts: input.facts,
    });
    if (!jsonEquals(input.computed, canonical)) {
        throw new TypeError(
            `Group ${input.command.operation} mutation differs from its canonical deterministic projection`,
        );
    }
    if (input.computed.outcome === 'idempotency-conflict') return;
    const receipt = input.computed.receipt;
    if (receipt.commandHash !== input.facts.commandHash) {
        throw new TypeError('Group mutation receipt hash differs from facts');
    }
    if (input.computed.outcome === 'write') {
        validateComputedRosterFacts(input.read, input.computed);
        if (input.computed.presenceAdmission) {
            validatePresenceAdmission(input.computed.presenceAdmission.value);
        }
        if (input.computed.outbox.commandHash !== input.facts.commandHash) {
            throw new TypeError('Group mutation outbox hash differs from facts');
        }
        if (input.computed.event.eventId !== receipt.eventId) {
            throw new TypeError('Group mutation receipt event differs from write event');
        }
        if (input.computed.guard.kind === 'presence' && input.computed.members.length > 0) {
            throw new TypeError('Presence mutation must not write group members');
        }
    }
}

function validateGroupMutationRead(
    read: GroupMutationRead,
    command: GroupMutationCommand,
): void {
    const ref = command.aggregateRef;
    requireJsonSafe(read, 'Group mutation read');
    assertExactKeys(read as unknown as Record<string, unknown>, [
        'idempotency', 'group', 'actorMember', 'targetMember', 'authorityMember',
        'directorMember', 'actorMemberEntry', 'targetMemberEntry',
        'authorityMemberEntry', 'directorMemberEntry', 'targetPresence', 'targetAdmission',
        'authorityAdmission', 'directorAdmission', 'authorityPresenceSessions',
        'authorityPresenceSessionEntries', 'presenceSummary',
    ], 'Group mutation read');
    assertRequiredKeys(read as unknown as Record<string, unknown>, [
        'idempotency', 'group', 'actorMember', 'targetMember', 'authorityMember',
        'directorMember', 'actorMemberEntry', 'targetMemberEntry',
        'authorityMemberEntry', 'directorMemberEntry', 'targetPresence',
        'targetAdmission', 'authorityAdmission', 'directorAdmission',
        'authorityPresenceSessions', 'authorityPresenceSessionEntries',
        'presenceSummary',
    ], 'Group mutation read');
    if (read.group) {
        validateRuntimeEntryValue(
            read.group,
            'Stored group',
            groupStateGroupStorageKey(ref),
        );
        validateStoredGroup(read.group.value, ref);
    }
    const actorPrincipalId = command.input.actorPrincipalId;
    const targetPrincipalId = mutationTargetPrincipalId(command);
    const ownerPrincipalId = read.group?.value.ownerPrincipalId ?? null;
    const directorPrincipalId = readRallarGroupDirectorAppointment(
        read.group?.value.metadata,
    )?.principalId ?? null;
    validateMemberReadPair(read.actorMember, read.actorMemberEntry, ref,
        actorPrincipalId, 'Actor member');
    validateMemberReadPair(read.targetMember, read.targetMemberEntry, ref,
        targetPrincipalId, 'Target member');
    validateMemberReadPair(read.authorityMember, read.authorityMemberEntry, ref,
        ownerPrincipalId, 'Authority member');
    validateMemberReadPair(read.directorMember, read.directorMemberEntry, ref,
        directorPrincipalId, 'Director member');
    const targetSessionId = mutationTargetSessionId(command);
    if (read.targetPresence) {
        if (targetSessionId === null ||
            read.targetPresence.value.sessionId !== targetSessionId) {
            throw new TypeError(
                'Stored target presence session differs from command slot identity',
            );
        }
        if (targetPrincipalId === null ||
            read.targetPresence.value.principalId !== targetPrincipalId) {
            throw new TypeError(
                'Stored target presence principal differs from command slot identity',
            );
        }
        validateRuntimeEntryValue(
            read.targetPresence,
            'Stored target presence',
            groupStatePresenceSessionStorageKey({ ...ref, sessionId: targetSessionId }),
        );
        validatePresenceSession(read.targetPresence.value, ref,
            'Stored target presence');
    }
    const authorityAdmissionPrincipalId = command.operation === 'appointDirector'
        ? ownerPrincipalId
        : null;
    const directorAdmissionPrincipalId = command.operation === 'appointDirector'
        ? directorPrincipalId
        : null;
    for (const [label, admission, expectedPrincipalId] of [
        ['Target admission', read.targetAdmission, targetPrincipalId],
        ['Authority admission', read.authorityAdmission, authorityAdmissionPrincipalId],
        ['Director admission', read.directorAdmission, directorAdmissionPrincipalId],
    ] as const) {
        if (!admission) continue;
        if (expectedPrincipalId === null ||
            admission.value.principalId !== expectedPrincipalId) {
            throw new TypeError(`${label} principal differs from command slot identity`);
        }
        validateRuntimeEntryValue(
            admission,
            label,
            groupStatePresenceAdmissionStorageKey({
                ...ref,
                principalId: expectedPrincipalId,
            }),
        );
        validatePresenceAdmission(admission.value, ref);
    }
    if (!Array.isArray(read.authorityPresenceSessions) ||
        !Array.isArray(read.authorityPresenceSessionEntries)) {
        throw new TypeError('Authority presence sessions must be arrays');
    }
    if (read.authorityPresenceSessions.length !==
        read.authorityPresenceSessionEntries.length) {
        throw new TypeError('Authority presence sessions differ from stored entries');
    }
    const referencedAuthoritySessions = new Map<string, Readonly<{
        principalId: string;
        generationId: string;
        generationVersion: number;
        connectedAtEpochMs: number;
    }>>();
    for (const admission of [read.authorityAdmission, read.directorAdmission]) {
        if (!admission) continue;
        for (const session of admission.value.admittedSessions) {
            const existing = referencedAuthoritySessions.get(session.sessionId);
            if (existing && existing.principalId !== admission.value.principalId) {
                throw new TypeError(
                    'Stored authority presence session is referenced by multiple principals',
                );
            }
            if (existing && (
                existing.generationId !== session.generationId ||
                existing.generationVersion !== session.generationVersion ||
                existing.connectedAtEpochMs !== session.connectedAtEpochMs
            )) {
                throw new TypeError(
                    'Stored authority presence session has conflicting admission generations',
                );
            }
            referencedAuthoritySessions.set(session.sessionId, {
                principalId: admission.value.principalId,
                generationId: session.generationId,
                generationVersion: session.generationVersion,
                connectedAtEpochMs: session.connectedAtEpochMs,
            });
        }
    }
    read.authorityPresenceSessionEntries.forEach((entry, index) => {
        const expected = referencedAuthoritySessions.get(entry.value.sessionId);
        if (!expected || expected.principalId !== entry.value.principalId ||
            expected.generationId !== entry.value.generationId ||
            expected.generationVersion !== entry.value.generationVersion ||
            expected.connectedAtEpochMs !== entry.value.connectedAtEpochMs) {
            throw new TypeError(
                'Stored authority presence is not referenced by its corresponding admission',
            );
        }
        validateRuntimeEntryValue(
            entry,
            'Stored authority presence',
            groupStatePresenceSessionStorageKey({
                ...ref,
                sessionId: entry.value.sessionId,
            }),
        );
        validatePresenceSession(entry.value, ref, 'Stored authority presence');
        if (!jsonEquals(entry.value, read.authorityPresenceSessions[index])) {
            throw new TypeError('Authority presence session differs from stored entry');
        }
    });
    if (read.presenceSummary) {
        validateRuntimeEntryValue(
            read.presenceSummary,
            'Stored presence summary',
            groupStatePresenceSummaryStorageKey(ref),
        );
        validatePresenceSummaryValue(read.presenceSummary.value, ref);
    }
    if (read.idempotency) {
        if (command.requestId === null ||
            read.idempotency.value.requestId !== command.requestId) {
            throw new TypeError(
                'Stored group idempotency request differs from command identity',
            );
        }
        validateRuntimeEntryValue(
            read.idempotency,
            'Stored group idempotency',
            groupStateIdempotencyStorageKey(ref, command.requestId),
        );
        validateGroupMutationIdempotencyRecord(read.idempotency.value, ref);
    }
}

function validateRuntimeEntryValue<T>(
    stored: RuntimeStateEntryValue<T>,
    label: string,
    expectedKey?: string,
): void {
    const wrapper = requireRecord(stored, label);
    assertExactKeys(wrapper, ['entry', 'value'], label);
    assertRequiredKeys(wrapper, ['entry', 'value'], label);
    const entry = requireRecord(wrapper.entry, `${label} entry`);
    assertExactKeys(entry, [
        'key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision',
    ], `${label} entry`);
    assertRequiredKeys(entry, [
        'key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision',
    ], `${label} entry`);
    requireNonEmptyString(entry.key, `${label} entry key`);
    if (expectedKey !== undefined && entry.key !== expectedKey) {
        throw new TypeError(`${label} entry key is not canonical for its identity`);
    }
    if (typeof entry.value !== 'string') {
        throw new TypeError(`${label} entry value must be serialized JSON`);
    }
    if (!Number.isSafeInteger(entry.expireAtTimestamp) ||
        (entry.expireAtTimestamp as number) < 0) {
        throw new TypeError(`${label} expiry must be a non-negative safe integer`);
    }
    requireNonNegativeSafeInteger(entry.revision, `${label} revision`);
    requireNonEmptyString(entry.updatedTimestamp, `${label} updatedTimestamp`);
    if (Number.isNaN(Date.parse(entry.updatedTimestamp as string))) {
        throw new TypeError(`${label} updatedTimestamp must be an ISO timestamp`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(entry.value as string);
    } catch {
        throw new TypeError(`${label} entry value must be valid JSON`);
    }
    if (!jsonEquals(parsed, wrapper.value)) {
        throw new TypeError(`${label} entry value differs from parsed value`);
    }
}

function validateStoredGroup(group: unknown, ref: GroupRef): asserts group is Group {
    const value = requireRecord(group, 'Stored group value');
    assertExactKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'slug', 'displayName',
        'description', 'kind', 'status', 'joinMode', 'maxMembers',
        'maxSessionsPerMember', 'metadata', 'activeMemberCount',
        'ownerPrincipalId', 'snapshotVersion', 'metadataVersion', 'rosterVersion',
        'presenceVersion', 'created', 'updated', 'archived', 'deleted',
        'expiresAtEpochMs', 'emptySinceEpochMs', 'purgeAfterEpochMs',
    ], 'Stored group value');
    assertRequiredKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'slug', 'displayName',
        'description', 'kind', 'status', 'joinMode', 'maxMembers',
        'maxSessionsPerMember', 'metadata', 'activeMemberCount',
        'ownerPrincipalId', 'snapshotVersion', 'metadataVersion', 'rosterVersion',
        'presenceVersion', 'created', 'updated', 'archived', 'deleted',
        'expiresAtEpochMs', 'emptySinceEpochMs', 'purgeAfterEpochMs',
    ], 'Stored group value');
    validateScopedRecord(value, ref, 'Stored group');
    nullableNonEmptyString(value.slug, 'Stored group slug');
    requireNonEmptyString(value.displayName, 'Stored group displayName');
    nullableNonEmptyString(value.description, 'Stored group description');
    requireOneOf(value.kind, ['party', 'room', 'team', 'custom'], 'Stored group kind');
    requireOneOf(value.status, ['active', 'archived', 'deleted'], 'Stored group status');
    requireOneOf(value.joinMode, ['invite-only', 'code', 'open'],
        'Stored group joinMode');
    nullablePositiveSafeInteger(value.maxMembers, 'Stored group maxMembers');
    nullablePositiveSafeInteger(value.maxSessionsPerMember,
        'Stored group maxSessionsPerMember');
    requireRecord(value.metadata, 'Stored group metadata');
    requirePositiveSafeInteger(value.activeMemberCount, 'Stored group activeMemberCount');
    requireNonEmptyString(value.ownerPrincipalId, 'Stored group ownerPrincipalId');
    requirePositiveSafeInteger(value.snapshotVersion, 'Stored group snapshotVersion');
    requirePositiveSafeInteger(value.metadataVersion, 'Stored group metadataVersion');
    requirePositiveSafeInteger(value.rosterVersion, 'Stored group rosterVersion');
    requireNonNegativeSafeInteger(value.presenceVersion, 'Stored group presenceVersion');
    validateAuditStamp(value.created, 'Stored group created');
    validateAuditStamp(value.updated, 'Stored group updated');
    if (value.archived !== null) validateAuditStamp(value.archived,
        'Stored group archived');
    if (value.deleted !== null) validateAuditStamp(value.deleted,
        'Stored group deleted');
    if (value.status === 'active' &&
        (value.archived !== null || value.deleted !== null)) {
        throw new TypeError('Stored active group lifecycle fields must be null');
    }
    if (value.status === 'archived' &&
        (value.archived === null || value.deleted !== null)) {
        throw new TypeError('Stored archived group lifecycle fields are invalid');
    }
    if (value.status === 'deleted' && value.deleted === null) {
        throw new TypeError('Stored deleted group is missing lifecycle audit');
    }
    nullablePositiveSafeInteger(value.expiresAtEpochMs, 'Stored group expiresAtEpochMs');
    nullablePositiveSafeInteger(value.emptySinceEpochMs, 'Stored group emptySinceEpochMs');
    nullablePositiveSafeInteger(value.purgeAfterEpochMs, 'Stored group purgeAfterEpochMs');
}

function validateMemberReadPair(
    member: GroupMember | null,
    stored: RuntimeStateEntryValue<GroupMember> | null,
    ref: GroupRef,
    expectedPrincipalId: string | null,
    label: string,
): void {
    if ((member === null) !== (stored === null)) {
        throw new TypeError(`${label} differs from stored entry presence`);
    }
    if (!member || !stored) return;
    if (expectedPrincipalId === null || member.principalId !== expectedPrincipalId) {
        throw new TypeError(`${label} principal differs from command slot identity`);
    }
    validateRuntimeEntryValue(
        stored,
        `Stored ${label.toLowerCase()}`,
        groupStateMemberStorageKey({ ...ref, principalId: expectedPrincipalId }),
    );
    validateStoredMember(stored.value, ref, label);
    if (!jsonEquals(member, stored.value)) {
        throw new TypeError(`${label} differs from stored entry value`);
    }
}

function mutationTargetPrincipalId(
    command: GroupMutationCommand,
): string | null {
    if ('targetPrincipalId' in command) return command.targetPrincipalId;
    if (command.operation === 'connectPresence') return command.input.principalId;
    if (command.operation === 'heartbeatPresence' ||
        command.operation === 'disconnectPresence') {
        return command.input.principalId ?? command.input.actorPrincipalId;
    }
    return command.input.actorPrincipalId;
}

function mutationTargetSessionId(command: GroupMutationCommand): string | null {
    if ('sessionId' in command) return command.sessionId;
    return command.operation === 'appointDirector'
        ? command.input.actorSessionId
        : null;
}

function validateStoredMember(
    member: unknown,
    ref: GroupRef,
    label: string,
): asserts member is GroupMember {
    const value = requireRecord(member, `${label} value`);
    assertExactKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'principalId', 'role', 'status',
        'joined', 'updated', 'left', 'removed', 'banned', 'invitedByPrincipalId',
        'invitationExpiresAtEpochMs',
    ], `${label} value`);
    assertRequiredKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'principalId', 'role', 'status',
        'joined', 'updated', 'left', 'removed', 'banned',
        'invitedByPrincipalId', 'invitationExpiresAtEpochMs',
    ], `${label} value`);
    validateScopedRecord(value, ref, label);
    requireNonEmptyString(value.principalId, `${label} principalId`);
    requireOneOf(value.role, ['owner', 'admin', 'member'], `${label} role`);
    requireOneOf(value.status, ['invited', 'active', 'left', 'removed', 'banned'],
        `${label} status`);
    if (value.joined !== null) validateAuditStamp(value.joined, `${label} joined`);
    validateAuditStamp(value.updated, `${label} updated`);
    for (const key of ['left', 'removed', 'banned'] as const) {
        if (value[key] !== null) validateAuditStamp(value[key], `${label} ${key}`);
    }
    const lifecycleKey = value.status === 'left'
        ? 'left'
        : value.status === 'removed'
        ? 'removed'
        : value.status === 'banned'
        ? 'banned'
        : null;
    for (const terminal of ['left', 'removed', 'banned'] as const) {
        if ((terminal === lifecycleKey) !== (value[terminal] !== null)) {
            throw new TypeError(`${label} terminal lifecycle audits are inconsistent`);
        }
    }
    if (value.status === 'invited' && value.joined !== null) {
        throw new TypeError(`${label} invited member joined must be null`);
    }
    if (value.status === 'active' && value.joined === null) {
        throw new TypeError(`${label} active member joined is required`);
    }
    nullableNonEmptyString(value.invitedByPrincipalId, `${label} invitedByPrincipalId`);
    nullablePositiveSafeInteger(value.invitationExpiresAtEpochMs,
        `${label} invitationExpiresAtEpochMs`);
}

function validatePresenceSession(
    session: unknown,
    ref: GroupRef,
    label: string,
): asserts session is GroupPresenceSession {
    const value = requireRecord(session, `${label} value`);
    assertExactKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'sessionId', 'principalId',
        'generationId', 'generationVersion', 'connectedAtEpochMs',
        'lastHeartbeatAtEpochMs', 'expiresAtEpochMs', 'disconnectedAtEpochMs',
        'disconnectReason', 'status',
    ], `${label} value`);
    assertRequiredKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'sessionId', 'principalId',
        'generationId', 'status',
        'generationVersion', 'connectedAtEpochMs', 'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs', 'disconnectedAtEpochMs', 'disconnectReason',
    ], `${label} value`);
    validateScopedRecord(value, ref, label);
    requireNonEmptyString(value.sessionId, `${label} sessionId`);
    requireNonEmptyString(value.principalId, `${label} principalId`);
    requireNonEmptyString(value.generationId, `${label} generationId`);
    requirePositiveSafeInteger(value.connectedAtEpochMs,
        'Stored presence connectedAtEpochMs');
    requirePositiveSafeInteger(value.generationVersion,
        'Stored presence generationVersion');
    if (value.generationVersion !== value.connectedAtEpochMs) {
        throw new TypeError('Stored presence generation order is ambiguous');
    }
    requirePositiveSafeInteger(value.lastHeartbeatAtEpochMs,
        `${label} lastHeartbeatAtEpochMs`);
    requirePositiveSafeInteger(value.expiresAtEpochMs, `${label} expiresAtEpochMs`);
    if (value.lastHeartbeatAtEpochMs < value.connectedAtEpochMs ||
        value.expiresAtEpochMs < value.lastHeartbeatAtEpochMs) {
        throw new TypeError(`${label} timestamps are causally inconsistent`);
    }
    requireOneOf(value.status, ['active', 'disconnected'], `${label} status`);
    nullablePositiveSafeInteger(value.disconnectedAtEpochMs,
        `${label} disconnectedAtEpochMs`);
    nullableNonEmptyString(value.disconnectReason, `${label} disconnectReason`);
    if (value.disconnectedAtEpochMs !== null &&
        value.disconnectedAtEpochMs < value.lastHeartbeatAtEpochMs) {
        throw new TypeError(`${label} disconnect predates heartbeat`);
    }
    if (value.status === 'active' &&
        (value.disconnectedAtEpochMs !== null || value.disconnectReason !== null)) {
        throw new TypeError(`${label} active disconnect fields must be null`);
    }
    if (value.status === 'disconnected' &&
        (value.disconnectedAtEpochMs === null || value.disconnectReason === null)) {
        throw new TypeError(`${label} disconnect lifecycle fields differ`);
    }
}

export function normalizePersistedGroup(
    value: unknown,
    ref: GroupRef,
): Group {
    const legacy = requireRecord(value, 'Stored group value');
    assertExactKeys(legacy, [
        'applicationId', 'workspaceId', 'groupId', 'slug', 'displayName',
        'description', 'kind', 'status', 'joinMode', 'maxMembers',
        'maxSessionsPerMember', 'metadata', 'activeMemberCount',
        'ownerPrincipalId', 'snapshotVersion', 'metadataVersion', 'rosterVersion',
        'presenceVersion', 'created', 'updated', 'archived', 'deleted',
        'expiresAtEpochMs', 'emptySinceEpochMs', 'purgeAfterEpochMs',
    ], 'Stored group value');
    const canonical: unknown = {
        applicationId: legacy.applicationId,
        workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
        groupId: legacy.groupId,
        slug: persistedOrDefault(legacy, 'slug', null),
        displayName: legacy.displayName,
        description: persistedOrDefault(legacy, 'description', null),
        kind: legacy.kind,
        status: legacy.status,
        joinMode: legacy.joinMode,
        maxMembers: persistedOrDefault(legacy, 'maxMembers', null),
        maxSessionsPerMember: persistedOrDefault(
            legacy,
            'maxSessionsPerMember',
            null,
        ),
        metadata: legacy.metadata,
        activeMemberCount: legacy.activeMemberCount,
        ownerPrincipalId: legacy.ownerPrincipalId,
        snapshotVersion: legacy.snapshotVersion,
        metadataVersion: legacy.metadataVersion,
        rosterVersion: legacy.rosterVersion,
        presenceVersion: legacy.presenceVersion,
        created: normalizePersistedGroupAudit(legacy.created, 'Stored group created'),
        updated: normalizePersistedGroupAudit(legacy.updated, 'Stored group updated'),
        archived: normalizeOptionalPersistedGroupAudit(
            legacy,
            'archived',
            'Stored group archived',
        ),
        deleted: normalizeOptionalPersistedGroupAudit(
            legacy,
            'deleted',
            'Stored group deleted',
        ),
        expiresAtEpochMs: persistedOrDefault(legacy, 'expiresAtEpochMs', null),
        emptySinceEpochMs: persistedOrDefault(legacy, 'emptySinceEpochMs', null),
        purgeAfterEpochMs: persistedOrDefault(legacy, 'purgeAfterEpochMs', null),
    };
    validatePersistedGroup(canonical, ref);
    return canonical;
}

export function normalizePersistedGroupMember(
    value: unknown,
    ref: GroupRef,
): GroupMember {
    const legacy = requireRecord(value, 'Stored group member');
    assertExactKeys(legacy, [
        'applicationId', 'workspaceId', 'groupId', 'principalId', 'role', 'status',
        'joined', 'updated', 'left', 'removed', 'banned', 'invitedByPrincipalId',
        'invitationExpiresAtEpochMs',
    ], 'Stored group member');
    const status = legacy.status;
    const joined = status === 'invited'
        ? null
        : Object.hasOwn(legacy, 'joined')
        ? normalizeNullablePersistedGroupAudit(legacy.joined, 'Stored member joined')
        : null;
    const canonical: unknown = {
        applicationId: legacy.applicationId,
        workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
        groupId: legacy.groupId,
        principalId: legacy.principalId,
        role: legacy.role,
        status,
        joined,
        updated: normalizePersistedGroupAudit(legacy.updated, 'Stored member updated'),
        left: normalizeOptionalPersistedGroupAudit(legacy, 'left', 'Stored member left'),
        removed: normalizeOptionalPersistedGroupAudit(
            legacy,
            'removed',
            'Stored member removed',
        ),
        banned: normalizeOptionalPersistedGroupAudit(
            legacy,
            'banned',
            'Stored member banned',
        ),
        invitedByPrincipalId: persistedOrDefault(
            legacy,
            'invitedByPrincipalId',
            null,
        ),
        invitationExpiresAtEpochMs: persistedOrDefault(
            legacy,
            'invitationExpiresAtEpochMs',
            null,
        ),
    };
    validatePersistedGroupMember(canonical, ref);
    return canonical;
}

export function normalizePersistedGroupPresenceSession(
    value: unknown,
    ref: GroupRef,
): GroupPresenceSession {
    const legacy = requireRecord(value, 'Stored group presence session');
    assertExactKeys(legacy, [
        'applicationId', 'workspaceId', 'groupId', 'sessionId', 'principalId',
        'generationId', 'generationVersion', 'status', 'connectedAtEpochMs',
        'lastHeartbeatAtEpochMs', 'expiresAtEpochMs', 'disconnectedAtEpochMs',
        'disconnectReason',
    ], 'Stored group presence session');
    const disconnectedAtEpochMs = persistedOrDefault(
        legacy,
        'disconnectedAtEpochMs',
        null,
    );
    const disconnectReason = persistedOrDefault(legacy, 'disconnectReason', null);
    const canonical: unknown = {
        applicationId: legacy.applicationId,
        workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
        groupId: legacy.groupId,
        sessionId: legacy.sessionId,
        principalId: legacy.principalId,
        generationId: legacy.generationId,
        generationVersion: legacy.generationVersion,
        status: Object.hasOwn(legacy, 'status')
            ? legacy.status
            : disconnectedAtEpochMs === null
            ? 'active'
            : 'disconnected',
        connectedAtEpochMs: legacy.connectedAtEpochMs,
        lastHeartbeatAtEpochMs: legacy.lastHeartbeatAtEpochMs,
        expiresAtEpochMs: legacy.expiresAtEpochMs,
        disconnectedAtEpochMs,
        disconnectReason,
    };
    validatePersistedGroupPresenceSession(canonical, ref);
    return canonical;
}

export function normalizePersistedGroupPresenceSummary(
    value: unknown,
    ref: GroupRef,
): GroupPresenceSummary {
    const legacy = requireRecord(value, 'Stored presence summary value');
    assertExactKeys(legacy, [
        'applicationId', 'workspaceId', 'groupId', 'causalRevision',
        'activePrincipalIds', 'activeSessionIds', 'activeSessions',
        'activePrincipalCount', 'activeSessionCount', 'computedAtEpochMs',
    ], 'Stored presence summary value');
    if (!Array.isArray(legacy.activeSessions)) {
        throw new TypeError('Stored presence summary activeSessions is invalid');
    }
    const activeSessions = legacy.activeSessions.map((session) =>
        normalizePersistedGroupPresenceSession(session, ref)
    );
    const canonical: unknown = {
        ...legacy,
        workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
        activeSessions,
    };
    validatePersistedGroupPresenceSummary(canonical, ref);
    return canonical;
}

export function normalizePersistedGroupPresenceAdmission(
    value: unknown,
    ref: GroupRef,
): GroupPresenceAdmission {
    const legacy = requireRecord(value, 'Presence admission');
    assertExactKeys(legacy, [
        'applicationId', 'workspaceId', 'groupId', 'principalId',
        'admittedSessions', 'updatedAtEpochMs',
    ], 'Presence admission');
    const canonical: unknown = {
        ...legacy,
        workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
    };
    validatePersistedGroupPresenceAdmission(canonical, ref);
    return canonical;
}

export function validatePersistedGroup(
    value: unknown,
    ref: GroupRef,
): asserts value is Group {
    validateStoredGroup(value, ref);
}

export function validatePersistedGroupMember(
    value: unknown,
    ref: GroupRef,
): asserts value is GroupMember {
    validateStoredMember(value, ref, 'Stored group member');
}

export function validatePersistedGroupPresenceSession(
    value: unknown,
    ref: GroupRef,
): asserts value is GroupPresenceSession {
    validatePresenceSession(value, ref, 'Stored group presence session');
}

export function validatePersistedGroupPresenceSummary(
    value: unknown,
    ref: GroupRef,
): asserts value is GroupPresenceSummary {
    validatePresenceSummaryValue(value, ref);
}

export function validatePersistedGroupPresenceAdmission(
    value: unknown,
    ref: GroupRef,
): asserts value is GroupPresenceAdmission {
    validatePresenceAdmission(value, ref);
}

function validatePresenceSummaryValue(
    summary: unknown,
    ref: GroupRef,
): asserts summary is GroupPresenceSummary {
    const value = requireRecord(summary, 'Stored presence summary value');
    assertExactKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'causalRevision',
        'activePrincipalIds', 'activeSessionIds', 'activeSessions',
        'activePrincipalCount', 'activeSessionCount', 'computedAtEpochMs',
    ], 'Stored presence summary value');
    assertRequiredKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'causalRevision', 'activePrincipalIds',
        'activeSessionIds', 'activeSessions', 'activePrincipalCount',
        'activeSessionCount', 'computedAtEpochMs',
    ], 'Stored presence summary value');
    validateScopedRecord(value, ref, 'Stored presence summary');
    validateCausalRevision(value.causalRevision, 'Stored presence summary');
    if (!Array.isArray(value.activePrincipalIds) ||
        !Array.isArray(value.activeSessionIds) ||
        !Array.isArray(value.activeSessions)) {
        throw new TypeError('Stored presence summary collections must be arrays');
    }
    for (const principalId of value.activePrincipalIds) {
        requireNonEmptyString(principalId, 'Stored presence summary principalId');
    }
    for (const sessionId of value.activeSessionIds) {
        requireNonEmptyString(sessionId, 'Stored presence summary sessionId');
    }
    const activeSessions: GroupPresenceSession[] = [];
    for (const session of value.activeSessions) {
        validatePresenceSession(session, ref, 'Stored presence summary session');
        activeSessions.push(session);
    }
    requireNonNegativeSafeInteger(value.activePrincipalCount,
        'Stored presence summary activePrincipalCount');
    requireNonNegativeSafeInteger(value.activeSessionCount,
        'Stored presence summary activeSessionCount');
    requirePositiveSafeInteger(value.computedAtEpochMs,
        'Stored presence summary computedAtEpochMs');
    const canonicalSessions = activeSessions.toSorted((left, right) =>
        left.sessionId.localeCompare(right.sessionId) ||
        left.generationVersion - right.generationVersion
    );
    const canonicalPrincipals = [...new Set(
        activeSessions.map((session) => session.principalId),
    )].toSorted();
    if (value.activePrincipalCount !== value.activePrincipalIds.length ||
        value.activeSessionCount !== value.activeSessionIds.length ||
        value.activeSessionCount !== activeSessions.length ||
        !jsonEquals(value.activePrincipalIds, canonicalPrincipals) ||
        !jsonEquals(activeSessions, canonicalSessions) ||
        !jsonEquals(value.activeSessionIds,
            activeSessions.map((session) => session.sessionId))) {
        throw new TypeError('Stored presence summary facts are inconsistent');
    }
}

export function validateGroupMutationIdempotencyRecord(
    record: unknown,
    ref: GroupRef,
): asserts record is GroupMutationIdempotencyRecord {
    const value = requireRecord(record, 'Stored group idempotency value');
    assertExactKeys(value, ['aggregateRef', 'requestId', 'commandHash', 'receipt'],
        'Stored group idempotency value');
    assertRequiredKeys(value, ['aggregateRef', 'requestId', 'commandHash', 'receipt'],
        'Stored group idempotency value');
    validateGroupRef(value.aggregateRef);
    validateScopedValue(
        value.aggregateRef as GroupRef,
        ref,
        'Stored group idempotency aggregateRef',
    );
    requireNonEmptyString(value.requestId, 'Stored group idempotency requestId');
    validateCommandHash(value.commandHash, 'Stored group idempotency commandHash');
    validateMutationReceipt(value.receipt, ref, 'Stored group idempotency receipt');
    const receipt = value.receipt as GroupMutationReceipt;
    if (receipt.commandHash !== value.commandHash) {
        throw new TypeError('Stored group idempotency hashes differ');
    }
    if (receipt.commandId !== value.requestId) {
        throw new TypeError(
            'Stored group idempotency receipt command differs from request identity',
        );
    }
    if (
        receipt.requestId !== value.requestId ||
        receipt.aggregateRef.applicationId !== ref.applicationId ||
        receipt.aggregateRef.workspaceId !== ref.workspaceId ||
        receipt.aggregateRef.groupId !== ref.groupId
    ) {
        throw new TypeError(
            'Stored group idempotency receipt differs from request identity',
        );
    }
}

function validateComputedMutationShape(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    computed: GroupMutationComputed,
): void {
    const value = computed as unknown as Record<string, unknown>;
    switch (computed.outcome) {
        case 'replay':
        case 'no-op':
        case 'rejected':
            assertExactKeys(value, ['outcome', 'receipt'],
                'Group mutation computed result');
            assertRequiredKeys(value, ['outcome', 'receipt'],
                'Group mutation computed result');
            validateMutationReceipt(computed.receipt, command.aggregateRef,
                'Group mutation computed receipt');
            if (computed.receipt.commandHash !== facts.commandHash) {
                throw new TypeError('Group mutation computed receipt hash differs from facts');
            }
            if (computed.outcome !== 'replay' &&
                computed.receipt.outcome !== computed.outcome) {
                throw new TypeError('Group mutation computed receipt outcome differs');
            }
            return;
        case 'idempotency-conflict':
            assertExactKeys(value, [
                'outcome', 'existingCommandHash', 'receivedCommandHash',
            ], 'Group mutation computed result');
            assertRequiredKeys(value, [
                'outcome', 'existingCommandHash', 'receivedCommandHash',
            ], 'Group mutation computed result');
            validateCommandHash(computed.existingCommandHash,
                'Group mutation existingCommandHash');
            validateCommandHash(computed.receivedCommandHash,
                'Group mutation receivedCommandHash');
            if (computed.receivedCommandHash !== facts.commandHash) {
                throw new TypeError('Group mutation conflict hash differs from facts');
            }
            return;
        case 'write':
            assertExactKeys(value, [
                'outcome', 'guard', 'members', 'initialPresenceSummary',
                'presenceAdmission', 'event', 'receipt', 'idempotency', 'outbox',
            ], 'Group mutation computed result');
            assertRequiredKeys(value, [
                'outcome', 'guard', 'members', 'initialPresenceSummary',
                'presenceAdmission', 'event', 'receipt', 'idempotency', 'outbox',
            ], 'Group mutation computed result');
            validateComputedWrite(command, read, facts, computed);
            return;
    }
}

function validateComputedWrite(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): void {
    const ref = command.aggregateRef;
    const guard = computed.guard as unknown as Record<string, unknown>;
    assertExactKeys(guard, [
        'kind', 'operation', 'value',
        ...(computed.guard.operation === 'insert' ? [] : ['expectedRevision']),
    ], 'Group mutation computed guard');
    assertRequiredKeys(guard, [
        'kind', 'operation', 'value',
        ...(computed.guard.operation === 'insert' ? [] : ['expectedRevision']),
    ], 'Group mutation computed guard');
    requireOneOf(computed.guard.kind, ['group', 'presence'],
        'Group mutation computed guard kind');
    requireOneOf(computed.guard.operation, ['insert', 'update', 'delete'],
        'Group mutation computed guard operation');
    if (computed.guard.operation !== 'insert') {
        requireNonNegativeSafeInteger(computed.guard.expectedRevision,
            'Group mutation computed guard expectedRevision');
    }
    if (computed.guard.kind === 'group') {
        if (guard.operation === 'delete') {
            throw new TypeError('Group mutation cannot use a group delete guard');
        }
        validateStoredGroup(computed.guard.value, ref);
        const expectedRevision = read.group?.entry.revision;
        if (computed.guard.operation === 'insert') {
            if (read.group !== null) {
                throw new TypeError('Group insert guard has an existing predecessor');
            }
        } else if (computed.guard.expectedRevision !== expectedRevision) {
            throw new TypeError('Group update guard revision differs from predecessor');
        }
    } else {
        validatePresenceSession(computed.guard.value, ref,
            'Group mutation computed presence guard');
        const expectedSessionId = mutationTargetSessionId(command);
        const expectedPrincipalId = mutationTargetPrincipalId(command);
        if (expectedSessionId === null || expectedPrincipalId === null ||
            computed.guard.value.sessionId !== expectedSessionId ||
            computed.guard.value.principalId !== expectedPrincipalId) {
            throw new TypeError(
                'Group mutation presence guard differs from command target identity',
            );
        }
        const expectedRevision = read.targetPresence?.entry.revision;
        if (computed.guard.operation === 'insert') {
            if (read.targetPresence !== null) {
                throw new TypeError('Presence insert guard has an existing predecessor');
            }
        } else if (computed.guard.expectedRevision !== expectedRevision) {
            throw new TypeError('Presence write guard revision differs from predecessor');
        }
        if (computed.guard.operation === 'delete' &&
            (command.operation !== 'disconnectPresence' ||
                facts.internalAuthority !== 'expiry' ||
                command.input.reason !== 'expired')) {
            throw new TypeError('Presence delete guard requires expiry authority');
        }
    }
    if (!Array.isArray(computed.members)) {
        throw new TypeError('Group mutation computed members must be an array');
    }
    for (const member of computed.members) {
        validateStoredMember(member, ref, 'Group mutation computed member');
    }
    const expectedMemberPrincipalIds = expectedMutationMemberPrincipalIds(command, read);
    const actualMemberPrincipalIds = computed.members
        .map((member) => member.principalId)
        .toSorted();
    if (!jsonEquals(actualMemberPrincipalIds, expectedMemberPrincipalIds)) {
        throw new TypeError(
            'Group mutation member candidate identity differs from command target',
        );
    }
    if (computed.initialPresenceSummary !== null) {
        validatePresenceSummaryValue(computed.initialPresenceSummary, ref);
    }
    if (computed.presenceAdmission !== null) {
        const admission = computed.presenceAdmission as unknown as Record<string, unknown>;
        assertExactKeys(admission, [
            'operation', 'value',
            ...(computed.presenceAdmission.operation === 'update'
                ? ['expectedRevision']
                : []),
        ], 'Group mutation computed admission');
        assertRequiredKeys(admission, [
            'operation', 'value',
            ...(computed.presenceAdmission.operation === 'update'
                ? ['expectedRevision']
                : []),
        ], 'Group mutation computed admission');
        requireOneOf(computed.presenceAdmission.operation, ['insert', 'update'],
            'Group mutation computed admission operation');
        validatePresenceAdmission(computed.presenceAdmission.value, ref);
        if (computed.presenceAdmission.operation === 'update') {
            requireNonNegativeSafeInteger(computed.presenceAdmission.expectedRevision,
                'Group mutation computed admission expectedRevision');
        }
        const predecessor = read.targetAdmission;
        if (computed.presenceAdmission.operation === 'insert') {
            if (predecessor !== null) {
                throw new TypeError(
                    'Group mutation admission insert has an existing predecessor',
                );
            }
        } else if (
            predecessor === null ||
            computed.presenceAdmission.expectedRevision !== predecessor.entry.revision
        ) {
            throw new TypeError(
                'Group mutation admission update revision differs from predecessor',
            );
        }
        const admittedPrincipalId = computed.presenceAdmission.value.principalId;
        const expectedPrincipalId = mutationTargetPrincipalId(command);
        if (expectedPrincipalId === null || expectedPrincipalId !== admittedPrincipalId) {
            throw new TypeError(
                'Group mutation admission principal differs from command target identity',
            );
        }
    }
    validateGroupEvent(computed.event, ref, 'Group mutation computed event');
    if (computed.event.eventId !== facts.eventId ||
        computed.event.occurredAtEpochMs !== facts.nowEpochMs ||
        (computed.event.requestId ?? null) !== command.requestId ||
        actorPrincipalId(computed.event.actor) !== command.input.actorPrincipalId ||
        actorSessionId(computed.event.actor) !== command.input.actorSessionId) {
        throw new TypeError(
            'Group mutation computed event identity differs from command and facts',
        );
    }
    validateMutationReceipt(computed.receipt, ref, 'Group mutation computed receipt');
    if (computed.receipt.outcome !== 'applied' ||
        computed.receipt.commandId !== command.commandId ||
        computed.receipt.commandHash !== facts.commandHash) {
        throw new TypeError('Group mutation computed receipt differs from command');
    }
    if (computed.idempotency !== null) {
        validateGroupMutationIdempotencyRecord(computed.idempotency, ref);
        if (computed.idempotency.requestId !== command.requestId ||
            !jsonEquals(computed.idempotency.receipt, computed.receipt)) {
            throw new TypeError('Group mutation computed idempotency differs from receipt');
        }
    } else if (command.requestId !== null) {
        throw new TypeError('Group mutation computed idempotency is missing');
    }
    validateComputedOutbox(command, read, facts, computed);
}

function expectedMutationMemberPrincipalIds(
    command: GroupMutationCommand,
    read: GroupMutationRead,
): readonly string[] {
    switch (command.operation) {
        case 'createGroup':
            return [command.input.createdByPrincipalId];
        case 'joinGroup':
        case 'acceptGroupInvite':
        case 'createGroupInvite':
        case 'revokeGroupInvite':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'setGroupMemberRole':
        case 'upsertMember':
            return [command.targetPrincipalId];
        case 'transferGroupOwnership': {
            const currentOwner = read.group?.value.ownerPrincipalId;
            return currentOwner === undefined
                ? [command.targetPrincipalId]
                : [currentOwner, command.targetPrincipalId].toSorted();
        }
        case 'updateGroup':
        case 'appointDirector':
        case 'rotateGroupJoinCode':
        case 'connectPresence':
        case 'heartbeatPresence':
        case 'disconnectPresence':
            return [];
    }
}

function validateComputedOutbox(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): void {
    const outbox = computed.outbox as unknown as Record<string, unknown>;
    assertExactKeys(outbox, [
        'kind', 'aggregateRef', 'commandId', 'commandHash', 'createdAtEpochMs',
        'acceptedCausalRevision', 'effects', 'event',
    ], 'Group mutation computed outbox');
    assertRequiredKeys(outbox, [
        'kind', 'aggregateRef', 'commandId', 'commandHash', 'createdAtEpochMs',
        'acceptedCausalRevision', 'effects', 'event',
    ], 'Group mutation computed outbox');
    if (computed.outbox.kind !== 'group') {
        throw new TypeError('Group mutation computed outbox kind is invalid');
    }
    validateGroupRef(computed.outbox.aggregateRef);
    if (!jsonEquals(computed.outbox.aggregateRef, command.aggregateRef)) {
        throw new TypeError('Group mutation computed outbox scope differs from command');
    }
    if (computed.outbox.commandId !== command.commandId ||
        computed.outbox.commandHash !== facts.commandHash ||
        computed.outbox.createdAtEpochMs !== facts.nowEpochMs) {
        throw new TypeError('Group mutation computed outbox identity differs from command');
    }
    if (!jsonEquals(computed.outbox.effects,
        ['group-state-sync', 'group-presence-summary'])) {
        throw new TypeError('Group mutation computed outbox effects are invalid');
    }
    const revision = requireRecord(
        computed.outbox.acceptedCausalRevision,
        'Group mutation computed outbox causal revision',
    );
    assertExactKeys(revision, [
        'kind', 'stateRevision', 'causalRevision', 'snapshotVersion', 'metadataVersion',
        'rosterVersion', 'presenceVersion',
    ], 'Group mutation computed outbox causal revision');
    assertRequiredKeys(revision, [
        'kind', 'stateRevision', 'causalRevision', 'snapshotVersion', 'metadataVersion',
        'rosterVersion', 'presenceVersion',
    ], 'Group mutation computed outbox causal revision');
    if (revision.kind !== 'group') {
        throw new TypeError('Group mutation computed outbox revision kind is invalid');
    }
    for (const key of [
        'stateRevision', 'snapshotVersion', 'metadataVersion', 'rosterVersion',
        'presenceVersion',
    ]) {
        requireNonNegativeSafeInteger(revision[key],
            `Group mutation computed outbox ${key}`);
    }
    const causalRevision = requireRecord(
        revision.causalRevision,
        'Group mutation computed outbox causal tuple',
    );
    assertExactKeys(causalRevision, [
        'groupRevision',
        'presenceRevision',
    ], 'Group mutation computed outbox causal tuple');
    for (const key of ['groupRevision', 'presenceRevision']) {
        requireNonNegativeSafeInteger(
            causalRevision[key],
            `Group mutation computed outbox causal ${key}`,
        );
    }
    const group = computed.guard.kind === 'group'
        ? computed.guard.value
        : requireGroup(read, command.aggregateRef).value;
    if (revision.stateRevision !== computed.receipt.stateRevision ||
        !jsonEquals(causalRevision, computed.receipt.causalRevision) ||
        revision.snapshotVersion !== group.snapshotVersion ||
        revision.presenceVersion !== computed.receipt.causalRevision.presenceRevision) {
        throw new TypeError('Group mutation computed outbox revision differs from receipt');
    }
    if (revision.metadataVersion !== group.metadataVersion ||
        revision.rosterVersion !== group.rosterVersion) {
        throw new TypeError('Group mutation computed outbox versions differ from group');
    }
    const event = requireRecord(computed.outbox.event,
        'Group mutation computed outbox event');
    assertExactKeys(event, ['kind', 'event'], 'Group mutation computed outbox event');
    assertRequiredKeys(event, ['kind', 'event'], 'Group mutation computed outbox event');
    if (event.kind !== 'group' || !jsonEquals(event.event, computed.event)) {
        throw new TypeError('Group mutation computed outbox event differs from event');
    }
}

function validateComputedRosterFacts(
    read: GroupMutationRead,
    computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): void {
    if (computed.guard.kind !== 'group') return;
    const candidate = computed.guard.value;
    if (!Number.isSafeInteger(candidate.activeMemberCount) ||
        candidate.activeMemberCount < 1) {
        throw new TypeError('Group activeMemberCount must be a positive safe integer');
    }
    requireNonEmptyString(candidate.ownerPrincipalId, 'Group ownerPrincipalId');
    if (computed.guard.operation === 'insert') {
        const active = computed.members.filter((member) => member.status === 'active');
        const owners = active.filter((member) => member.role === 'owner');
        if (
            candidate.activeMemberCount !== active.length ||
            owners.length !== 1 ||
            owners[0]?.principalId !== candidate.ownerPrincipalId
        ) {
            throw new TypeError('Inserted group roster facts differ from member candidates');
        }
        return;
    }
    const current = requireGroup(read, candidate);
    let expectedCount = current.value.activeMemberCount;
    for (const member of computed.members) {
        const previous = findKnownMember(read, member.principalId);
        if ((previous?.status === 'active') !== (member.status === 'active')) {
            expectedCount += member.status === 'active' ? 1 : -1;
        }
    }
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 ||
        candidate.activeMemberCount !== expectedCount) {
        throw new TypeError('Updated group activeMemberCount has an invalid predecessor delta');
    }
    const promoted = computed.members.filter((member) =>
        member.status === 'active' && member.role === 'owner' &&
        member.principalId !== current.value.ownerPrincipalId
    );
    const currentOwnerCandidate = computed.members.find((member) =>
        member.principalId === current.value.ownerPrincipalId
    );
    const expectedOwner = promoted.length === 1 && currentOwnerCandidate &&
            (currentOwnerCandidate.status !== 'active' || currentOwnerCandidate.role !== 'owner')
        ? promoted[0]!.principalId
        : current.value.ownerPrincipalId;
    if (promoted.length > 1 || candidate.ownerPrincipalId !== expectedOwner) {
        throw new TypeError('Updated group ownerPrincipalId has an invalid predecessor delta');
    }
}

export function computeGroupPresenceSummary(input: Readonly<{
    ref: GroupRef;
    read: GroupPresenceSummaryRead;
    nowEpochMs: number;
}>): GroupPresenceSummaryComputed {
    const { ref, read, nowEpochMs } = input;
    const content = deriveGroupPresenceSummaryContent(ref, read, nowEpochMs);
    const groupRevision = read.group.entry.revision + 1;
    const current = read.current?.value;
    if (current &&
        current.causalRevision.groupRevision === groupRevision &&
        jsonEquals(summaryContent(current), content)) {
        return { outcome: 'no-op', summary: current };
    }
    const summary: GroupPresenceSummary = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
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
    requireJsonSafe(read, 'Group presence summary read');
    requireJsonSafe(computed, 'Group presence summary computed result');
    assertExactKeys(read as unknown as Record<string, unknown>, [
        'group', 'members', 'admissions', 'presenceSessions', 'current',
    ], 'Group presence summary read');
    assertRequiredKeys(read as unknown as Record<string, unknown>, [
        'group', 'members', 'admissions', 'presenceSessions', 'current',
    ], 'Group presence summary read');
    validateRuntimeEntryValue(
        read.group,
        'Stored summary group',
        groupStateGroupStorageKey(ref),
    );
    validateStoredGroup(read.group.value, ref);
    validateGroupPresenceSummaryReadCollections(ref, read);
    if (read.current) {
        validateRuntimeEntryValue(
            read.current,
            'Stored current presence summary',
            groupStatePresenceSummaryStorageKey(ref),
        );
        validatePresenceSummaryValue(read.current.value, ref);
    }

    const summary = computed.summary;
    validatePresenceSummaryValue(summary, ref);
    const expectedContent = deriveGroupPresenceSummaryContent(
        ref,
        read,
        summary.computedAtEpochMs,
    );
    const groupRevision = read.group.entry.revision + 1;
    const current = read.current?.value;
    const expectedNoOp = current !== undefined &&
        current.causalRevision.groupRevision === groupRevision &&
        jsonEquals(summaryContent(current), expectedContent);
    const shape = computed as unknown as Record<string, unknown>;
    if (computed.outcome === 'no-op') {
        assertExactKeys(shape, ['outcome', 'summary'],
            'Group presence summary computed result');
        if (!expectedNoOp || !current || !jsonEquals(summary, current)) {
            throw new TypeError(
                'Group presence summary no-op differs from current canonical candidate',
            );
        }
    } else {
        assertExactKeys(shape, ['outcome', 'operation', 'expectedRevision', 'summary'],
            'Group presence summary computed result');
        const expectedSummary: GroupPresenceSummary = {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId,
            causalRevision: {
                groupRevision,
                presenceRevision:
                    (current?.causalRevision.presenceRevision ?? 0) + 1,
            },
            ...expectedContent,
            computedAtEpochMs: summary.computedAtEpochMs,
        };
        if (expectedNoOp ||
            computed.operation !== (read.current ? 'update' : 'insert') ||
            computed.expectedRevision !== (read.current?.entry.revision ?? null) ||
            !jsonEquals(summary, expectedSummary)) {
            throw new TypeError(
                'Group presence summary write differs from canonical predecessor projection',
            );
        }
    }
    if (read.current) {
        const comparison = compareGroupCausalRevision(
            summary.causalRevision,
            read.current.value.causalRevision,
        );
        if (computed.outcome === 'write' && comparison !== 'dominates') {
            throw new TypeError('Group presence summary write must advance its causal tuple');
        }
        if (
            comparison === 'equal' &&
            !jsonEquals(summaryContent(summary), summaryContent(read.current.value))
        ) {
            throw new TypeError('Equal group presence summary tuple has different content');
        }
    }
}

function deriveGroupPresenceSummaryContent(
    ref: GroupRef,
    read: GroupPresenceSummaryRead,
    nowEpochMs: number,
): ReturnType<typeof summaryContent> {
    const groupActive = read.group.value.status === 'active' &&
        (read.group.value.expiresAtEpochMs === null ||
            read.group.value.expiresAtEpochMs > nowEpochMs);
    const activeMemberIds = new Set(read.members
        .map((stored) => stored.value)
        .filter((member) => member.status === 'active')
        .map((member) => member.principalId));
    const admitted = new Set(read.admissions.flatMap(({ value: admission }) =>
        admission.admittedSessions.map((session) =>
            admissionIdentity(admission.principalId, session)
        )
    ));
    const activeSessions = (groupActive
        ? read.presenceSessions.map(({ value }) => value).filter((session) =>
            activeMemberIds.has(session.principalId) &&
            admitted.has(admissionIdentity(session.principalId, session)) &&
            session.disconnectedAtEpochMs === null &&
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
    return {
        activePrincipalIds,
        activeSessionIds: activeSessions.map((session) => session.sessionId),
        activeSessions,
        activePrincipalCount: activePrincipalIds.length,
        activeSessionCount: activeSessions.length,
    };
}

function validateGroupPresenceSummaryReadCollections(
    ref: GroupRef,
    read: GroupPresenceSummaryRead,
): void {
    for (const [label, values] of [
        ['members', read.members],
        ['admissions', read.admissions],
        ['presence sessions', read.presenceSessions],
    ] as const) {
        if (!Array.isArray(values)) {
            throw new TypeError(`Group presence summary ${label} must be an array`);
        }
    }
    const memberIds = new Set<string>();
    for (const stored of read.members) {
        validateRuntimeEntryValue(
            stored,
            'Stored summary member',
            groupStateMemberStorageKey({
                ...ref,
                principalId: stored.value.principalId,
            }),
        );
        validateStoredMember(stored.value, ref, 'Stored summary member');
        if (memberIds.has(stored.value.principalId)) {
            throw new TypeError('Group presence summary member principal is duplicated');
        }
        memberIds.add(stored.value.principalId);
    }
    const activeMembers = read.members.map(({ value }) => value)
        .filter((member) => member.status === 'active');
    const activeOwners = activeMembers.filter((member) => member.role === 'owner');
    if (read.group.value.activeMemberCount !== activeMembers.length ||
        activeOwners.length !== 1 ||
        activeOwners[0]?.principalId !== read.group.value.ownerPrincipalId) {
        throw new TypeError('Group presence summary roster facts are inconsistent');
    }

    const admissionPrincipals = new Set<string>();
    const admittedSessionOwners = new Map<string, string>();
    for (const stored of read.admissions) {
        validateRuntimeEntryValue(
            stored,
            'Stored summary admission',
            groupStatePresenceAdmissionStorageKey({
                ...ref,
                principalId: stored.value.principalId,
            }),
        );
        validatePresenceAdmission(stored.value, ref);
        if (admissionPrincipals.has(stored.value.principalId)) {
            throw new TypeError('Group presence summary admission principal is duplicated');
        }
        admissionPrincipals.add(stored.value.principalId);
        for (const session of stored.value.admittedSessions) {
            const existing = admittedSessionOwners.get(session.sessionId);
            if (existing !== undefined && existing !== stored.value.principalId) {
                throw new TypeError('Group presence summary session has multiple principals');
            }
            admittedSessionOwners.set(session.sessionId, stored.value.principalId);
        }
    }

    const sessionsById = new Map<string, GroupPresenceSession>();
    for (const stored of read.presenceSessions) {
        validateRuntimeEntryValue(
            stored,
            'Stored summary presence session',
            groupStatePresenceSessionStorageKey({
                ...ref,
                sessionId: stored.value.sessionId,
            }),
        );
        validatePresenceSession(stored.value, ref, 'Stored summary presence session');
        if (sessionsById.has(stored.value.sessionId)) {
            throw new TypeError('Group presence summary sessionId is duplicated');
        }
        sessionsById.set(stored.value.sessionId, stored.value);
    }
    for (const stored of read.admissions) {
        for (const admitted of stored.value.admittedSessions) {
            const session = sessionsById.get(admitted.sessionId);
            if (!session) continue;
            if (session.principalId !== stored.value.principalId ||
                session.generationId !== admitted.generationId ||
                session.generationVersion !== admitted.generationVersion ||
                session.connectedAtEpochMs !== admitted.connectedAtEpochMs) {
                throw new TypeError(
                    'Group presence summary admission differs from stored generation',
                );
            }
        }
    }
}

function computeCreate(
    command: Extract<GroupMutationCommand, { operation: 'createGroup' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    if (command.input.actorPrincipalId !== command.input.createdByPrincipalId) {
        return rejected(command, read, facts, 'Creator authority does not match createdByPrincipalId');
    }
    if (read.group) {
        return rejected(command, read, facts, `Group already exists: ${command.aggregateRef.groupId}`);
    }
    const audit = auditStamp(command, facts, command.input.createdByPrincipalId);
    const group: Group = {
        ...command.aggregateRef,
        slug: command.input.slug,
        displayName: command.input.displayName,
        description: command.input.description,
        kind: command.input.kind,
        status: 'active',
        joinMode: command.input.joinMode,
        maxMembers: command.input.maxMembers,
        maxSessionsPerMember: command.input.maxSessionsPerMember,
        metadata: cloneRecord(command.input.metadata),
        activeMemberCount: 1,
        ownerPrincipalId: command.input.createdByPrincipalId,
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: audit,
        updated: audit,
        archived: null,
        deleted: null,
        expiresAtEpochMs: command.input.expiresAtEpochMs,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: command.input.purgeAfterEpochMs,
    };
    const owner: GroupMember = {
        ...command.aggregateRef,
        principalId: command.input.createdByPrincipalId,
        role: 'owner',
        status: 'active',
        joined: audit,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
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
        presenceAdmission: null,
        eventType: 'group-created',
    });
}

function computeUpdate(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertUpdateAuthority(command, read);
    const allowsArchivedDeletion = stored.value.status === 'archived' &&
        command.input.status === 'deleted';
    if (!allowsArchivedDeletion) {
        assertActive(stored.value, facts.nowEpochMs);
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const current = stored.value;
    const status = command.input.status ?? current.status;
    const next = transitionGroupLifecycle({
        ...current,
        slug: command.input.slug ?? current.slug,
        displayName: command.input.displayName ?? current.displayName,
        description: command.input.description ?? current.description,
        kind: command.input.kind ?? current.kind,
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
        expiresAtEpochMs: command.input.expiresAtEpochMs ?? current.expiresAtEpochMs,
        emptySinceEpochMs: command.input.emptySinceEpochMs ?? current.emptySinceEpochMs,
        purgeAfterEpochMs: command.input.purgeAfterEpochMs ?? current.purgeAfterEpochMs,
    }, status, audit);
    if (next.maxMembers !== null && next.maxMembers < next.activeMemberCount) {
        throw new GroupMutationRejectedError(
            'Group maxMembers cannot be lower than activeMemberCount.',
        );
    }
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
    assertPrincipalAuthority(command, command.targetPrincipalId);
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
    const existing = read.targetMember ?? undefined;
    if (existing?.status === 'active') return noOp(command, read, facts);
    const audit = auditStamp(command, facts, command.targetPrincipalId);
    const member: GroupMember = {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: existing?.role ?? 'member',
        status: 'active',
        joined: existing?.joined ?? audit,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: existing?.invitedByPrincipalId ?? null,
        invitationExpiresAtEpochMs:
            existing?.invitationExpiresAtEpochMs ?? null,
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
    const existing = findTargetMember(read);
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
        joined: null,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: command.input.actorPrincipalId,
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
    const existing = findTargetMember(read);
    if (existing?.status !== 'invited') return noOp(command, read, facts);
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    return memberWrite(command, read, facts, [transitionMemberLifecycle({
        ...existing,
        updated: audit,
    }, 'left', audit)], 'member-left');
}

function computeRotateJoinCode(
    command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertGovernance(command, read, facts, 'invite');
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
            rotatedAtEpochMs: facts.nowEpochMs,
        }),
        snapshotVersion: stored.value.snapshotVersion + 1,
        metadataVersion: stored.value.metadataVersion + 1,
        updated: audit,
    };
    return groupWrite(command, read, facts, next, 'group-updated');
}

function materializedRotateJoinCode(
    command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
    facts: GroupMutationFacts,
): Readonly<{ joinCode: string; expiresAtEpochMs: number }> {
    const joinCode = command.input.joinCode ?? facts.resolvedJoinCode;
    const expiresAtEpochMs = command.input.expiresAtEpochMs ??
        facts.nowEpochMs + DEFAULT_GROUP_JOIN_CODE_TTL_MS;
    if (!joinCode || !Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs <= 0) {
        throw new GroupMutationRejectedError(
            'Join code defaults could not be materialized safely',
        );
    }
    return { joinCode, expiresAtEpochMs };
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
    const existing = findTargetMember(read);
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
        joined: null,
        updated: audit,
        left: audit,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
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
    if (command.operation === 'setGroupMemberRole' && role === 'owner') {
        throw new GroupMutationRejectedError(
            'Ownership can only change through transferGroupOwnership.',
        );
    }
    if (
        command.operation === 'setGroupMemberRole' && role === 'admin' &&
        read.actorMember?.role === 'admin' && base.role !== 'admin'
    ) {
        throw new GroupMutationRejectedError('Group admins cannot grant the admin role.');
    }
    if (base.status === status && base.role === role) return noOp(command, read, facts);
    assertNotLastOwner(requireGroup(read, command.aggregateRef).value, base, status, role);
    const member = transitionMemberLifecycle({
        ...base,
        role,
        updated: audit,
    }, status, audit);
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
    const actor = read.actorMember ?? undefined;
    const target = findTargetMember(read);
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
    const isSelf = command.input.actorPrincipalId === command.targetPrincipalId;
    if (!isSelf) {
        assertGovernance(command, read, facts,
            command.input.status === 'banned' ? 'ban' : 'promote');
    } else {
        assertPrincipalAuthority(command, command.targetPrincipalId);
        if (command.input.status !== 'active' && command.input.status !== 'left') {
            throw new GroupMutationRejectedError(
                'Self upsert may only join or leave the group.',
            );
        }
        if (command.input.role !== null &&
            command.input.role !== (read.targetMember?.role ?? 'member')) {
            throw new GroupMutationRejectedError('Self upsert cannot change role.');
        }
    }
    if (command.input.role === 'owner') {
        throw new GroupMutationRejectedError(
            'Ownership can only change through transferGroupOwnership.',
        );
    }
    if (
        !isSelf && command.input.role === 'admin' &&
        read.actorMember?.role === 'admin' && read.targetMember?.role !== 'admin'
    ) {
        throw new GroupMutationRejectedError('Group admins cannot grant the admin role.');
    }
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
    const existing = findTargetMember(read);
    const audit = auditStamp(command, facts,
        command.input.actorPrincipalId ?? command.targetPrincipalId);
    const member = transitionMemberLifecycle({
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: command.input.role ?? existing?.role ?? 'member',
        joined: existing?.joined ?? audit,
        updated: audit,
        left: existing?.left ?? null,
        removed: existing?.removed ?? null,
        banned: existing?.banned ?? null,
        invitedByPrincipalId:
            command.input.invitedByPrincipalId ?? existing?.invitedByPrincipalId ?? null,
        invitationExpiresAtEpochMs:
            command.input.invitationExpiresAtEpochMs ??
            existing?.invitationExpiresAtEpochMs ?? null,
    }, command.input.status, audit);
    if (existing && jsonEquals(existing, member)) return noOp(command, read, facts);
    assertNotLastOwner(requireGroup(read, command.aggregateRef).value,
        existing, member.status, member.role);
    return memberWrite(command, read, facts, [member], memberEventType(member.status));
}

function computeConnectPresence(
    command: Extract<GroupMutationCommand, { operation: 'connectPresence' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertPrincipalAuthority(command, command.input.principalId);
    const member = read.targetMember ?? undefined;
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
    const connectedAt = existing?.value.generationId === command.input.generationId &&
            command.input.connectedAtEpochMs === null
        ? existing.value.connectedAtEpochMs
        : command.input.connectedAtEpochMs ?? facts.nowEpochMs;
    requirePositiveSafeInteger(connectedAt, 'Group presence connectedAtEpochMs');
    // connectedAt is the durable generation version. The generation id only
    // breaks equal-timestamp ties, so every writer derives the same total order.
    const incomingOrder = [connectedAt, command.input.generationId] as const;
    if (existing) {
        validateStoredGeneration(existing.value);
        if (existing.value.principalId !== command.input.principalId) {
            throw new GroupMutationRejectedError(
                'A presence session cannot be reassigned to another principal.',
            );
        }
        const currentOrder = [
            existing.value.generationVersion,
            existing.value.generationId,
        ] as const;
        const order = compareGenerationOrder(incomingOrder, currentOrder);
        if (order < 0) return noOp(command, read, facts);
        if (order === 0 && existing.value.disconnectedAtEpochMs !== null) {
            return noOp(command, read, facts);
        }
        if (
            existing.value.generationId === command.input.generationId &&
            command.input.connectedAtEpochMs !== null &&
            connectedAt !== existing.value.connectedAtEpochMs
        ) {
            throw new GroupMutationRejectedError(
                'A generationId cannot be reused with a different connectedAtEpochMs.',
            );
        }
    }
    const sameGeneration = existing !== null &&
        existing.value.generationId === command.input.generationId &&
        existing.value.generationVersion === connectedAt;
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    const expiresAt = command.input.expiresAtEpochMs ??
        facts.nowEpochMs + DEFAULT_GROUP_SESSION_TTL_MS;
    if (heartbeatAt < connectedAt || expiresAt < heartbeatAt) {
        throw new GroupMutationRejectedError(
            'Presence connection timestamps are causally inconsistent.',
        );
    }
    const session: GroupPresenceSession = {
        ...command.aggregateRef,
        sessionId: command.sessionId,
        principalId: command.input.principalId,
        generationId: command.input.generationId,
        generationVersion: connectedAt,
        connectedAtEpochMs: sameGeneration
            ? existing.value.connectedAtEpochMs
            : connectedAt,
        lastHeartbeatAtEpochMs: sameGeneration
            ? Math.max(existing.value.lastHeartbeatAtEpochMs, heartbeatAt)
            : heartbeatAt,
        expiresAtEpochMs: sameGeneration
            ? Math.max(existing.value.expiresAtEpochMs, expiresAt)
            : expiresAt,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    };
    if (existing && jsonEquals(existing.value, session)) return noOp(command, read, facts);
    const admission = admissionForConnect(command, read, session, facts);
    return presenceWrite(command, read, facts, session,
        existing ? 'update' : 'insert', 'session-connected', admission);
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
    assertPresenceAuthority(command, existing.value.principalId, facts);
    if (
        existing.value.generationId !== command.input.generationId ||
        existing.value.disconnectedAtEpochMs !== null
    ) return noOp(command, read, facts);
    if (!isExactlyAdmitted(read.targetAdmission?.value, existing.value)) {
        return noOp(command, read, facts);
    }
    const member = read.targetMember ?? undefined;
    if (!member || member.status !== 'active') return noOp(command, read, facts);
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (heartbeatAt < existing.value.lastHeartbeatAtEpochMs) return noOp(command, read, facts);
    const expiresAt = Math.max(
        existing.value.expiresAtEpochMs,
        command.input.expiresAtEpochMs ?? existing.value.expiresAtEpochMs,
    );
    if (expiresAt < heartbeatAt) {
        throw new GroupMutationRejectedError(
            'Presence heartbeat expiry must not predate the heartbeat.',
        );
    }
    const session: GroupPresenceSession = {
        ...existing.value,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: expiresAt,
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
    if (!existing) {
        if (facts.internalAuthority === 'expiry') return noOp(command, read, facts);
        throw new GroupMutationRejectedError(
            `Group presence session not found: ${command.sessionId}`,
        );
    }
    assertPresenceAuthority(command, existing.value.principalId, facts);
    if (
        existing.value.generationId !== command.input.generationId ||
        (command.input.generationVersion !== null &&
            existing.value.generationVersion !== command.input.generationVersion) ||
        (command.input.observedExpiresAtEpochMs !== null &&
            existing.value.expiresAtEpochMs !== command.input.observedExpiresAtEpochMs) ||
        existing.value.disconnectedAtEpochMs !== null
    ) return noOp(command, read, facts);
    const disconnectedAt = command.input.disconnectedAtEpochMs ?? facts.nowEpochMs;
    if (disconnectedAt < existing.value.lastHeartbeatAtEpochMs) {
        return noOp(command, read, facts);
    }
    if (facts.internalAuthority === 'expiry') {
        return presenceWrite(
            command,
            read,
            facts,
            existing.value,
            'delete',
            'session-disconnected',
            admissionForDisconnect(read, existing.value, facts),
        );
    }
    const session: GroupPresenceSession = {
        ...existing.value,
        status: 'disconnected',
        disconnectedAtEpochMs: disconnectedAt,
        disconnectReason: command.input.reason ?? 'closed',
    };
    return presenceWrite(command, read, facts, session, 'update',
        'session-disconnected', admissionForDisconnect(read, existing.value, facts));
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
    let activeMemberCount = stored.value.activeMemberCount;
    for (const member of members) {
        const previous = findKnownMember(read, member.principalId);
        const previousActive = previous?.status === 'active';
        const nextActive = member.status === 'active';
        if (previousActive !== nextActive) {
            activeMemberCount += nextActive ? 1 : -1;
        }
    }
    if (!Number.isSafeInteger(activeMemberCount) || activeMemberCount < 0) {
        throw new TypeError('Group activeMemberCount delta is invalid');
    }
    const promotedOwner = members.find((member) =>
        member.status === 'active' && member.role === 'owner'
    );
    const ownerPrincipalId = eventType === 'ownership-transferred'
        ? promotedOwner?.principalId
        : stored.value.ownerPrincipalId;
    if (!ownerPrincipalId) {
        throw new TypeError('Group owner transition has no active owner');
    }
    for (const member of members) {
        if (member.principalId === ownerPrincipalId &&
            (member.status !== 'active' || member.role !== 'owner')) {
            throw new GroupMutationRejectedError(
                'Cannot remove or demote the active group owner.',
            );
        }
        if (member.status === 'active' && member.role === 'owner' &&
            member.principalId !== ownerPrincipalId) {
            throw new GroupMutationRejectedError(
                'Ownership can only change through a single guarded transfer.',
            );
        }
    }
    const group: Group = {
        ...stored.value,
        activeMemberCount,
        ownerPrincipalId,
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
        presenceAdmission: admissionForMemberWrite(read, members, facts),
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
    operation: 'insert' | 'update' | 'delete',
    eventType: GroupEventType,
    presenceAdmission: PresenceAdmissionCandidate | null = null,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const guard = operation === 'insert'
        ? { kind: 'presence', operation: 'insert', value: session } as const
        : operation === 'update'
        ? {
            kind: 'presence',
            operation: 'update',
            value: session,
            expectedRevision: read.targetPresence!.entry.revision,
        } as const
        : {
            kind: 'presence',
            operation: 'delete',
            value: session,
            expectedRevision: read.targetPresence!.entry.revision,
        } as const;
    return writeResult(command, read, facts, {
        guard,
        members: [],
        initialPresenceSummary: null,
        eventType,
        eventGroup: stored.value,
        presenceAdmission,
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
        presenceAdmission?: PresenceAdmissionCandidate | null;
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
    const event = newGroupEvent(
        input.eventType,
        group,
        causalRevision,
        command,
        facts,
    );
    const outbox: GroupMutationOutboxCandidate = {
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
            causalRevision,
            snapshotVersion: group.snapshotVersion,
            metadataVersion: group.metadataVersion,
            rosterVersion: group.rosterVersion,
            presenceVersion: causalRevision.presenceRevision,
        },
        effects: ['group-state-sync', 'group-presence-summary'],
        event: { kind: 'group', event },
    };
    const receipt = receiptFor(command, facts, {
        outcome: 'applied',
        causalRevision,
        snapshotVersion: group.snapshotVersion,
        acceptedStorageRevision: input.guard.operation === 'insert'
            ? 0
            : input.guard.expectedRevision + 1,
        eventId: event.eventId,
        outboxIds: [toStateMutationOutboxId(outbox)],
        rejection: null,
    });
    const idempotency = command.requestId === null ? null : {
        aggregateRef: command.aggregateRef,
        requestId: command.requestId,
        commandHash: facts.commandHash,
        receipt,
    };
    return {
        outcome: 'write',
        guard: input.guard,
        members: input.members,
        initialPresenceSummary: input.initialPresenceSummary,
        presenceAdmission: input.presenceAdmission ?? null,
        event,
        receipt,
        idempotency,
        outbox,
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
            acceptedStorageRevision: stored.entry.revision,
            eventId: null,
            outboxIds: [],
            rejection: null,
        }),
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
            acceptedStorageRevision: read.group?.entry.revision ?? null,
            eventId: null,
            outboxIds: [],
            rejection: message,
        }),
    };
}

function receiptFor(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    input: Readonly<{
        outcome: GroupMutationReceipt['outcome'];
        causalRevision: GroupStateCausalRevision;
        snapshotVersion: number;
        acceptedStorageRevision: number | null;
        eventId: string | null;
        outboxIds: readonly string[];
        rejection: string | null;
    }>,
): GroupMutationReceipt {
    const joinCode = command.operation === 'rotateGroupJoinCode'
        ? materializedRotateJoinCode(command, facts)
        : null;
    return {
        commandId: command.commandId,
        requestId: command.requestId,
        commandHash: facts.commandHash,
        aggregateRef: command.aggregateRef,
        outcome: input.outcome,
        attemptCount: facts.attemptCount,
        acceptedStorageRevision: input.acceptedStorageRevision,
        stateRevision: toGroupSnapshotStateRevision(
            input.causalRevision.groupRevision,
            input.causalRevision.presenceRevision,
        ),
        snapshotVersion: input.snapshotVersion,
        causalRevision: input.causalRevision,
        eventId: input.eventId,
        outboxIds: input.outboxIds,
        joinCode: joinCode?.joinCode ?? null,
        joinCodeExpiresAtEpochMs: joinCode?.expiresAtEpochMs ?? null,
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
    const stored = requireGroup(read, {
        applicationId: '',
        workspaceId: '',
        groupId: '',
    });
    const members = [
        read.actorMember,
        read.targetMember,
        read.authorityMember,
        read.directorMember,
    ]
        .filter((member): member is GroupMember => member !== null)
        .filter((member, index, values) =>
            values.findIndex((candidate) =>
                candidate.principalId === member.principalId
            ) === index
        );
    const targetSessions = read.targetPresence &&
        read.targetPresence.value.disconnectedAtEpochMs === null &&
        read.targetPresence.value.expiresAtEpochMs > nowEpochMs &&
        isExactlyAdmitted(read.targetAdmission?.value, read.targetPresence.value)
        ? [read.targetPresence.value]
        : [];
    const authoritySessions = read.authorityPresenceSessions.filter((session) =>
        session.disconnectedAtEpochMs === null &&
        session.expiresAtEpochMs > nowEpochMs &&
        (
            isExactlyAdmitted(read.authorityAdmission?.value, session) ||
            isExactlyAdmitted(read.directorAdmission?.value, session)
        )
    );
    const activeSessions = [...targetSessions, ...authoritySessions]
        .filter((session, index, sessions) =>
            sessions.findIndex((candidate) =>
                candidate.sessionId === session.sessionId &&
                candidate.generationId === session.generationId &&
                candidate.generationVersion === session.generationVersion
            ) === index
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
        members,
        activeSessions,
        memberCount: stored.value.activeMemberCount,
        onlineMemberCount: members.filter((member) =>
            member.status === 'active' && activePrincipals.has(member.principalId)
        ).length,
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

function assertUpdateAuthority(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup' }>,
    read: GroupMutationRead,
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
            message: 'Only active group owners/admins can update groups.',
        });
    }
}

function assertPrincipalAuthority(
    command: GroupMutationCommand,
    principalId: string,
): void {
    if (command.input.actorPrincipalId !== principalId) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'member-not-active',
            message: 'Mutation actor must match the authoritative principal.',
        });
    }
}

function assertPresenceAuthority(
    command: GroupMutationCommand,
    principalId: string,
    facts: GroupMutationFacts,
): void {
    if (facts.internalAuthority !== 'none') return;
    assertPrincipalAuthority(command, principalId);
}

function findKnownMember(
    read: GroupMutationRead,
    principalId: string,
): GroupMember | undefined {
    if (read.actorMember?.principalId === principalId) return read.actorMember;
    if (read.targetMember?.principalId === principalId) return read.targetMember;
    return undefined;
}

function admissionForConnect(
    command: Extract<GroupMutationCommand, { operation: 'connectPresence' }>,
    read: GroupMutationRead,
    session: GroupPresenceSession,
    facts: GroupMutationFacts,
): PresenceAdmissionCandidate {
    const current = read.targetAdmission;
    if (current) validatePresenceAdmission(current.value);
    const retained = (current?.value.admittedSessions ?? [])
        .filter((entry) => entry.sessionId !== session.sessionId);
    const admittedSessions = [...retained, {
        sessionId: session.sessionId,
        generationId: session.generationId,
        generationVersion: session.generationVersion,
        connectedAtEpochMs: session.connectedAtEpochMs,
    }].toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
    const cap = requireGroup(read, command.aggregateRef).value.maxSessionsPerMember;
    if (cap !== null && admittedSessions.length > cap) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'member-session-limit-reached',
            message: 'Group member session capacity has been reached.',
        });
    }
    const value: GroupPresenceAdmission = {
        ...command.aggregateRef,
        principalId: session.principalId,
        admittedSessions,
        updatedAtEpochMs: Math.max(
            current?.value.updatedAtEpochMs ?? 0,
            facts.nowEpochMs,
        ),
    };
    validatePresenceAdmission(value);
    return current
        ? { operation: 'update', value, expectedRevision: current.entry.revision }
        : { operation: 'insert', value };
}

function admissionForDisconnect(
    read: GroupMutationRead,
    session: GroupPresenceSession,
    facts: GroupMutationFacts,
): PresenceAdmissionCandidate | null {
    const current = read.targetAdmission;
    if (!current || !isExactlyAdmitted(current.value, session)) return null;
    const value: GroupPresenceAdmission = {
        ...current.value,
        admittedSessions: current.value.admittedSessions.filter((entry) =>
            entry.sessionId !== session.sessionId
        ),
        updatedAtEpochMs: Math.max(current.value.updatedAtEpochMs, facts.nowEpochMs),
    };
    validatePresenceAdmission(value);
    return {
        operation: 'update',
        value,
        expectedRevision: current.entry.revision,
    };
}

function admissionForMemberWrite(
    read: GroupMutationRead,
    members: readonly GroupMember[],
    facts: GroupMutationFacts,
): PresenceAdmissionCandidate | null {
    const current = read.targetAdmission;
    const target = members.find((member) => member.status !== 'active');
    if (!target) return null;
    if (current) {
        validatePresenceAdmission(current.value);
        if (current.value.principalId !== target.principalId) {
            throw new TypeError(
                'Presence admission predecessor differs from member authority target',
            );
        }
    }
    const previousUpdatedAt = current?.value.updatedAtEpochMs ?? 0;
    if (previousUpdatedAt >= Number.MAX_SAFE_INTEGER) {
        throw new TypeError('Presence admission fence timestamp cannot advance');
    }
    const value: GroupPresenceAdmission = {
        ...commandRefForAdmission(target),
        admittedSessions: [],
        updatedAtEpochMs: Math.max(previousUpdatedAt + 1, facts.nowEpochMs),
    };
    validatePresenceAdmission(value);
    return current
        ? {
            operation: 'update',
            value,
            expectedRevision: current.entry.revision,
        }
        : { operation: 'insert', value };
}

function commandRefForAdmission(
    member: GroupMember,
): GroupRef & Readonly<{ principalId: string }> {
    return {
        applicationId: member.applicationId,
        workspaceId: member.workspaceId,
        groupId: member.groupId,
        principalId: member.principalId,
    };
}

function isExactlyAdmitted(
    admission: GroupPresenceAdmission | undefined,
    session: GroupPresenceSession,
): boolean {
    return admission?.principalId === session.principalId &&
        admission.admittedSessions.some((entry) =>
            entry.sessionId === session.sessionId &&
            entry.generationId === session.generationId &&
            entry.generationVersion === session.generationVersion
        ) === true;
}

function validatePresenceAdmission(
    admission: unknown,
    ref?: GroupRef,
): asserts admission is GroupPresenceAdmission {
    const value = requireRecord(admission, 'Presence admission');
    assertExactKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'principalId',
        'admittedSessions', 'updatedAtEpochMs',
    ], 'Presence admission');
    assertRequiredKeys(value, [
        'applicationId', 'workspaceId', 'groupId', 'principalId', 'admittedSessions',
        'updatedAtEpochMs',
    ], 'Presence admission');
    if (ref) validateScopedRecord(value, ref, 'Presence admission');
    requireNonEmptyString(value.principalId, 'Presence admission principalId');
    requirePositiveSafeInteger(value.updatedAtEpochMs,
        'Presence admission updatedAtEpochMs');
    if (!Array.isArray(value.admittedSessions)) {
        throw new TypeError('Presence admission sessions must be an array');
    }
    const sessionIdentities: Array<Readonly<{
        sessionId: string;
        generationId: string;
        generationVersion: number;
        connectedAtEpochMs: number;
    }>> = [];
    const sessionIds = new Set<string>();
    for (const session of value.admittedSessions) {
        const sessionValue = requireRecord(session, 'Presence admission session');
        assertExactKeys(sessionValue, [
            'sessionId', 'generationId', 'generationVersion', 'connectedAtEpochMs',
        ], 'Presence admission session');
        assertRequiredKeys(sessionValue, [
            'sessionId', 'generationId', 'generationVersion', 'connectedAtEpochMs',
        ], 'Presence admission session');
        requireNonEmptyString(sessionValue.sessionId, 'Presence admission sessionId');
        requireNonEmptyString(sessionValue.generationId, 'Presence admission generationId');
        requirePositiveSafeInteger(sessionValue.generationVersion,
            'Presence admission generationVersion');
        requirePositiveSafeInteger(sessionValue.connectedAtEpochMs,
            'Presence admission connectedAtEpochMs');
        if (sessionValue.generationVersion !== sessionValue.connectedAtEpochMs) {
            throw new TypeError('Presence admission generation version is ambiguous');
        }
        if (sessionIds.has(sessionValue.sessionId)) {
            throw new TypeError('Presence admission sessionId must be unique');
        }
        sessionIds.add(sessionValue.sessionId);
        sessionIdentities.push({
            sessionId: sessionValue.sessionId,
            generationId: sessionValue.generationId,
            generationVersion: sessionValue.generationVersion,
            connectedAtEpochMs: sessionValue.connectedAtEpochMs,
        });
    }
    const canonical = sessionIdentities.toSorted((left, right) =>
        left.sessionId.localeCompare(right.sessionId)
    );
    if (!jsonEquals(canonical, sessionIdentities)) {
        throw new TypeError('Presence admission sessions must be canonically sorted');
    }
}

function admissionIdentity(
    principalId: string,
    session: Pick<GroupPresenceSession, 'sessionId' | 'generationId' | 'generationVersion'>,
): string {
    return JSON.stringify([
        principalId,
        session.sessionId,
        session.generationId,
        session.generationVersion,
    ]);
}

function validateStoredGeneration(session: GroupPresenceSession): void {
    validateStoredGenerationValues(
        session.connectedAtEpochMs,
        session.generationVersion,
    );
}

function validateStoredGenerationValues(
    connectedAtEpochMs: unknown,
    generationVersion: unknown,
): void {
    requirePositiveSafeInteger(connectedAtEpochMs,
        'Stored presence connectedAtEpochMs');
    requirePositiveSafeInteger(generationVersion,
        'Stored presence generationVersion');
    if (generationVersion !== connectedAtEpochMs) {
        throw new TypeError('Stored presence generation order is ambiguous');
    }
}

function compareGenerationOrder(
    left: readonly [number, string],
    right: readonly [number, string],
): number {
    return Math.sign(left[0] - right[0]) || left[1].localeCompare(right[1]);
}

function requirePositiveSafeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${label} must be a positive safe integer`);
    }
}

function findTargetMember(
    read: GroupMutationRead,
): GroupMember | undefined {
    return read.targetMember ?? undefined;
}

function assertNotLastOwner(
    group: Group,
    existing: GroupMember | undefined,
    nextStatus: GroupMemberStatus,
    nextRole: GroupRole,
): void {
    if (!existing || existing.role !== 'owner' || existing.status !== 'active') return;
    if (nextStatus === 'active' && nextRole === 'owner') return;
    if (group.ownerPrincipalId === existing.principalId) {
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
        actor: mutationActor(command, facts, fallbackPrincipalId),
        reason: command.input.reason,
        traceId: command.input.traceId,
        requestId: command.requestId,
    };
}

function mutationActor(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    fallbackPrincipalId?: string,
): MutationActor {
    const principalId = command.input.actorPrincipalId ?? fallbackPrincipalId;
    if (command.input.actorSessionId !== null) {
        if (!principalId) {
            throw new GroupMutationRejectedError(
                'A session actor requires a principal identity.',
            );
        }
        return {
            kind: 'session',
            sessionId: command.input.actorSessionId,
            principalId,
        };
    }
    if (principalId) return { kind: 'principal', principalId };
    return { kind: 'service', serviceId: facts.serviceId };
}

function actorPrincipalId(actor: MutationActor): string | null {
    return actor.kind === 'service' ? null : actor.principalId;
}

function actorSessionId(actor: MutationActor): string | null {
    return actor.kind === 'session' ? actor.sessionId : null;
}

function transitionGroupLifecycle(
    group: Group,
    status: GroupStatus,
    audit: AuditStamp,
): Group {
    if (status === 'active') {
        return { ...group, status, archived: null, deleted: null };
    }
    if (status === 'archived') {
        return {
            ...group,
            status,
            archived: group.archived ?? audit,
            deleted: null,
        };
    }
    return {
        ...group,
        status,
        archived: group.archived,
        deleted: group.deleted ?? audit,
    };
}

function transitionMemberLifecycle(
    member: Omit<GroupMember, 'status' | 'left' | 'removed' | 'banned'> &
        Readonly<{
            left: AuditStamp | null;
            removed: AuditStamp | null;
            banned: AuditStamp | null;
        }>,
    status: GroupMemberStatus,
    audit: AuditStamp,
): GroupMember {
    if (status === 'invited') {
        return {
            ...member,
            status,
            joined: null,
            left: null,
            removed: null,
            banned: null,
        };
    }
    if (status === 'active') {
        return {
            ...member,
            status,
            joined: member.joined ?? audit,
            left: null,
            removed: null,
            banned: null,
        };
    }
    if (status === 'left') {
        return { ...member, status, left: audit, removed: null, banned: null };
    }
    if (status === 'removed') {
        return { ...member, status, left: null, removed: audit, banned: null };
    }
    return { ...member, status, left: null, removed: null, banned: audit };
}

function newGroupEvent(
    eventType: GroupEventType,
    group: Group,
    causalRevision: GroupStateCausalRevision,
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
): GroupEvent {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        eventId: facts.eventId,
        eventType,
        snapshotVersion: group.snapshotVersion,
        causalRevision,
        occurredAtEpochMs: facts.nowEpochMs,
        actor: mutationActor(command, facts),
        reason: command.input.reason,
        traceId: command.input.traceId,
        requestId: command.requestId,
        payload: {},
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

function withoutUndefined<T extends Readonly<Record<string, unknown>>>(value: T): T {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as T;
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

export { compareGroupCausalRevision };

function validateFacts(facts: GroupMutationFacts): void {
    requireJsonSafe(facts, 'Group mutation facts');
    assertExactKeys(facts as unknown as Record<string, unknown>, [
        'nowEpochMs', 'serviceId', 'eventId', 'commandHash', 'resolvedJoinCode',
        'joinCodeVerifier', 'internalAuthority', 'authenticatedAuthority',
        'attemptCount',
    ], 'Group mutation facts');
    if (!Number.isSafeInteger(facts.nowEpochMs) || facts.nowEpochMs < 0) {
        throw new TypeError('Group mutation timestamp is invalid');
    }
    requirePositiveSafeInteger(facts.attemptCount, 'Group mutation attemptCount');
    requireNonEmptyString(facts.serviceId, 'Group mutation serviceId');
    requireNonEmptyString(facts.eventId, 'Group mutation eventId');
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new TypeError('Group mutation commandHash is invalid');
    }
    if (!['none', 'expiry', 'session-cleanup'].includes(facts.internalAuthority)) {
        throw new TypeError('Group mutation internal authority is invalid');
    }
    if (facts.authenticatedAuthority !== null) {
        const authority = requireRecord(
            facts.authenticatedAuthority,
            'Group mutation authenticated authority',
        );
        assertExactKeys(authority, ['principalId', 'sessionId'],
            'Group mutation authenticated authority');
        requireNonEmptyString(authority.principalId,
            'Group mutation authenticated authority principalId');
        requireNonEmptyString(authority.sessionId,
            'Group mutation authenticated authority sessionId');
    }
    if (facts.joinCodeVerifier !== null) {
        requireNonEmptyString(facts.joinCodeVerifier,
            'Group mutation joinCodeVerifier');
    }
    if (facts.resolvedJoinCode !== null) {
        requireNonEmptyString(facts.resolvedJoinCode,
            'Group mutation resolvedJoinCode');
    }
    if ((facts.resolvedJoinCode === null) !== (facts.joinCodeVerifier === null)) {
        throw new TypeError('Group mutation resolved join code and verifier differ');
    }
    if (facts.internalAuthority !== 'none' && facts.authenticatedAuthority !== null) {
        throw new TypeError('Internal group authority cannot also be authenticated authority');
    }
}

function validateTrustedAuthorityMode(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
): void {
    validateResolvedJoinCodeFacts(command, facts);
    const authority = facts.authenticatedAuthority;
    if (facts.internalAuthority === 'none' && authority === null) {
        throw new TypeError(
            'User group mutation requires authenticated authority facts',
        );
    }
    if (facts.internalAuthority !== 'none') {
        if (authority !== null) {
            throw new TypeError(
                'Internal group mutation cannot use authenticated authority facts',
            );
        }
        if (command.operation !== 'disconnectPresence') {
            throw new TypeError(
                'Internal group authority is limited to presence maintenance',
            );
        }
        if (command.input.actorPrincipalId !== null ||
            command.input.actorSessionId !== null) {
            throw new TypeError(
                'Internal group maintenance cannot claim semantic actor authority',
            );
        }
        if (facts.internalAuthority === 'expiry' && command.input.reason !== 'expired') {
            throw new TypeError('Group expiry authority requires an expiry command');
        }
        if (facts.internalAuthority === 'session-cleanup' &&
            command.input.reason !== null) {
            throw new TypeError('Group session cleanup authority has invalid command facts');
        }
        return;
    }
    if (!authority) {
        throw new TypeError('Authenticated group mutation authority is missing');
    }
    if (command.input.actorPrincipalId !== authority.principalId ||
        command.input.actorSessionId !== authority.sessionId) {
        throw new TypeError('Group mutation actor differs from authenticated authority');
    }
}

function validateResolvedJoinCodeFacts(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
): void {
    if (command.operation === 'rotateGroupJoinCode') {
        if (facts.resolvedJoinCode === null || facts.joinCodeVerifier === null) {
            throw new TypeError('Group rotate mutation is missing its generated join code facts');
        }
        if (command.input.joinCode !== null &&
            facts.resolvedJoinCode !== command.input.joinCode) {
            throw new TypeError(
                'Group rotate resolved join code differs from explicit command intent',
            );
        }
        return;
    }
    if (command.operation === 'joinGroup' || command.operation === 'acceptGroupInvite') {
        if (facts.resolvedJoinCode !== command.input.joinCode) {
            throw new TypeError('Group resolved join code differs from join command intent');
        }
        return;
    }
    if (facts.resolvedJoinCode !== null || facts.joinCodeVerifier !== null) {
        throw new TypeError('Unrelated group operation contains resolved join code facts');
    }
}

function validateScopedValue(
    value: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>,
    ref: GroupRef,
    label: string,
): void {
    requireNonEmptyString(value.applicationId, `${label} applicationId`);
    requireNonEmptyString(value.groupId, `${label} groupId`);
    if (value.workspaceId !== undefined) {
        requireNonEmptyString(value.workspaceId, `${label} workspaceId`);
    }
    if (value.applicationId !== ref.applicationId ||
        value.workspaceId !== ref.workspaceId || value.groupId !== ref.groupId) {
        throw new TypeError(`${label} scope differs from mutation group`);
    }
}

function validateScopedRecord(
    value: Readonly<Record<string, unknown>>,
    ref: GroupRef,
    label: string,
): void {
    requireNonEmptyString(value.applicationId, `${label} applicationId`);
    requireNonEmptyString(value.workspaceId, `${label} workspaceId`);
    requireNonEmptyString(value.groupId, `${label} groupId`);
    if (
        value.applicationId !== ref.applicationId ||
        value.workspaceId !== ref.workspaceId ||
        value.groupId !== ref.groupId
    ) {
        throw new TypeError(`${label} scope differs from mutation group`);
    }
}

function persistedOrDefault(
    value: Readonly<Record<string, unknown>>,
    key: string,
    fallback: unknown,
): unknown {
    return Object.hasOwn(value, key) ? value[key] : fallback;
}

function normalizeOptionalPersistedGroupAudit(
    value: Readonly<Record<string, unknown>>,
    key: string,
    label: string,
): AuditStamp | null {
    return Object.hasOwn(value, key)
        ? normalizeNullablePersistedGroupAudit(value[key], label)
        : null;
}

function normalizeNullablePersistedGroupAudit(
    value: unknown,
    label: string,
): AuditStamp | null {
    return value === null ? null : normalizePersistedGroupAudit(value, label);
}

function normalizePersistedGroupAudit(value: unknown, label: string): AuditStamp {
    const legacy = requireRecord(value, label);
    assertExactKeys(legacy, [
        'atEpochMs', 'actor', 'byPrincipalId', 'bySessionId', 'byServiceId',
        'reason', 'traceId', 'requestId',
    ], label);
    const canonical: unknown = {
        atEpochMs: legacy.atEpochMs,
        actor: Object.hasOwn(legacy, 'actor')
            ? legacy.actor
            : normalizePersistedGroupActor(legacy, `${label} actor`),
        reason: persistedOrDefault(legacy, 'reason', null),
        traceId: persistedOrDefault(legacy, 'traceId', null),
        requestId: persistedOrDefault(legacy, 'requestId', null),
    };
    validateAuditStamp(canonical, label);
    return canonical;
}

function normalizePersistedGroupActor(
    legacy: Readonly<Record<string, unknown>>,
    label: string,
): MutationActor {
    let canonical: unknown;
    if (Object.hasOwn(legacy, 'bySessionId')) {
        canonical = {
            kind: 'session',
            sessionId: legacy.bySessionId,
            principalId: legacy.byPrincipalId,
        };
    } else if (Object.hasOwn(legacy, 'byPrincipalId')) {
        canonical = { kind: 'principal', principalId: legacy.byPrincipalId };
    } else {
        canonical = { kind: 'service', serviceId: legacy.byServiceId };
    }
    validateMutationActor(canonical, label);
    return canonical;
}

function validateAuditStamp(
    value: unknown,
    label: string,
): asserts value is AuditStamp {
    const audit = requireRecord(value, label);
    assertExactKeys(audit, [
        'atEpochMs', 'actor', 'reason', 'traceId', 'requestId',
    ], label);
    assertRequiredKeys(audit, [
        'atEpochMs', 'actor', 'reason', 'traceId', 'requestId',
    ], label);
    requireNonNegativeSafeInteger(audit.atEpochMs, `${label} atEpochMs`);
    validateMutationActor(audit.actor, `${label} actor`);
    nullableNonEmptyString(audit.reason, `${label} reason`);
    nullableNonEmptyString(audit.traceId, `${label} traceId`);
    nullableNonEmptyString(audit.requestId, `${label} requestId`);
}

function validateMutationActor(
    value: unknown,
    label: string,
): asserts value is MutationActor {
    const actor = requireRecord(value, label);
    requireOneOf(actor.kind, ['principal', 'session', 'service'], `${label} kind`);
    const keys = actor.kind === 'principal'
        ? ['kind', 'principalId']
        : actor.kind === 'session'
        ? ['kind', 'sessionId', 'principalId']
        : ['kind', 'serviceId'];
    assertExactKeys(actor, keys, label);
    assertRequiredKeys(actor, keys, label);
    for (const key of keys.filter((key) => key !== 'kind')) {
        requireNonEmptyString(actor[key], `${label} ${key}`);
    }
}

function validateCausalRevision(
    value: unknown,
    label: string,
): asserts value is GroupStateCausalRevision {
    const revision = requireRecord(value, `${label} causalRevision`);
    assertExactKeys(revision, ['groupRevision', 'presenceRevision'],
        `${label} causalRevision`);
    assertRequiredKeys(revision, ['groupRevision', 'presenceRevision'],
        `${label} causalRevision`);
    requireNonNegativeSafeInteger(revision.groupRevision,
        `${label} groupRevision`);
    requireNonNegativeSafeInteger(revision.presenceRevision,
        `${label} presenceRevision`);
}

function validateMutationReceipt(
    value: unknown,
    ref: GroupRef,
    label: string,
): void {
    const receipt = requireRecord(value, label);
    assertExactKeys(receipt, [
        'commandId', 'requestId', 'commandHash', 'aggregateRef', 'outcome',
        'attemptCount', 'acceptedStorageRevision', 'stateRevision',
        'snapshotVersion', 'causalRevision', 'eventId', 'outboxIds', 'joinCode',
        'joinCodeExpiresAtEpochMs', 'rejection',
    ], label);
    assertRequiredKeys(receipt, [
        'commandId', 'requestId', 'commandHash', 'aggregateRef', 'outcome',
        'attemptCount', 'acceptedStorageRevision', 'stateRevision',
        'snapshotVersion', 'causalRevision', 'eventId', 'outboxIds', 'joinCode',
        'joinCodeExpiresAtEpochMs', 'rejection',
    ], label);
    requireNonEmptyString(receipt.commandId, `${label} commandId`);
    nullableNonEmptyString(receipt.requestId, `${label} requestId`);
    validateCommandHash(receipt.commandHash, `${label} commandHash`);
    const aggregateRef = receipt.aggregateRef;
    validateGroupRef(aggregateRef);
    validateScopedValue(aggregateRef, ref, `${label} aggregateRef`);
    requireOneOf(receipt.outcome, ['applied', 'no-op', 'rejected'],
        `${label} outcome`);
    requirePositiveSafeInteger(receipt.attemptCount, `${label} attemptCount`);
    if (receipt.acceptedStorageRevision !== null) {
        requireNonNegativeSafeInteger(
            receipt.acceptedStorageRevision,
            `${label} acceptedStorageRevision`,
        );
    }
    requireNonNegativeSafeInteger(receipt.stateRevision, `${label} stateRevision`);
    requireNonNegativeSafeInteger(receipt.snapshotVersion, `${label} snapshotVersion`);
    const causalRevision = receipt.causalRevision;
    validateCausalRevision(causalRevision, label);
    if (receipt.stateRevision !== toGroupSnapshotStateRevision(
        causalRevision.groupRevision,
        causalRevision.presenceRevision,
    )) {
        throw new TypeError(`${label} stateRevision differs from causalRevision`);
    }
    nullableNonEmptyString(receipt.eventId, `${label} eventId`);
    if (!Array.isArray(receipt.outboxIds)) {
        throw new TypeError(`${label} outboxIds is invalid`);
    }
    for (const outboxId of receipt.outboxIds) {
        requireNonEmptyString(outboxId, `${label} outboxId`);
    }
    if ((receipt.outcome === 'applied') !== (receipt.eventId !== null)) {
        throw new TypeError(`${label} event differs from outcome`);
    }
    if (receipt.joinCode !== null) {
        requireNonEmptyString(receipt.joinCode, `${label} joinCode`);
    }
    if (receipt.joinCodeExpiresAtEpochMs !== null) {
        requirePositiveSafeInteger(receipt.joinCodeExpiresAtEpochMs,
            `${label} joinCodeExpiresAtEpochMs`);
    }
    if ((receipt.joinCode === null) !== (receipt.joinCodeExpiresAtEpochMs === null)) {
        throw new TypeError(`${label} join-code fields must have matching presence`);
    }
    if (receipt.rejection !== null) {
        requireNonEmptyString(receipt.rejection, `${label} rejection`);
    }
    if ((receipt.outcome === 'rejected') !== (receipt.rejection !== null)) {
        throw new TypeError(`${label} rejection differs from outcome`);
    }
    if (receipt.outcome === 'applied') {
        if (receipt.acceptedStorageRevision === null) {
            throw new TypeError(`${label} acceptedStorageRevision is required when applied`);
        }
        requirePositiveSafeInteger(
            receipt.snapshotVersion,
            `${label} applied snapshotVersion`,
        );
        requirePositiveSafeInteger(
            causalRevision.groupRevision,
            `${label} applied groupRevision`,
        );
        if (receipt.outboxIds.length !== 1) {
            throw new TypeError(`${label} outboxIds differs from applied outcome`);
        }
        return;
    }
    if (receipt.outboxIds.length !== 0) {
        throw new TypeError(`${label} outboxIds differs from non-applied outcome`);
    }
    if (receipt.joinCode !== null || receipt.joinCodeExpiresAtEpochMs !== null) {
        throw new TypeError(`${label} join-code fields require an applied outcome`);
    }
    if (receipt.outcome === 'no-op') {
        requirePositiveSafeInteger(
            receipt.snapshotVersion,
            `${label} no-op snapshotVersion`,
        );
        if (
            receipt.acceptedStorageRevision === null ||
            causalRevision.groupRevision !== receipt.acceptedStorageRevision + 1
        ) {
            throw new TypeError(`${label} no-op revision differs from its predecessor`);
        }
        return;
    }
    if (receipt.acceptedStorageRevision === null) {
        if (
            causalRevision.groupRevision !== 0 ||
            causalRevision.presenceRevision !== 0 ||
            receipt.snapshotVersion !== 0
        ) {
            throw new TypeError(`${label} absent-group rejection has authority`);
        }
        return;
    }
    requirePositiveSafeInteger(
        receipt.snapshotVersion,
        `${label} rejected snapshotVersion`,
    );
    if (causalRevision.groupRevision !== receipt.acceptedStorageRevision + 1) {
        throw new TypeError(`${label} rejected revision differs from its predecessor`);
    }
}

function validateCommandHash(value: unknown, label: string): void {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
}

function validateGroupRef(value: unknown): asserts value is GroupRef {
    const ref = requireRecord(value, 'Group mutation aggregateRef');
    assertExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'],
        'Group mutation aggregateRef');
    requireNonEmptyString(ref.applicationId, 'Group applicationId');
    requireNonEmptyString(ref.workspaceId, 'Group workspaceId');
    requireNonEmptyString(ref.groupId, 'Group groupId');
}

function assertExactKeys(
    value: Readonly<Record<string, unknown>>,
    allowed: readonly string[],
    label: string,
): void {
    const allowedSet = new Set(allowed);
    const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
    if (unexpected) throw new TypeError(`${label} has unexpected key: ${unexpected}`);
}

function assertRequiredKeys(
    value: Readonly<Record<string, unknown>>,
    required: readonly string[],
    label: string,
): void {
    const missing = required.find((key) => !Object.hasOwn(value, key));
    if (missing) throw new TypeError(`${label} is missing mandatory key: ${missing}`);
}

function validateOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>,
): void {
    const nullableString = (key: string) => {
        if (input[key] !== null) requireNonEmptyString(input[key], `Group ${key}`);
    };
    const nullableInteger = (key: string, positive = false) => {
        const value = input[key];
        if (value === null) return;
        if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
            throw new TypeError(`Group ${key} is invalid`);
        }
    };
    switch (operation) {
        case 'createGroup':
            nullableString('slug');
            requireNonEmptyString(input.displayName, 'Group displayName');
            nullableString('description');
            requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
            requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
            nullableInteger('maxMembers', true);
            nullableInteger('maxSessionsPerMember', true);
            requireRecord(input.metadata, 'Group metadata');
            requireNonEmptyString(input.createdByPrincipalId, 'Group createdByPrincipalId');
            nullableInteger('expiresAtEpochMs', true);
            nullableInteger('purgeAfterEpochMs', true);
            return;
        case 'updateGroup':
            nullableString('slug');
            nullableString('displayName');
            nullableString('description');
            if (input.kind !== null) requireOneOf(input.kind,
                ['party', 'room', 'team', 'custom'], 'Group kind');
            if (input.status !== null) requireOneOf(input.status,
                ['active', 'archived', 'deleted'], 'Group status');
            if (input.joinMode !== null) requireOneOf(input.joinMode,
                ['invite-only', 'code', 'open'], 'Group joinMode');
            nullableInteger('maxMembers', true);
            nullableInteger('maxSessionsPerMember', true);
            if (input.metadata !== null) requireRecord(input.metadata, 'Group metadata');
            nullableInteger('expiresAtEpochMs', true);
            nullableInteger('emptySinceEpochMs', true);
            nullableInteger('purgeAfterEpochMs', true);
            return;
        case 'appointDirector':
            requirePositiveSafeInteger(input.heartbeatTtlMs, 'Group heartbeatTtlMs');
            return;
        case 'joinGroup':
        case 'acceptGroupInvite':
            nullableString('inviteToken');
            nullableString('joinCode');
            return;
        case 'createGroupInvite':
            nullableInteger('invitationExpiresAtEpochMs', true);
            return;
        case 'setGroupMemberRole':
            requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
            return;
        case 'upsertMember':
            if (input.role !== null) requireOneOf(input.role,
                ['owner', 'admin', 'member'], 'Group role');
            requireOneOf(input.status,
                ['invited', 'active', 'left', 'removed', 'banned'],
                'Group member status');
            nullableString('invitedByPrincipalId');
            nullableInteger('invitationExpiresAtEpochMs', true);
            return;
        case 'rotateGroupJoinCode':
            nullableString('joinCode');
            nullableInteger('expiresAtEpochMs', true);
            return;
        case 'connectPresence':
            requireNonEmptyString(input.principalId, 'Group presence principalId');
            nullableInteger('connectedAtEpochMs', true);
            nullableInteger('lastHeartbeatAtEpochMs', true);
            nullableInteger('expiresAtEpochMs', true);
            return;
        case 'heartbeatPresence':
            nullableString('principalId');
            nullableInteger('lastHeartbeatAtEpochMs', true);
            nullableInteger('expiresAtEpochMs', true);
            return;
        case 'disconnectPresence':
            nullableString('principalId');
            nullableInteger('generationVersion', true);
            nullableInteger('observedExpiresAtEpochMs', true);
            nullableInteger('disconnectedAtEpochMs', true);
            nullableInteger('lastHeartbeatAtEpochMs', true);
            nullableInteger('expiresAtEpochMs', true);
            return;
        case 'revokeGroupInvite':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'transferGroupOwnership':
            return;
    }
}

function requireOneOf(
    value: unknown,
    allowed: readonly string[],
    label: string,
): void {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new TypeError(`${label} is invalid`);
    }
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

function optionalNonEmptyString(value: unknown, label: string): void {
    if (value !== undefined) requireNonEmptyString(value, label);
}

function nullableNonEmptyString(value: unknown, label: string): void {
    if (value === null) return;
    requireNonEmptyString(value, label);
}

function requireNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
}

function optionalPositiveSafeInteger(value: unknown, label: string): void {
    if (value !== undefined) requirePositiveSafeInteger(value, label);
}

function nullablePositiveSafeInteger(
    value: unknown,
    label: string,
): asserts value is number | null {
    if (value !== null) requirePositiveSafeInteger(value, label);
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

const TARGET_GROUP_MUTATION_OPERATIONS = new Set<GroupMutationCommand['operation']>([
    'joinGroup', 'acceptGroupInvite', 'createGroupInvite', 'revokeGroupInvite',
    'removeGroupMember', 'banGroupMember', 'unbanGroupMember',
    'setGroupMemberRole', 'transferGroupOwnership', 'upsertMember',
]);

const PRESENCE_GROUP_MUTATION_OPERATIONS = new Set<GroupMutationCommand['operation']>([
    'connectPresence', 'heartbeatPresence', 'disconnectPresence',
]);

const ACTOR_INPUT_KEYS = [
    'actorPrincipalId', 'actorSessionId', 'reason', 'traceId',
] as const;

const MUTATION_REQUEST_KEYS = [...ACTOR_INPUT_KEYS, 'requestId'] as const;

const GROUP_MUTATION_REQUEST_KEYS: Readonly<
    Record<GroupMutationCommand['operation'], readonly string[]>
> = {
    createGroup: [...MUTATION_REQUEST_KEYS, 'groupId', 'slug', 'displayName',
        'description', 'kind', 'joinMode', 'maxMembers', 'maxSessionsPerMember',
        'metadata', 'createdByPrincipalId', 'expiresAtEpochMs', 'purgeAfterEpochMs'],
    updateGroup: [...MUTATION_REQUEST_KEYS, 'slug', 'displayName', 'description',
        'kind', 'status', 'joinMode', 'maxMembers', 'maxSessionsPerMember',
        'metadata', 'expiresAtEpochMs', 'emptySinceEpochMs', 'purgeAfterEpochMs'],
    appointDirector: [...MUTATION_REQUEST_KEYS, 'heartbeatTtlMs'],
    joinGroup: [...MUTATION_REQUEST_KEYS, 'inviteToken', 'joinCode'],
    acceptGroupInvite: MUTATION_REQUEST_KEYS,
    createGroupInvite: [...MUTATION_REQUEST_KEYS, 'invitationExpiresAtEpochMs'],
    revokeGroupInvite: MUTATION_REQUEST_KEYS,
    removeGroupMember: MUTATION_REQUEST_KEYS,
    banGroupMember: MUTATION_REQUEST_KEYS,
    unbanGroupMember: MUTATION_REQUEST_KEYS,
    setGroupMemberRole: [...MUTATION_REQUEST_KEYS, 'role'],
    transferGroupOwnership: [...MUTATION_REQUEST_KEYS, 'newOwnerPrincipalId'],
    upsertMember: [...MUTATION_REQUEST_KEYS, 'role', 'status',
        'invitedByPrincipalId', 'invitationExpiresAtEpochMs'],
    rotateGroupJoinCode: [...MUTATION_REQUEST_KEYS, 'joinCode', 'expiresAtEpochMs'],
    connectPresence: [...MUTATION_REQUEST_KEYS, 'principalId', 'generationId',
        'connectedAtEpochMs', 'lastHeartbeatAtEpochMs', 'expiresAtEpochMs'],
    heartbeatPresence: [...MUTATION_REQUEST_KEYS, 'principalId', 'generationId',
        'lastHeartbeatAtEpochMs', 'expiresAtEpochMs'],
    disconnectPresence: [...MUTATION_REQUEST_KEYS, 'principalId', 'generationId',
        'generationVersion', 'observedExpiresAtEpochMs', 'disconnectedAtEpochMs',
        'lastHeartbeatAtEpochMs', 'expiresAtEpochMs'],
};

const GROUP_MUTATION_INPUT_KEYS: Readonly<
    Record<GroupMutationCommand['operation'], readonly string[]>
> = {
    createGroup: [...ACTOR_INPUT_KEYS, 'slug', 'displayName', 'description',
        'kind', 'joinMode', 'maxMembers', 'maxSessionsPerMember', 'metadata',
        'createdByPrincipalId', 'expiresAtEpochMs', 'purgeAfterEpochMs'],
    updateGroup: [...ACTOR_INPUT_KEYS, 'slug', 'displayName', 'description',
        'kind', 'status', 'joinMode', 'maxMembers', 'maxSessionsPerMember',
        'metadata', 'expiresAtEpochMs', 'emptySinceEpochMs', 'purgeAfterEpochMs'],
    appointDirector: [...ACTOR_INPUT_KEYS, 'heartbeatTtlMs'],
    joinGroup: [...ACTOR_INPUT_KEYS, 'inviteToken', 'joinCode'],
    acceptGroupInvite: [...ACTOR_INPUT_KEYS, 'inviteToken', 'joinCode'],
    createGroupInvite: [...ACTOR_INPUT_KEYS, 'invitationExpiresAtEpochMs'],
    revokeGroupInvite: ACTOR_INPUT_KEYS,
    removeGroupMember: ACTOR_INPUT_KEYS,
    banGroupMember: ACTOR_INPUT_KEYS,
    unbanGroupMember: ACTOR_INPUT_KEYS,
    setGroupMemberRole: [...ACTOR_INPUT_KEYS, 'role'],
    transferGroupOwnership: ACTOR_INPUT_KEYS,
    upsertMember: [...ACTOR_INPUT_KEYS, 'role', 'status',
        'invitedByPrincipalId', 'invitationExpiresAtEpochMs'],
    rotateGroupJoinCode: [...ACTOR_INPUT_KEYS, 'joinCode', 'expiresAtEpochMs'],
    connectPresence: [...ACTOR_INPUT_KEYS, 'principalId', 'generationId',
        'connectedAtEpochMs', 'lastHeartbeatAtEpochMs', 'expiresAtEpochMs'],
    heartbeatPresence: [...ACTOR_INPUT_KEYS, 'principalId', 'generationId',
        'lastHeartbeatAtEpochMs', 'expiresAtEpochMs'],
    disconnectPresence: [...ACTOR_INPUT_KEYS, 'principalId', 'generationId',
        'generationVersion', 'observedExpiresAtEpochMs', 'disconnectedAtEpochMs',
        'lastHeartbeatAtEpochMs', 'expiresAtEpochMs'],
};
