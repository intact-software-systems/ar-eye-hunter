import type {
    GroupEvent,
    GroupPresenceSession,
    GroupRef,
    GroupScope,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type {
    AcceptGroupInviteRequest,
    AppointGroupDirectorRequest,
    BanGroupMemberRequest,
    ConnectGroupPresenceSessionRequest,
    CreateGroupInviteRequest,
    CreateGroupRequest,
    DisconnectGroupPresenceSessionRequest,
    GroupJoinCodeResponse,
    HeartbeatGroupPresenceSessionRequest,
    JoinGroupRequest,
    RemoveGroupMemberRequest,
    RevokeGroupInviteRequest,
    RotateGroupJoinCodeRequest,
    SetGroupMemberRoleRequest,
    StateScope,
    TransferGroupOwnershipRequest,
    UnbanGroupMemberRequest,
    UpdateGroupRequest,
    UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateEventListQuery } from '../state-event-listing.ts';
import { Either } from '@shared/resilience/Either.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS,
    normalizeRallarGroupDirectorHeartbeatTtlMs,
} from '@shared/api/group-director.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import { hashStateMutationCommand } from '../repositories/StateMutationOutboxRepository.ts';
import type { GroupStateEventStore } from '../repositories/StateEventStore.ts';
import type { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import type { IssuedAuthSession } from '../repositories/auth-session-types.ts';
import type { PersistedAuthSession } from '../repositories/auth-persistence-contracts.ts';
import {
    computeGroupMutation,
    type GroupMutationCommand,
    type GroupMutationComputed,
    type GroupMutationComputedWrite,
    type GroupMutationFacts,
    type GroupMutationReceipt,
    type GroupMutationRead,
    validateGroupMutation,
    validateGroupMutationCommand,
} from './group-state-mutations.ts';
import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { readGroupMutation } from './group-state-mutation-read.ts';
import { writeGroupMutation } from './group-state-guarded-batch.ts';
import { type RallarTimingSink, timeRallarAsync } from './timing.ts';
import { authSessionProofSecret } from './auth-session-proof-secret.ts';
import {
    canonicalJson,
    constantTimeHexEqual,
    constantTimeSecretEqual,
    hmacSha256Hex,
    sha256CanonicalJson,
} from './group-state-crypto.ts';
import { createWsSessionGenerationLifecycleService, type WsSessionGenerationCloseFacts, type WsSessionGenerationLifecycleService } from './ws-session-generation-lifecycle.ts';

export type GroupWritten = Readonly<{
  snapshot: GroupSnapshot;
  event: GroupEvent;
}>;
export type GroupMutationWritten = Readonly<{
  snapshot: GroupSnapshot;
  event: GroupEvent | null;
}>;
export type GroupStateWritten = Readonly<{
    status: 'created' | 'ok' | 'error';
    result: Either<string, GroupMutationWritten>;
}>;

export type GroupJoinCodeMutationWritten =
  & GroupJoinCodeResponse
  & Readonly<{ event: GroupEvent | null }>;
export type GroupJoinCodeWritten = Readonly<{
  status: 'ok' | 'error';
  result: Either<string, GroupJoinCodeMutationWritten>;
}>;
export type GroupSnapshotPageOptions = Readonly<{
    afterKey?: string;
    limit: number;
}>;

export type GroupSnapshotPage = Readonly<{
    snapshots: readonly GroupSnapshot[];
    scannedGroupCount: number;
    hasMore: boolean;
    nextGroupKey?: string;
}>;

export type GroupMutationAuthorityProof = Readonly<{
    version: 1;
    principalId: string;
    sessionId: string;
    sessionIssuedAtEpochMs: number;
    sessionExpiresAtEpochMs: number;
    commandMac: string;
}>;

export type GroupMutationAuthority =
    | IssuedAuthSession
    | GroupMutationAuthorityProof;

export const GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS = 253_402_300_799_999;

export type GroupMutationDescriptor = Readonly<{
    operation: GroupMutationCommand['operation'];
    scope: StateScope;
    groupId: string;
    targetPrincipalId: string | null;
    sessionId: string | null;
    request:
        | CreateGroupRequest
        | UpdateGroupRequest
        | AppointGroupDirectorRequest
        | JoinGroupRequest
        | CreateGroupInviteRequest
        | RevokeGroupInviteRequest
        | AcceptGroupInviteRequest
        | RotateGroupJoinCodeRequest
        | RemoveGroupMemberRequest
        | BanGroupMemberRequest
        | UnbanGroupMemberRequest
        | SetGroupMemberRoleRequest
        | TransferGroupOwnershipRequest
        | UpsertGroupMemberRequest
        | ConnectGroupPresenceSessionRequest
        | HeartbeatGroupPresenceSessionRequest
        | DisconnectGroupPresenceSessionRequest;
}>;

export type GroupMutationPreparation = Readonly<{
    authorityProof: GroupMutationAuthorityProof | null;
    descriptor: GroupMutationDescriptor | null;
    command: GroupMutationCommand;
    facts: Omit<GroupMutationFacts, 'attemptCount'>;
    causalToken: string;
    queueResourceId: string;
}>;

export type GroupStateMutationCommand = Readonly<{
    authorityProof: GroupMutationAuthorityProof | null;
    descriptor: GroupMutationDescriptor | null;
    command: GroupMutationCommand;
    facts: GroupMutationFacts;
}>;

export type GroupStateMutationService = Readonly<{
    read(command: GroupStateMutationCommand): Promise<GroupMutationRead>;
    compute(
        command: GroupStateMutationCommand,
        read: GroupMutationRead,
    ): GroupMutationComputed;
    validate(
        command: GroupStateMutationCommand,
        read: GroupMutationRead,
        computed: GroupMutationComputed,
    ): void;
    write(
        transaction: PSqlTransactionSql,
        computed: GroupMutationComputedWrite,
    ): Promise<GroupMutationReceipt>;
}>;

export type GroupStateService = GroupStateMutationService & Readonly<{
    sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    prepareMutation(
        descriptor: GroupMutationDescriptor,
        authority: IssuedAuthSession,
    ): Promise<GroupMutationPreparation>;
    prepareExpiredPresenceMutations(
        atEpochMs: number,
    ): Promise<readonly GroupMutationPreparation[]>;
    prepareSessionCleanupMutations(
        input: WsSessionGenerationCloseFacts,
    ): Promise<readonly GroupMutationPreparation[]>;
    listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]>;
    listSnapshotsPage(
        scope: GroupScope,
        options: GroupSnapshotPageOptions,
    ): Promise<GroupSnapshotPage>;
    readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    readStateRevision(ref: GroupRef): Promise<number | undefined>;
    readCausalRevision(ref: GroupRef): Promise<GroupStateCausalRevision | undefined>;
    readIssuedAuthSession(sessionId: string): Promise<PersistedAuthSession | undefined>;
    listEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
    listRecentEvents?(
        ref: GroupRef,
        query: StateEventListQuery,
    ): Promise<readonly GroupEvent[]>;
    listEventPage(
        ref: GroupRef,
        query: StateEventListQuery,
    ): Promise<StateEventPage<GroupEvent>>;
}>;

export type GroupStateRuntime = Readonly<{
    service: GroupStateService;
}>;

export type GroupStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    createGroupStateEventStore?: (
        runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => GroupStateEventStore;
    now?: () => number;
    randomId?: () => string;
    serviceId: string;
    timing?: RallarTimingSink;
    authSessionRepository: Pick<AuthSessionRepository, 'findBySessionId'>;
}>;

export class GroupMutationAuthorizationError extends Error {
    readonly status = 403;
    readonly code = 'group-mutation-authority-denied';

    constructor(message: string) {
        super(`Forbidden: ${message}`);
        this.name = 'GroupMutationAuthorizationError';
    }
}

export class GroupMutationIdempotencyConflictError extends Error {
    readonly status = 409;
    readonly code = 'group-mutation-idempotency-conflict';

    constructor(
        readonly commandId: string,
        readonly existingCommandHash: string,
        readonly receivedCommandHash: string,
    ) {
        super(`Group mutation command differs for request ${commandId}`);
        this.name = 'GroupMutationIdempotencyConflictError';
    }
}

export function createGroupStateRuntime(
    dependencies: GroupStateServiceDependencies,
): GroupStateRuntime {
    if (!dependencies.authSessionRepository ||
        typeof dependencies.authSessionRepository.findBySessionId !== 'function') {
        throw new GroupMutationAuthorizationError(
            'An auth session repository is required for group mutations.',
        );
    }
    const runtime = dependencies.runtimeRepository;
    const now = dependencies.now ?? (() => Date.now());
    const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
    const repositoryFor = (
        target: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => new GroupStateRepository(target, {
        events: dependencies.createGroupStateEventStore?.(target),
    });
    const prepareMutation = async (
            descriptor: GroupMutationDescriptor,
            authority: IssuedAuthSession,
        ): Promise<GroupMutationPreparation> => {
            const verified = await verifyGroupMutationAuthority(
                dependencies.authSessionRepository,
                descriptor,
                authority,
                now(),
            );
            requireGroupMutationRequestId(verified.descriptor);
            const command = toDescriptorCommand(
                verified.descriptor,
                randomId,
            );
            validateGroupMutationCommand(command);
            const commandHash = await hashStateMutationCommand(command);
            const resolvedJoinCode = resolveCommandJoinCode(command, commandHash);
            const facts: Omit<GroupMutationFacts, 'attemptCount'> = {
                nowEpochMs: now(),
                expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
                serviceId: dependencies.serviceId,
                eventId: `group-event:${commandHash.slice('sha256:'.length)}`,
                commandHash,
                resolvedJoinCode,
                joinCodeVerifier: await joinCodeVerifier(resolvedJoinCode),
                internalAuthority: 'none',
                authenticatedAuthority: {
                    principalId: verified.session.clientId,
                    sessionId: verified.session.sessionId,
                },
            };
            const authorityProof = await createGroupMutationAuthorityProof(
                verified.session,
                verified.descriptor,
            );
            const preparationCausalRevision = await repositoryFor(runtime)
                .readCausalRevision(command.aggregateRef) ?? null;
            const causalToken = await sha256CanonicalJson(
                { command, facts, preparationCausalRevision },
            );
            const queueResourceId = `g-${(await sha256CanonicalJson({
                requestId: command.requestId,
                authoritySession: {
                    sessionId: verified.session.sessionId,
                    issuedAtEpochMs: verified.session.issuedAtEpochMs,
                    expiresAtEpochMs: verified.session.expiresAtEpochMs,
                },
                commandMac: authorityProof.commandMac,
                causalToken,
            })).slice(0, 34)}`;
            return {
                authorityProof,
                descriptor: verified.descriptor,
                command,
                facts,
                causalToken,
                queueResourceId,
            };
        };

    const prepareInternalMutation = async (
        command: GroupMutationCommand,
        internalAuthority: Exclude<GroupMutationFacts['internalAuthority'], 'none'>,
        atEpochMs: number,
    ): Promise<GroupMutationPreparation> => {
        validateGroupMutationCommand(command);
        const commandHash = await hashStateMutationCommand(command);
        const facts: Omit<GroupMutationFacts, 'attemptCount'> = {
            nowEpochMs: atEpochMs,
            expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
            serviceId: dependencies.serviceId,
            eventId: `group-event:${commandHash.slice('sha256:'.length)}`,
            commandHash,
            resolvedJoinCode: null,
            joinCodeVerifier: null,
            internalAuthority,
            authenticatedAuthority: null,
        };
        const causalToken = await sha256CanonicalJson({ command, facts });
        return {
            authorityProof: null,
            descriptor: null,
            command,
            facts,
            causalToken,
            queueResourceId: `g-${causalToken.slice('sha256:'.length, 34)}`,
        };
    };

    const service: GroupStateService = {
        sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(runtime),
        prepareMutation,
        prepareExpiredPresenceMutations: async (atEpochMs) => {
            const candidates = (await repositoryFor(runtime).listAllPresenceSessions())
                .filter((session) =>
                    session.disconnectedAtEpochMs === null &&
                    session.expiresAtEpochMs <= atEpochMs
                );
            return await Promise.all(candidates.map((session) =>
                prepareInternalMutation(toExpiryCommand(session, atEpochMs), 'expiry', atEpochMs)
            ));
        },
        prepareSessionCleanupMutations: async (input) => {
            const candidates = (await repositoryFor(runtime).listAllPresenceSessions())
                .filter((session) =>
                    session.sessionId === input.sessionId &&
                    session.generationId === input.generationId &&
                    session.generationVersion === input.generationStartedAtEpochMs &&
                    session.disconnectedAtEpochMs === null
                );
            return await Promise.all(candidates.map((session) =>
                prepareInternalMutation(
                    toSessionCleanupCommand(session, input.disconnectedAtEpochMs),
                    'session-cleanup',
                    input.disconnectedAtEpochMs,
                )
            ));
        },
        listSnapshots: async (scope) => await repositoryFor(runtime).listSnapshots(scope),
        listSnapshotsPage: async (scope, options) =>
            await repositoryFor(runtime).listSnapshotsPage(scope, options),
        readSnapshot: async (ref) => await repositoryFor(runtime).readSnapshot(ref),
        readStateRevision: async (ref) => await repositoryFor(runtime).readStateRevision(ref),
        readCausalRevision: async (ref) => await repositoryFor(runtime).readCausalRevision(ref),
        readIssuedAuthSession: async (sessionId) =>
            await dependencies.authSessionRepository.findBySessionId(sessionId),
        listEvents: async (ref) => await repositoryFor(runtime).listEvents(ref),
        listRecentEvents: async (ref, query) =>
            await repositoryFor(runtime).listRecentEvents(ref, query),
        listEventPage: async (ref, query) =>
            await repositoryFor(runtime).listEventPage(ref, query),
        read: async (prepared) => {
            if (prepared.facts.internalAuthority !== 'none') {
                if (
                    prepared.authorityProof !== null ||
                    prepared.descriptor !== null ||
                    prepared.facts.authenticatedAuthority !== null
                ) {
                    throw new GroupMutationAuthorizationError(
                        'Internal group mutation authority is malformed.',
                    );
                }
                return await readGroupMutation(repositoryFor(runtime), prepared.command);
            }
            if (prepared.authorityProof === null || prepared.descriptor === null) {
                throw new GroupMutationAuthorizationError(
                    'Authenticated group mutation authority is missing.',
                );
            }
            const verified = await verifyGroupMutationAuthority(
                dependencies.authSessionRepository,
                prepared.descriptor,
                prepared.authorityProof,
                now(),
            );
            if (canonicalJson(verified.descriptor) !== canonicalJson(prepared.descriptor)) {
                throw new GroupMutationAuthorizationError(
                    'Authenticated mutation descriptor changed before execution.',
                );
            }
            const command = toDescriptorCommand(verified.descriptor, randomId);
            const commandHash = await hashStateMutationCommand(command);
            if (
                canonicalJson(command) !== canonicalJson(prepared.command) ||
                commandHash !== prepared.facts.commandHash ||
                prepared.facts.authenticatedAuthority?.principalId !==
                    verified.session.clientId ||
                prepared.facts.authenticatedAuthority?.sessionId !==
                    verified.session.sessionId
            ) {
                throw new GroupMutationAuthorizationError(
                    'Durable group mutation facts differ from authenticated command.',
                );
            }
            return await readGroupMutation(repositoryFor(runtime), prepared.command);
        },
        compute: (prepared, read) => computeGroupMutation({
            command: prepared.command,
            read,
            facts: prepared.facts,
        }),
        validate: (prepared, read, computed) => {
            validateGroupMutation({
                command: prepared.command,
                read,
                facts: prepared.facts,
                computed,
            });
            if (computed.outcome === 'idempotency-conflict') {
                throw new GroupMutationIdempotencyConflictError(
                    prepared.command.commandId,
                    computed.existingCommandHash,
                    computed.receivedCommandHash,
                );
            }
        },
        write: async (transaction, computed) =>
            await writeGroupMutation(transaction, computed),
    };

    return {
        service: withGroupStateServiceTiming(
            service,
            dependencies.timing,
            dependencies.serviceId,
        ),
    };
}

export function createGroupStateService(
    dependencies: GroupStateServiceDependencies,
): GroupStateService {
    return createGroupStateRuntime(dependencies).service;
}

type VerifiedGroupMutationAuthority = Readonly<{
    session: PersistedAuthSession;
    descriptor: GroupMutationDescriptor;
}>;

export function mutationDescriptor(
    operation: GroupMutationDescriptor['operation'],
    scope: StateScope,
    groupId: string,
    request: GroupMutationDescriptor['request'],
    targetPrincipalId: string | null = null,
    sessionId: string | null = null,
): GroupMutationDescriptor {
    return {
        operation,
        scope,
        groupId,
        targetPrincipalId,
        sessionId,
        request,
    };
}

async function verifyGroupMutationAuthority(
    repository: Pick<AuthSessionRepository, 'findBySessionId'>,
    descriptor: GroupMutationDescriptor,
    authority: GroupMutationAuthority,
    nowEpochMs: number,
): Promise<VerifiedGroupMutationAuthority> {
    const claimed = isGroupMutationAuthorityProof(authority)
        ? {
            clientId: authority.principalId,
            sessionId: authority.sessionId,
            issuedAtEpochMs: authority.sessionIssuedAtEpochMs,
            expiresAtEpochMs: authority.sessionExpiresAtEpochMs,
        }
        : authority;
    const session = await repository.findBySessionId(claimed.sessionId);
    if (
        !session ||
        session.clientId !== claimed.clientId ||
        session.sessionId !== claimed.sessionId ||
        session.issuedAtEpochMs !== claimed.issuedAtEpochMs ||
        session.expiresAtEpochMs !== claimed.expiresAtEpochMs ||
        session.expiresAtEpochMs <= nowEpochMs
    ) {
        throw new GroupMutationAuthorizationError(
            'Authenticated session is missing, expired, revoked, or mismatched.',
        );
    }
    if (!isGroupMutationAuthorityProof(authority)) {
        if (!await constantTimeSecretEqual(
            session.accessTokenDigest,
            await authSessionProofSecret(authority),
        )) {
            throw new GroupMutationAuthorizationError(
                'Authenticated session credential is invalid.',
            );
        }
    }
    const trustedDescriptor = toTrustedMutationDescriptor(descriptor, {
        principalId: session.clientId,
        sessionId: session.sessionId,
    });
    if (isGroupMutationAuthorityProof(authority)) {
        const expected = await createGroupMutationAuthorityProof(
            session,
            trustedDescriptor,
        );
        if (!constantTimeHexEqual(expected.commandMac, authority.commandMac)) {
            throw new GroupMutationAuthorizationError(
                'Authenticated mutation proof does not match the command.',
            );
        }
    }
    return { session, descriptor: trustedDescriptor };
}

function toTrustedMutationDescriptor(
    descriptor: GroupMutationDescriptor,
    authority: Readonly<{ principalId: string; sessionId: string }>,
): GroupMutationDescriptor {
    const request = descriptor.request as GroupMutationDescriptor['request'] & Readonly<{
        actorPrincipalId?: string;
        actorSessionId?: string;
        createdByPrincipalId?: string;
        principalId?: string;
    }>;
    if (
        request.actorPrincipalId !== undefined &&
        request.actorPrincipalId !== authority.principalId
    ) {
        throw new GroupMutationAuthorizationError(
            'Request actor principal does not match authenticated principal.',
        );
    }
    if (
        request.actorSessionId !== undefined &&
        request.actorSessionId !== authority.sessionId
    ) {
        throw new GroupMutationAuthorizationError(
            'Request actor session does not match authenticated session.',
        );
    }
    if (
        descriptor.operation === 'createGroup' &&
        request.createdByPrincipalId !== authority.principalId
    ) {
        throw new GroupMutationAuthorizationError(
            'Group creator does not match authenticated principal.',
        );
    }
    if (
        descriptor.operation === 'connectPresence' ||
        descriptor.operation === 'heartbeatPresence' ||
        descriptor.operation === 'disconnectPresence'
    ) {
        if (descriptor.sessionId !== authority.sessionId) {
            throw new GroupMutationAuthorizationError(
                'Presence session does not match authenticated session.',
            );
        }
        if (
            request.principalId !== undefined &&
            request.principalId !== authority.principalId
        ) {
            throw new GroupMutationAuthorizationError(
                'Presence principal does not match authenticated principal.',
            );
        }
    }
    return {
        ...descriptor,
        request: {
            ...request,
            actorPrincipalId: authority.principalId,
            actorSessionId: authority.sessionId,
        },
    };
}

async function createGroupMutationAuthorityProof(
    session: IssuedAuthSession | PersistedAuthSession,
    descriptor: GroupMutationDescriptor,
): Promise<GroupMutationAuthorityProof> {
    return {
        version: 1,
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        commandMac: await hmacSha256Hex(
            await authSessionProofSecret(session),
            canonicalJson({
                purpose: 'rallar-group-mutation-authority',
                version: 1,
                descriptor,
            }),
        ),
    };
}

function isGroupMutationAuthorityProof(
    authority: GroupMutationAuthority,
): authority is GroupMutationAuthorityProof {
    return 'version' in authority && authority.version === 1 &&
        'commandMac' in authority;
}

function requireGroupMutationRequestId(descriptor: GroupMutationDescriptor): void {
    const requestId = descriptor.request.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
        throw new NonRetryableException(
            'Authenticated app inbox mutation requestId is required.',
        );
    }
}

export function toDescriptorCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string,
): GroupMutationCommand {
    switch (descriptor.operation) {
        case 'createGroup': {
            const request = descriptor.request as CreateGroupRequest;
            if (request.groupId !== descriptor.groupId) {
                throw new NonRetryableException('Group create identity is inconsistent');
            }
            return toCreateCommand(descriptor.scope, request, randomId);
        }
        case 'updateGroup':
            return toUpdateCommand(
                descriptor.scope,
                descriptor.groupId,
                descriptor.request as UpdateGroupRequest,
                randomId,
            );
        case 'appointDirector':
            return toDirectorCommand(
                descriptor.scope,
                descriptor.groupId,
                descriptor.request as AppointGroupDirectorRequest,
                randomId,
            );
        case 'joinGroup':
        case 'acceptGroupInvite':
            return toJoinCommand(
                descriptor.operation,
                descriptor.scope,
                descriptor.groupId,
                descriptor.request as JoinGroupRequest | AcceptGroupInviteRequest,
                randomId,
            );
        case 'createGroupInvite':
            return toInviteCommand(
                descriptor.scope,
                descriptor.groupId,
                requireTargetPrincipalId(descriptor),
                descriptor.request as CreateGroupInviteRequest,
                randomId,
            );
        case 'revokeGroupInvite':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
            return toTargetCommand(
                descriptor.operation,
                descriptor.scope,
                descriptor.groupId,
                requireTargetPrincipalId(descriptor),
                descriptor.request as RevokeGroupInviteRequest,
                randomId,
            );
        case 'setGroupMemberRole':
            return toRoleCommand(
                descriptor.scope,
                descriptor.groupId,
                requireTargetPrincipalId(descriptor),
                descriptor.request as SetGroupMemberRoleRequest,
                randomId,
            );
        case 'transferGroupOwnership': {
            const request = descriptor.request as TransferGroupOwnershipRequest;
            if (descriptor.targetPrincipalId !== request.newOwnerPrincipalId) {
                throw new NonRetryableException('Ownership target identity is inconsistent');
            }
            return toTransferCommand(
                descriptor.scope,
                descriptor.groupId,
                request,
                randomId,
            );
        }
        case 'upsertMember':
            return toUpsertMemberCommand(
                descriptor.scope,
                descriptor.groupId,
                requireTargetPrincipalId(descriptor),
                descriptor.request as UpsertGroupMemberRequest,
                randomId,
            );
        case 'rotateGroupJoinCode':
            return toRotateCommand(
                descriptor.scope,
                descriptor.groupId,
                descriptor.request as RotateGroupJoinCodeRequest,
                randomId,
            );
        case 'connectPresence':
            return toConnectPresenceCommand(
                descriptor.scope,
                descriptor.groupId,
                requireSessionId(descriptor),
                descriptor.request as ConnectGroupPresenceSessionRequest,
                randomId,
            );
        case 'heartbeatPresence':
            return toHeartbeatPresenceCommand(
                descriptor.scope,
                descriptor.groupId,
                requireSessionId(descriptor),
                descriptor.request as HeartbeatGroupPresenceSessionRequest,
                randomId,
            );
        case 'disconnectPresence':
            return toDisconnectPresenceCommand(
                descriptor.scope,
                descriptor.groupId,
                requireSessionId(descriptor),
                descriptor.request as DisconnectGroupPresenceSessionRequest,
                randomId,
            );
    }
}

function requireTargetPrincipalId(descriptor: GroupMutationDescriptor): string {
    if (!descriptor.targetPrincipalId) {
        throw new NonRetryableException('Group mutation target principal is required');
    }
    return descriptor.targetPrincipalId;
}

function requireSessionId(descriptor: GroupMutationDescriptor): string {
    if (!descriptor.sessionId) {
        throw new NonRetryableException('Group mutation session is required');
    }
    return descriptor.sessionId;
}

function toCreateCommand(
    scope: StateScope,
    request: CreateGroupRequest,
    randomId: () => string,
): GroupMutationCommand {
    const commandId = request.requestId ?? randomId();
    return {
        operation: 'createGroup',
        aggregateRef: { ...scope, groupId: request.groupId },
        commandId,
        requestId: request.requestId ?? commandId,
        input: {
            slug: request.slug ?? null,
            displayName: request.displayName,
            description: request.description ?? null,
            kind: request.kind,
            joinMode: request.joinMode ?? 'invite-only',
            maxMembers: request.maxMembers ?? null,
            maxSessionsPerMember: request.maxSessionsPerMember ?? null,
            metadata: structuredClone(request.metadata ?? {}),
            createdByPrincipalId: request.createdByPrincipalId,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            purgeAfterEpochMs: request.purgeAfterEpochMs ?? null,
            ...actorInput(request),
            actorPrincipalId:
                request.actorPrincipalId ?? request.createdByPrincipalId,
        },
    };
}

function toUpdateCommand(
    scope: StateScope,
    groupId: string,
    request: UpdateGroupRequest,
    randomId: () => string,
): GroupMutationCommand {
    return {
        operation: 'updateGroup',
        aggregateRef: { ...scope, groupId },
        ...identity(request.requestId, randomId),
        input: {
            slug: request.slug ?? null,
            displayName: request.displayName ?? null,
            description: request.description ?? null,
            kind: request.kind ?? null,
            status: request.status ?? null,
            joinMode: request.joinMode ?? null,
            maxMembers: request.maxMembers ?? null,
            maxSessionsPerMember: request.maxSessionsPerMember ?? null,
            metadata: request.metadata ? structuredClone(request.metadata) : null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            emptySinceEpochMs: request.emptySinceEpochMs ?? null,
            purgeAfterEpochMs: request.purgeAfterEpochMs ?? null,
            ...actorInput(request),
        },
    };
}

function toDirectorCommand(
    scope: StateScope,
    groupId: string,
    request: AppointGroupDirectorRequest,
    randomId: () => string,
): GroupMutationCommand {
    return {
        operation: 'appointDirector',
        aggregateRef: { ...scope, groupId },
        ...identity(request.requestId, randomId),
        input: {
            heartbeatTtlMs: normalizeRallarGroupDirectorHeartbeatTtlMs(
                request.heartbeatTtlMs ??
                    DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS,
            ),
            ...actorInput(request),
        },
    };
}

function toJoinCommand(
    operation: 'joinGroup' | 'acceptGroupInvite',
    scope: StateScope,
    groupId: string,
    request: JoinGroupRequest | AcceptGroupInviteRequest,
    randomId: () => string,
): GroupMutationCommand {
    if (!request.actorPrincipalId) {
        throw new NonRetryableException('Forbidden: Cannot join a group without a principal.');
    }
    return {
        operation,
        aggregateRef: { ...scope, groupId },
        targetPrincipalId: request.actorPrincipalId,
        ...identity(request.requestId, randomId),
        input: {
            inviteToken: 'inviteToken' in request ? request.inviteToken ?? null : null,
            joinCode: 'joinCode' in request && request.joinCode
                ? normalizeJoinCode(request.joinCode)
                : null,
            ...actorInput(request),
        },
    };
}

function toInviteCommand(
    scope: StateScope,
    groupId: string,
    principalId: string,
    request: CreateGroupInviteRequest,
    randomId: () => string,
): GroupMutationCommand {
    return {
        operation: 'createGroupInvite',
        aggregateRef: { ...scope, groupId },
        targetPrincipalId: principalId,
        ...identity(request.requestId, randomId),
        input: {
            invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ?? null,
            ...actorInput(request),
        },
    };
}

function toTargetCommand(
    operation: 'revokeGroupInvite' | 'removeGroupMember' |
        'banGroupMember' | 'unbanGroupMember',
    scope: StateScope,
    groupId: string,
    principalId: string,
    request: RevokeGroupInviteRequest | RemoveGroupMemberRequest |
        BanGroupMemberRequest | UnbanGroupMemberRequest,
    randomId: () => string,
): GroupMutationCommand {
    return {
        operation,
        aggregateRef: { ...scope, groupId },
        targetPrincipalId: principalId,
        ...identity(request.requestId, randomId),
        input: actorInput(request),
    };
}

function toRoleCommand(
    scope: StateScope,
    groupId: string,
    principalId: string,
    request: SetGroupMemberRoleRequest,
    randomId: () => string,
): GroupMutationCommand {
    return {
        operation: 'setGroupMemberRole',
        aggregateRef: { ...scope, groupId },
        targetPrincipalId: principalId,
        ...identity(request.requestId, randomId),
        input: { role: request.role, ...actorInput(request) },
    };
}

function toTransferCommand(
    scope: StateScope,
    groupId: string,
    request: TransferGroupOwnershipRequest,
    randomId: () => string,
): GroupMutationCommand {
    return {
        operation: 'transferGroupOwnership',
        aggregateRef: { ...scope, groupId },
        targetPrincipalId: request.newOwnerPrincipalId,
        ...identity(request.requestId, randomId),
        input: actorInput(request),
    };
}

function toUpsertMemberCommand(
    scope: StateScope,
    groupId: string,
    principalId: string,
    request: UpsertGroupMemberRequest,
    randomId: () => string,
): GroupMutationCommand {
    return {
        operation: 'upsertMember',
        aggregateRef: { ...scope, groupId },
        targetPrincipalId: principalId,
        ...identity(request.requestId, randomId),
        input: {
            role: request.role ?? null,
            status: request.status,
            invitedByPrincipalId: request.invitedByPrincipalId ?? null,
            invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ?? null,
            ...actorInput(request),
        },
    };
}

function toRotateCommand(
    scope: StateScope,
    groupId: string,
    request: RotateGroupJoinCodeRequest,
    randomId: () => string,
): GroupMutationCommand {
    return {
        operation: 'rotateGroupJoinCode',
        aggregateRef: { ...scope, groupId },
        ...identity(request.requestId, randomId),
        input: {
            joinCode: request.joinCode === undefined
                ? null
                : normalizeJoinCode(request.joinCode),
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...actorInput(request),
        },
    };
}

function toConnectPresenceCommand(
    scope: StateScope,
    groupId: string,
    sessionId: string,
    request: ConnectGroupPresenceSessionRequest,
    randomId: () => string,
): GroupMutationCommand {
    requireGenerationId(request.generationId);
    return {
        operation: 'connectPresence',
        aggregateRef: { ...scope, groupId },
        sessionId,
        ...identity(request.requestId, randomId),
        input: {
            principalId: request.principalId,
            generationId: request.generationId,
            connectedAtEpochMs: request.connectedAtEpochMs ?? null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...actorInput(request),
            actorPrincipalId: request.actorPrincipalId ?? request.principalId,
        },
    };
}

function toHeartbeatPresenceCommand(
    scope: StateScope,
    groupId: string,
    sessionId: string,
    request: HeartbeatGroupPresenceSessionRequest,
    randomId: () => string,
): GroupMutationCommand {
    requireGenerationId(request.generationId);
    return {
        operation: 'heartbeatPresence',
        aggregateRef: { ...scope, groupId },
        sessionId,
        ...identity(request.requestId, randomId),
        input: {
            principalId: request.principalId ?? null,
            generationId: request.generationId,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...actorInput(request),
        },
    };
}

function toDisconnectPresenceCommand(
    scope: StateScope,
    groupId: string,
    sessionId: string,
    request: DisconnectGroupPresenceSessionRequest,
    randomId: () => string,
): GroupMutationCommand {
    requireGenerationId(request.generationId);
    return {
        operation: 'disconnectPresence',
        aggregateRef: { ...scope, groupId },
        sessionId,
        ...identity(request.requestId, randomId),
        input: {
            principalId: request.principalId ?? null,
            generationId: request.generationId,
            generationVersion: null,
            observedExpiresAtEpochMs: null,
            disconnectedAtEpochMs: request.disconnectedAtEpochMs ?? null,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
            expiresAtEpochMs: request.expiresAtEpochMs ?? null,
            ...actorInput(request),
        },
    };
}

export function toExpiryCommand(
    session: GroupPresenceSession,
    atEpochMs: number,
): GroupMutationCommand {
    const semanticCommand = {
        operation: 'disconnectPresence',
        aggregateRef: {
            applicationId: session.applicationId,
            workspaceId: session.workspaceId,
            groupId: session.groupId,
        },
        sessionId: session.sessionId,
        input: {
            principalId: session.principalId,
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            observedExpiresAtEpochMs: session.expiresAtEpochMs,
            disconnectedAtEpochMs: atEpochMs,
            lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs,
            expiresAtEpochMs: session.expiresAtEpochMs,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: 'expired',
            traceId: null,
        },
    } as const;
    const commandId = groupStateMaintenanceRequestId('expiry', semanticCommand);
    return { ...semanticCommand, commandId, requestId: commandId };
}

export function toSessionCleanupCommand(
    session: GroupPresenceSession,
    disconnectedAtEpochMs: number,
): GroupMutationCommand {
    const semanticCommand = {
        operation: 'disconnectPresence',
        aggregateRef: {
            applicationId: session.applicationId,
            workspaceId: session.workspaceId,
            groupId: session.groupId,
        },
        sessionId: session.sessionId,
        input: {
            principalId: session.principalId,
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            observedExpiresAtEpochMs: session.expiresAtEpochMs,
            disconnectedAtEpochMs,
            lastHeartbeatAtEpochMs: null,
            expiresAtEpochMs: null,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
        },
    } as const;
    const commandId = groupStateMaintenanceRequestId(
        'session-cleanup',
        semanticCommand,
    );
    return { ...semanticCommand, commandId, requestId: commandId };
}

export type GroupMaintenanceSemanticCommand = Pick<
    Extract<GroupMutationCommand, { operation: 'disconnectPresence' }>,
    'operation' | 'aggregateRef' | 'sessionId' | 'input'
>;

export function groupStateMaintenanceRequestId(
    authority: 'expiry' | 'session-cleanup',
    semanticCommand: GroupMaintenanceSemanticCommand,
): string {
    const domain = authority === 'expiry'
        ? 'expire-group-presence'
        : 'cleanup-group-presence-session';
    return `${domain}:v1:${canonicalJson(semanticCommand)}`;
}

function identity(requestId: string | undefined, randomId: () => string) {
    const commandId = requestId ?? randomId();
    return { commandId, requestId: requestId ?? null };
}

function actorInput(request: Readonly<{
    actorPrincipalId?: string;
    actorSessionId?: string;
    reason?: string;
    traceId?: string;
}>) {
    return {
        actorPrincipalId: request.actorPrincipalId ?? null,
        actorSessionId: request.actorSessionId ?? null,
        reason: request.reason ?? null,
        traceId: request.traceId ?? null,
    };
}

function requireGenerationId(value: string): void {
    if (typeof value !== 'string' || value.length === 0) {
        throw new NonRetryableException('Group presence generation id is required');
    }
}

function normalizeJoinCode(value: string): string {
    const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, '').slice(0, 12);
    if (normalized.length < 4) {
        throw new NonRetryableException('Group join code must contain at least four characters');
    }
    return normalized;
}

function resolveCommandJoinCode(
    command: GroupMutationCommand,
    commandHash: string,
): string | null {
    return command.operation === 'rotateGroupJoinCode'
        ? command.input.joinCode ?? commandHash.slice('sha256:'.length, 19).toUpperCase()
        : command.operation === 'joinGroup' || command.operation === 'acceptGroupInvite'
        ? command.input.joinCode
        : null;
}

async function joinCodeVerifier(joinCode: string | null): Promise<string | null> {
    if (!joinCode) return null;
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(joinCode.trim().toUpperCase()),
    );
    return Array.from(new Uint8Array(digest))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

function withGroupStateServiceTiming(
    service: GroupStateService,
    timing: RallarTimingSink | undefined,
    serviceId: string,
): GroupStateService {
    if (!timing) return service;
    const timed = <T>(
        operation: string,
        details: Record<string, unknown>,
        action: () => Promise<T>,
    ) => timeRallarAsync(timing, {
        component: 'group-state-service',
        operation,
        serviceId,
        requestId: typeof details.requestId === 'string' ? details.requestId : undefined,
        applicationId: typeof details.applicationId === 'string'
            ? details.applicationId
            : undefined,
        workspaceId: typeof details.workspaceId === 'string'
            ? details.workspaceId
            : undefined,
        groupId: typeof details.groupId === 'string' ? details.groupId : undefined,
                    principalId: typeof details.principalId === 'string'
            ? details.principalId
            : typeof details.actorPrincipalId === 'string'
            ? details.actorPrincipalId
            : typeof details.createdByPrincipalId === 'string'
            ? details.createdByPrincipalId
            : undefined,
        sessionId: typeof details.sessionId === 'string' ? details.sessionId : undefined,
    }, action);
    return new Proxy(service, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            if (property === 'compute' || property === 'validate') return value.bind(target);
            return (...args: unknown[]) => {
                const first = args[0];
                const phaseCommand = first && typeof first === 'object' &&
                        'command' in first && first.command &&
                        typeof first.command === 'object'
                    ? first.command as GroupMutationCommand
                    : undefined;
                const scope = phaseCommand?.aggregateRef ??
                    (first && typeof first === 'object' ? first as StateScope : undefined);
                const request = args.findLast((candidate) =>
                    Boolean(
                        candidate &&
                        typeof candidate === 'object' &&
                        'requestId' in candidate,
                    )
                );
                const requestRecord = request && typeof request === 'object'
                    ? request as Record<string, unknown>
                    : {};
                return timed(String(property), {
                    ...(scope ?? {}),
                    requestId: phaseCommand?.requestId ?? undefined,
                    groupId: phaseCommand?.aggregateRef.groupId ??
                        (typeof args[1] === 'string'
                        ? args[1]
                        : requestRecord.groupId),
                    sessionId: typeof args[2] === 'string' ? args[2] : undefined,
                    ...requestRecord,
                }, () => value.apply(target, args));
            };
        },
    });
}
