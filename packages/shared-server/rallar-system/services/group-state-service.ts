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
    readRallarGroupDirectorAppointment,
} from '@shared/api/group-director.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    requireConditionalWrite,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import {
    createStateMutationOutboxRecord,
    hashStateMutationCommand,
    StateMutationOutboxRepository,
} from '../repositories/StateMutationOutboxRepository.ts';
import type { GroupStateEventStore } from '../repositories/StateEventStore.ts';
import type {
    AuthSessionRepository,
    IssuedAuthSession,
} from '../repositories/AuthSessionRepository.ts';
import type { StateSyncPublisher } from '../state-sync-publisher.ts';
import {
    computeGroupMutation,
    type GroupMutationCommand,
    type GroupMutationComputed,
    type GroupMutationFacts,
    type GroupMutationReceipt,
    type GroupMutationRead,
    probeGroupMutationIdempotency,
    validateGroupMutation,
    validateGroupMutationCommand,
} from './group-state-mutations.ts';
import {
    recordRallarTiming,
    type RallarTimingSink,
    timeRallarAsync,
} from './timing.ts';

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
    authorityProof: GroupMutationAuthorityProof;
    causalToken: string;
    queueResourceId: string;
}>;

export type GroupStateService = Readonly<{
    prepareMutation(
        descriptor: GroupMutationDescriptor,
        authority: IssuedAuthSession,
    ): Promise<GroupMutationPreparation>;
    listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]>;
    listSnapshotsPage(
        scope: GroupScope,
        options: GroupSnapshotPageOptions,
    ): Promise<GroupSnapshotPage>;
    readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    readStateRevision(ref: GroupRef): Promise<number | undefined>;
    readCausalRevision(ref: GroupRef): Promise<GroupStateCausalRevision | undefined>;
    listEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
    listRecentEvents?(
        ref: GroupRef,
        query: StateEventListQuery,
    ): Promise<readonly GroupEvent[]>;
    listEventPage(
        ref: GroupRef,
        query: StateEventListQuery,
    ): Promise<StateEventPage<GroupEvent>>;
    createGroup(
        scope: StateScope,
        request: CreateGroupRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    updateGroup(
        scope: StateScope,
        groupId: string,
        request: UpdateGroupRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    appointDirector(
        scope: StateScope,
        groupId: string,
        request: AppointGroupDirectorRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    joinGroup(
        scope: StateScope,
        groupId: string,
        request: JoinGroupRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    createGroupInvite(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: CreateGroupInviteRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    revokeGroupInvite(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: RevokeGroupInviteRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    acceptGroupInvite(
        scope: StateScope,
        groupId: string,
        request: AcceptGroupInviteRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    rotateGroupJoinCode(
        scope: StateScope,
        groupId: string,
        request: RotateGroupJoinCodeRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupJoinCodeWritten>;
    removeGroupMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: RemoveGroupMemberRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    banGroupMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: BanGroupMemberRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    unbanGroupMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: UnbanGroupMemberRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    setGroupMemberRole(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: SetGroupMemberRoleRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    transferGroupOwnership(
        scope: StateScope,
        groupId: string,
        request: TransferGroupOwnershipRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    upsertMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: UpsertGroupMemberRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    connectPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: ConnectGroupPresenceSessionRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    connectPresenceSessionReceipt(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: ConnectGroupPresenceSessionRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupMutationReceipt>;
    heartbeatPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: HeartbeatGroupPresenceSessionRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    heartbeatPresenceSessionReceipt(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: HeartbeatGroupPresenceSessionRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupMutationReceipt>;
    disconnectPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: DisconnectGroupPresenceSessionRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten>;
    disconnectPresenceSessionReceipt(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: DisconnectGroupPresenceSessionRequest,
        authority: GroupMutationAuthority,
    ): Promise<GroupMutationReceipt>;
}>;

export type GroupStateMaintenanceService = Readonly<{
    disconnectPresenceSessionsBySessionId(
        sessionId: string,
        disconnectedAtEpochMs: number,
    ): Promise<readonly GroupSnapshot[]>;
    disconnectPresenceSessionsBySessionIdWritten(
        sessionId: string,
        disconnectedAtEpochMs: number,
    ): Promise<readonly GroupStateWritten[]>;
    expireExpiredPresenceSessions(
        atEpochMs: number,
    ): Promise<readonly GroupStateWritten[]>;
}>;

export type GroupStateRuntime = Readonly<{
    service: GroupStateService;
    maintenance: GroupStateMaintenanceService;
}>;

export type GroupStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    createGroupStateEventStore?: (
        runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => GroupStateEventStore;
    /**
     * @deprecated Ignored source-compatibility input. New composition must not wire
     * a publisher here; the durable state-mutation outbox is the sole owner.
     */
    syncPublisher?: StateSyncPublisher;
    now?: () => number;
    randomId?: () => string;
    sleep?: (delayMs: number) => Promise<void>;
    serviceId: string;
    /** Wake the durable mutation drainer after a transaction commits. */
    wakeStateMutationOutbox?: () => void;
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

type GroupMutationExecution = Readonly<{
    receipt: GroupMutationReceipt;
    source: 'write' | 'replay' | 'no-op' | 'rejected';
    event: GroupEvent | null;
}>;

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

    const executeReceipt = async (
        command: GroupMutationCommand,
        mutationAtEpochMs: number | undefined = undefined,
        internalAuthority: GroupMutationFacts['internalAuthority'] = 'none',
        authenticatedAuthority: GroupMutationFacts['authenticatedAuthority'] = null,
        reverifyAuthority?: () => Promise<void>,
    ): Promise<GroupMutationExecution> => {
        validateGroupMutationCommand(command);
        const commandHash = await hashStateMutationCommand(command);
        let stableFacts: Omit<GroupMutationFacts, 'attemptCount'> | undefined;
        let lastConflict: RuntimeStateWriteConflictError | undefined;
        for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
            const backoffMs = await waitForRuntimeStateWriteRetry(
                attempt as 0 | 1 | 2,
                { sleep: dependencies.sleep },
            );
            await reverifyAuthority?.();
            let activePhase: 'read' | 'compute' | 'validate' | 'write' = 'read';
            let phaseStarted = performance.now();
            let phaseRecorded = false;
            let transactionStarted: number | undefined;
            try {
                const read = await readGroupMutation(repositoryFor(runtime), command);
                recordMutationPhase(
                    dependencies,
                    command,
                    'read',
                    'ok',
                    phaseStarted,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;

                activePhase = 'compute';
                phaseStarted = performance.now();
                phaseRecorded = false;
                let resolvedFromIdempotency = false;
                let computed: GroupMutationComputed;
                const idempotency = probeGroupMutationIdempotency(
                    command,
                    read,
                    commandHash,
                );
                if (idempotency.outcome !== 'miss') {
                    resolvedFromIdempotency = true;
                    computed = idempotency;
                } else {
                    if (!stableFacts) {
                        const resolvedJoinCode = resolveCommandJoinCode(command, randomId);
                        stableFacts = {
                            nowEpochMs: mutationAtEpochMs ?? now(),
                            serviceId: dependencies.serviceId,
                            eventId: randomId(),
                            commandHash,
                            resolvedJoinCode,
                            joinCodeVerifier: await joinCodeVerifier(resolvedJoinCode),
                            internalAuthority,
                            authenticatedAuthority,
                        };
                    }
                    const facts: GroupMutationFacts = {
                        ...stableFacts,
                        attemptCount: attempt + 1,
                    };
                    computed = computeGroupMutation({ command, read, facts });
                }
                recordMutationPhase(
                    dependencies,
                    command,
                    'compute',
                    'ok',
                    phaseStarted,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;

                activePhase = 'validate';
                phaseStarted = performance.now();
                phaseRecorded = false;
                if (resolvedFromIdempotency) {
                    const canonical = probeGroupMutationIdempotency(
                        command,
                        read,
                        commandHash,
                    );
                    if (canonicalJson(canonical) !== canonicalJson(computed)) {
                        throw new TypeError(
                            'Group mutation idempotency probe is not canonical',
                        );
                    }
                } else {
                    if (!stableFacts) {
                        throw new TypeError('Group mutation facts were not materialized');
                    }
                    const facts: GroupMutationFacts = {
                        ...stableFacts,
                        attemptCount: attempt + 1,
                    };
                    validateGroupMutation({ command, read, facts, computed });
                }
                recordMutationPhase(
                    dependencies,
                    command,
                    'validate',
                    'ok',
                    phaseStarted,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;

                if (computed.outcome === 'idempotency-conflict') {
                    throw new GroupMutationIdempotencyConflictError(
                        command.commandId,
                        computed.existingCommandHash,
                        computed.receivedCommandHash,
                    );
                }
                if (computed.outcome !== 'write') {
                    return {
                        receipt: computed.receipt,
                        source: computed.outcome,
                        event: await readGroupReceiptEvent(
                            repositoryFor(runtime),
                            command.aggregateRef,
                            computed.receipt.eventId,
                        ),
                    };
                }

                activePhase = 'write';
                phaseStarted = performance.now();
                phaseRecorded = false;
                transactionStarted = performance.now();
                const written = await writeGroupMutation(runtime, repositoryFor, computed);
                recordMutationPhase(
                    dependencies,
                    command,
                    'transaction',
                    'ok',
                    transactionStarted,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;
                recordMutationPhase(
                    dependencies,
                    command,
                    'write',
                    'ok',
                    phaseStarted,
                    attempt,
                    backoffMs,
                );
                dependencies.wakeStateMutationOutbox?.();
                return { receipt: written, source: 'write', event: computed.event };
            } catch (error) {
                if (activePhase === 'write' && transactionStarted !== undefined) {
                    recordMutationPhase(
                        dependencies,
                        command,
                        'transaction',
                        'error',
                        transactionStarted,
                        attempt,
                        backoffMs,
                        error,
                    );
                }
                if (!phaseRecorded) {
                    recordMutationPhase(
                        dependencies,
                        command,
                        activePhase,
                        'error',
                        phaseStarted,
                        attempt,
                        backoffMs,
                        error,
                    );
                }
                if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
                lastConflict = error;
                recordMutationConflict(dependencies, command, attempt, backoffMs);
            }
        }
        throw new RuntimeStateRetryExhaustedError(
            lastConflict ?? new RuntimeStateWriteConflictError(),
        );
    };

    const executeCompatible = async (
        command: GroupMutationCommand,
        internalAuthority: GroupMutationFacts['internalAuthority'] = 'none',
        authenticatedAuthority: GroupMutationFacts['authenticatedAuthority'] = null,
        reverifyAuthority?: () => Promise<void>,
        mutationAtEpochMs?: number,
    ): Promise<GroupStateWritten> => {
        const execution = await executeReceipt(
            command,
            mutationAtEpochMs,
            internalAuthority,
            authenticatedAuthority,
            reverifyAuthority,
        );
        if (execution.receipt.outcome === 'rejected') {
            return {
                status: 'error',
                result: Either.ofLeft(execution.receipt.rejection ?? 'Group mutation rejected'),
            };
        }
        const snapshot = await repositoryFor(runtime).readSnapshot(command.aggregateRef);
        if (!snapshot) {
            throw new NonRetryableException(
                `Group snapshot not found: ${command.aggregateRef.groupId}`,
            );
        }
        return {
            status: command.operation === 'createGroup' ? 'created' : 'ok',
            result: Either.ofRight({
                snapshot,
                event: execution.event,
            }),
        };
    };

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
            const read = await readGroupMutation(repositoryFor(runtime), command);
            const authorityProof = await createGroupMutationAuthorityProof(
                verified.session,
                verified.descriptor,
            );
            const causalToken = await sha256CanonicalJson(
                toGroupMutationCausalSurface(read),
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
            return { authorityProof, causalToken, queueResourceId };
        };

    const executeAuthenticatedReceipt = async (
        descriptor: GroupMutationDescriptor,
        authority: GroupMutationAuthority,
    ): Promise<Readonly<{
        command: GroupMutationCommand;
        execution: GroupMutationExecution;
    }>> => {
        if (!authority) {
            throw new GroupMutationAuthorizationError(
                'Authenticated mutation authority is required.',
            );
        }
        const verified = await verifyGroupMutationAuthority(
            dependencies.authSessionRepository,
            descriptor,
            authority,
            now(),
        );
        const command = toDescriptorCommand(verified.descriptor, randomId);
        const reverify = async () => {
            const current = await verifyGroupMutationAuthority(
                dependencies.authSessionRepository,
                descriptor,
                authority,
                now(),
            );
            if (canonicalJson(current.descriptor) !== canonicalJson(verified.descriptor)) {
                throw new GroupMutationAuthorizationError(
                    'Authenticated mutation authority changed during retry.',
                );
            }
        };
        return {
            command,
            execution: await executeReceipt(
                command,
                undefined,
                'none',
                {
                    principalId: verified.session.clientId,
                    sessionId: verified.session.sessionId,
                },
                reverify,
            ),
        };
    };

    const executeAuthenticatedCompatible = async (
        descriptor: GroupMutationDescriptor,
        authority: GroupMutationAuthority,
    ): Promise<GroupStateWritten> => {
        if (!authority) {
            throw new GroupMutationAuthorizationError(
                'Authenticated mutation authority is required.',
            );
        }
        const verified = await verifyGroupMutationAuthority(
            dependencies.authSessionRepository,
            descriptor,
            authority,
            now(),
        );
        const command = toDescriptorCommand(verified.descriptor, randomId);
        const reverify = async () => {
            const current = await verifyGroupMutationAuthority(
                dependencies.authSessionRepository,
                descriptor,
                authority,
                now(),
            );
            if (canonicalJson(current.descriptor) !== canonicalJson(verified.descriptor)) {
                throw new GroupMutationAuthorizationError(
                    'Authenticated mutation authority changed during retry.',
                );
            }
        };
        return await executeCompatible(
            command,
            'none',
            {
                principalId: verified.session.clientId,
                sessionId: verified.session.sessionId,
            },
            reverify,
        );
    };

    const service: GroupStateService = {
        prepareMutation,
        listSnapshots: async (scope) => await repositoryFor(runtime).listSnapshots(scope),
        listSnapshotsPage: async (scope, options) =>
            await repositoryFor(runtime).listSnapshotsPage(scope, options),
        readSnapshot: async (ref) => await repositoryFor(runtime).readSnapshot(ref),
        readStateRevision: async (ref) => await repositoryFor(runtime).readStateRevision(ref),
        readCausalRevision: async (ref) => await repositoryFor(runtime).readCausalRevision(ref),
        listEvents: async (ref) => await repositoryFor(runtime).listEvents(ref),
        listRecentEvents: async (ref, query) =>
            await repositoryFor(runtime).listRecentEvents(ref, query),
        listEventPage: async (ref, query) =>
            await repositoryFor(runtime).listEventPage(ref, query),
        createGroup: async (scope, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('createGroup', scope, request.groupId, request),
                authority,
            ),
        updateGroup: async (scope, groupId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('updateGroup', scope, groupId, request),
                authority,
            ),
        appointDirector: async (scope, groupId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('appointDirector', scope, groupId, request),
                authority,
            ),
        joinGroup: async (scope, groupId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('joinGroup', scope, groupId, request),
                authority,
            ),
        createGroupInvite: async (scope, groupId, principalId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor(
                    'createGroupInvite', scope, groupId, request, principalId,
                ),
                authority,
            ),
        revokeGroupInvite: async (scope, groupId, principalId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor(
                    'revokeGroupInvite', scope, groupId, request, principalId,
                ),
                authority,
            ),
        acceptGroupInvite: async (scope, groupId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('acceptGroupInvite', scope, groupId, request),
                authority,
            ),
        rotateGroupJoinCode: async (scope, groupId, request, authority) => {
            const { command, execution } = await executeAuthenticatedReceipt(
                mutationDescriptor('rotateGroupJoinCode', scope, groupId, request),
                authority,
            );
            if (execution.receipt.outcome === 'rejected') {
                return {
                    status: 'error',
                    result: Either.ofLeft(
                        execution.receipt.rejection ?? 'Join-code rotation rejected',
                    ),
                };
            }
            const snapshot = await repositoryFor(runtime).readSnapshot(command.aggregateRef);
            if (!snapshot || execution.receipt.joinCode === null ||
                execution.receipt.joinCodeExpiresAtEpochMs === null) {
                throw new NonRetryableException('Join-code mutation result is incomplete');
            }
            return {
                status: 'ok',
                result: Either.ofRight({
                    joinCode: execution.receipt.joinCode,
                    expiresAtEpochMs: execution.receipt.joinCodeExpiresAtEpochMs,
                    snapshot,
                    event: execution.event,
                }),
            };
        },
        removeGroupMember: async (scope, groupId, principalId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('removeGroupMember', scope, groupId, request, principalId),
                authority,
            ),
        banGroupMember: async (scope, groupId, principalId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('banGroupMember', scope, groupId, request, principalId),
                authority,
            ),
        unbanGroupMember: async (scope, groupId, principalId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('unbanGroupMember', scope, groupId, request, principalId),
                authority,
            ),
        setGroupMemberRole: async (scope, groupId, principalId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('setGroupMemberRole', scope, groupId, request, principalId),
                authority,
            ),
        transferGroupOwnership: async (scope, groupId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor(
                    'transferGroupOwnership', scope, groupId, request,
                    request.newOwnerPrincipalId,
                ),
                authority,
            ),
        upsertMember: async (scope, groupId, principalId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor('upsertMember', scope, groupId, request, principalId),
                authority,
            ),
        connectPresenceSession: async (scope, groupId, sessionId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor(
                    'connectPresence', scope, groupId, request, request.principalId, sessionId,
                ),
                authority,
            ),
        connectPresenceSessionReceipt: async (
            scope, groupId, sessionId, request, authority,
        ) => (await executeAuthenticatedReceipt(
            mutationDescriptor(
                'connectPresence', scope, groupId, request, request.principalId, sessionId,
            ),
            authority,
        )).execution.receipt,
        heartbeatPresenceSession: async (scope, groupId, sessionId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor(
                    'heartbeatPresence', scope, groupId, request,
                    request.principalId ?? null, sessionId,
                ),
                authority,
            ),
        heartbeatPresenceSessionReceipt: async (
            scope, groupId, sessionId, request, authority,
        ) => (await executeAuthenticatedReceipt(
            mutationDescriptor(
                'heartbeatPresence', scope, groupId, request,
                request.principalId ?? null, sessionId,
            ),
            authority,
        )).execution.receipt,
        disconnectPresenceSession: async (scope, groupId, sessionId, request, authority) =>
            await executeAuthenticatedCompatible(
                mutationDescriptor(
                    'disconnectPresence', scope, groupId, request,
                    request.principalId ?? null, sessionId,
                ),
                authority,
            ),
        disconnectPresenceSessionReceipt: async (
            scope, groupId, sessionId, request, authority,
        ) => (await executeAuthenticatedReceipt(
            mutationDescriptor(
                'disconnectPresence', scope, groupId, request,
                request.principalId ?? null, sessionId,
            ),
            authority,
        )).execution.receipt,
    };

    const maintenance: GroupStateMaintenanceService = {
        disconnectPresenceSessionsBySessionId: async (
            sessionId,
            disconnectedAtEpochMs,
        ) => {
            const written = await maintenance.disconnectPresenceSessionsBySessionIdWritten(
                sessionId,
                disconnectedAtEpochMs,
            );
            return written.flatMap((result) =>
                result.result.right ? [result.result.right.snapshot] : []
            );
        },
        disconnectPresenceSessionsBySessionIdWritten: async (
            sessionId,
            disconnectedAtEpochMs,
        ) => {
            const sessions = (await repositoryFor(runtime).listAllPresenceSessions())
                .filter((session) =>
                    session.sessionId === sessionId &&
                    session.disconnectedAtEpochMs === null
                );
            const written: GroupStateWritten[] = [];
            for (const session of sessions) {
                written.push(await executeCompatible(
                    toSessionCleanupCommand(session, disconnectedAtEpochMs),
                    'session-cleanup',
                    null,
                    undefined,
                    disconnectedAtEpochMs,
                ));
            }
            return written;
        },
        expireExpiredPresenceSessions: async (atEpochMs) => {
            const candidates = (await repositoryFor(runtime).listAllPresenceSessions())
                .filter((session) =>
                    session.disconnectedAtEpochMs === null &&
                    session.expiresAtEpochMs <= atEpochMs
                );
            const written: GroupStateWritten[] = [];
            for (const session of candidates) {
                const command = toExpiryCommand(session, atEpochMs);
                const execution = await executeReceipt(command, atEpochMs, 'expiry');
                if (execution.source !== 'write') continue;
                const snapshot = await repositoryFor(runtime).readSnapshot(
                    command.aggregateRef,
                );
                if (!snapshot) continue;
                written.push({
                    status: 'ok',
                    result: Either.ofRight({
                        snapshot,
                        event: execution.event,
                    }),
                });
            }
            return written;
        },
    };

    return {
        service: withGroupStateServiceTiming(
            service,
            dependencies.timing,
            dependencies.serviceId,
        ),
        maintenance,
    };
}

async function readGroupReceiptEvent(
    repository: GroupStateRepository,
    ref: GroupRef,
    eventId: string | null,
): Promise<GroupEvent | null> {
    if (eventId === null) return null;
    const event = (await repository.listEvents(ref))
        .find((candidate) => candidate.eventId === eventId);
    if (!event) {
        throw new NonRetryableException(
            `Group mutation receipt event not found: ${eventId}`,
        );
    }
    return event;
}

export function createGroupStateService(
    dependencies: GroupStateServiceDependencies,
): GroupStateService {
    return createGroupStateRuntime(dependencies).service;
}

type VerifiedGroupMutationAuthority = Readonly<{
    session: IssuedAuthSession;
    descriptor: GroupMutationDescriptor;
}>;

function mutationDescriptor(
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
        if (!await constantTimeSecretEqual(session.accessToken, authority.accessToken)) {
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
    session: IssuedAuthSession,
    descriptor: GroupMutationDescriptor,
): Promise<GroupMutationAuthorityProof> {
    return {
        version: 1,
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        commandMac: await hmacSha256Hex(
            session.accessToken,
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

function toDescriptorCommand(
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

function toGroupMutationCausalSurface(read: GroupMutationRead): unknown {
    const revision = (value: RuntimeStateEntryValue<unknown> | null) =>
        value?.entry.revision ?? null;
    return {
        idempotency: revision(read.idempotency),
        group: revision(read.group),
        actorMember: revision(read.actorMemberEntry),
        targetMember: revision(read.targetMemberEntry),
        authorityMember: revision(read.authorityMemberEntry),
        directorMember: revision(read.directorMemberEntry),
        targetPresence: revision(read.targetPresence),
        targetAdmission: revision(read.targetAdmission),
        authorityAdmission: revision(read.authorityAdmission),
        directorAdmission: revision(read.directorAdmission),
        authorityPresenceSessions: read.authorityPresenceSessionEntries
            .map(({ entry, value }) => ({
                sessionId: value.sessionId,
                revision: entry.revision,
            }))
            .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId)),
        presenceSummary: revision(read.presenceSummary),
    };
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
    return bytesToHex(new Uint8Array(signature));
}

async function sha256CanonicalJson(value: unknown): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalJson(value)),
    );
    return bytesToHex(new Uint8Array(digest));
}

async function constantTimeSecretEqual(left: string, right: string): Promise<boolean> {
    const [leftDigest, rightDigest] = await Promise.all([
        sha256CanonicalJson(left),
        sha256CanonicalJson(right),
    ]);
    return constantTimeHexEqual(leftDigest, rightDigest);
}

function constantTimeHexEqual(left: string, right: string): boolean {
    const length = Math.max(left.length, right.length);
    let difference = left.length ^ right.length;
    for (let index = 0; index < length; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Canonical JSON number must be finite');
        }
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (!value || typeof value !== 'object') {
        throw new TypeError('Canonical JSON value is unsupported');
    }
    return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(',')}}`;
}

async function readGroupMutation(
    repository: GroupStateRepository,
    command: GroupMutationCommand,
): Promise<GroupMutationRead> {
    const presenceSessionId = 'sessionId' in command
        ? command.sessionId
        : command.operation === 'appointDirector'
        ? command.input.actorSessionId
        : null;
    const [idempotency, group, targetPresence, presenceSummary] = await Promise.all([
        command.requestId === null
            ? Promise.resolve(undefined)
            : repository.findIdempotentGroupMutationReceiptEntry(
                command.aggregateRef,
                command.requestId,
            ),
        repository.findGroupEntry(command.aggregateRef),
        presenceSessionId
            ? repository.findPresenceEntry({
                ...command.aggregateRef,
                sessionId: presenceSessionId,
            })
            : Promise.resolve(undefined),
        repository.findPresenceSummaryEntry(command.aggregateRef),
    ]);
    const actorPrincipalId = command.input.actorPrincipalId;
    const targetPrincipalId = 'targetPrincipalId' in command
        ? command.targetPrincipalId
        : command.operation === 'connectPresence'
        ? command.input.principalId
        : command.operation === 'heartbeatPresence' ||
                command.operation === 'disconnectPresence'
        ? command.input.principalId ?? actorPrincipalId
        : actorPrincipalId;
    const ownerPrincipalId = group?.value.ownerPrincipalId;
    const director = readRallarGroupDirectorAppointment(group?.value.metadata);
    const [actorMemberEntry, targetMemberEntry, targetAdmission, authorityMemberEntry,
        authorityAdmission, directorMemberEntry, directorAdmission] = await Promise.all([
        actorPrincipalId
            ? repository.findMemberEntry({
                ...command.aggregateRef,
                principalId: actorPrincipalId,
            })
            : Promise.resolve(undefined),
        targetPrincipalId && targetPrincipalId !== actorPrincipalId
            ? repository.findMemberEntry({
                ...command.aggregateRef,
                principalId: targetPrincipalId,
            })
            : Promise.resolve(undefined),
        targetPrincipalId
            ? repository.findPresenceAdmissionEntry({
                ...command.aggregateRef,
                principalId: targetPrincipalId,
            })
            : Promise.resolve(undefined),
        command.operation === 'appointDirector' && ownerPrincipalId &&
                ownerPrincipalId !== actorPrincipalId &&
                ownerPrincipalId !== targetPrincipalId
            ? repository.findMemberEntry({
                ...command.aggregateRef,
                principalId: ownerPrincipalId,
            })
            : Promise.resolve(undefined),
        command.operation === 'appointDirector' && ownerPrincipalId
            ? repository.findPresenceAdmissionEntry({
                ...command.aggregateRef,
                principalId: ownerPrincipalId,
            })
            : Promise.resolve(undefined),
        command.operation === 'appointDirector' && director &&
                director.principalId !== actorPrincipalId &&
                director.principalId !== targetPrincipalId &&
                director.principalId !== ownerPrincipalId
            ? repository.findMemberEntry({
                ...command.aggregateRef,
                principalId: director.principalId,
            })
            : Promise.resolve(undefined),
        command.operation === 'appointDirector' && director
            ? repository.findPresenceAdmissionEntry({
                ...command.aggregateRef,
                principalId: director.principalId,
            })
            : Promise.resolve(undefined),
    ]);
    const authorityPresenceSessionEntries = await Promise.all(
        [
            ...(authorityAdmission?.value.admittedSessions ?? []),
            ...(directorAdmission?.value.admittedSessions ?? []),
        ].map((session) =>
            repository.findPresenceEntry({
                ...command.aggregateRef,
                sessionId: session.sessionId,
            })
        ),
    ).then((sessions) => sessions.filter(
        (session): session is NonNullable<typeof session> => session !== undefined,
    ));
    const resolvedTargetMemberEntry = targetPrincipalId === actorPrincipalId
        ? actorMemberEntry
        : targetMemberEntry;
    const resolvedAuthorityMemberEntry = ownerPrincipalId === actorPrincipalId
        ? actorMemberEntry
        : ownerPrincipalId === targetPrincipalId
        ? targetMemberEntry
        : authorityMemberEntry;
    const resolvedDirectorMemberEntry = director?.principalId === actorPrincipalId
        ? actorMemberEntry
        : director?.principalId === targetPrincipalId
        ? targetMemberEntry
        : director?.principalId === ownerPrincipalId
        ? authorityMemberEntry
        : directorMemberEntry;
    return {
        idempotency: idempotency ?? null,
        group: group ?? null,
        actorMember: actorMemberEntry?.value ?? null,
        targetMember: resolvedTargetMemberEntry?.value ?? null,
        authorityMember: resolvedAuthorityMemberEntry?.value ?? null,
        directorMember: resolvedDirectorMemberEntry?.value ?? null,
        actorMemberEntry: actorMemberEntry ?? null,
        targetMemberEntry: resolvedTargetMemberEntry ?? null,
        authorityMemberEntry: resolvedAuthorityMemberEntry ?? null,
        directorMemberEntry: resolvedDirectorMemberEntry ?? null,
        targetPresence: targetPresence ?? null,
        targetAdmission: targetAdmission ?? null,
        authorityAdmission: authorityAdmission ?? null,
        directorAdmission: directorAdmission ?? null,
        authorityPresenceSessions: authorityPresenceSessionEntries.map(({ value }) => value),
        authorityPresenceSessionEntries,
        presenceSummary: presenceSummary ?? null,
    };
}

async function writeGroupMutation(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    repositoryFor: (
        target: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => GroupStateRepository,
    computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): Promise<GroupMutationReceipt> {
    return await runtime.begin(async (transaction) => {
        const repository = repositoryFor(transaction);

        // Aggregate/session ownership is always the first database statement.
        if (computed.guard.kind === 'group') {
            requireConditionalWrite(computed.guard.operation === 'insert'
                ? await repository.insertGroup(computed.guard.value)
                : await repository.updateGroup(
                    computed.guard.value,
                    computed.guard.expectedRevision,
                ));
        } else {
            requireConditionalWrite(computed.guard.operation === 'insert'
                ? await repository.insertPresence(computed.guard.value)
                : computed.guard.operation === 'update'
                ? await repository.updatePresence(
                    computed.guard.value,
                    computed.guard.expectedRevision,
                )
                : await repository.deletePresence(
                    computed.guard.value,
                    computed.guard.expectedRevision,
                ));
        }

        if (computed.presenceAdmission) {
            requireConditionalWrite(computed.presenceAdmission.operation === 'insert'
                ? await repository.insertPresenceAdmission(
                    computed.presenceAdmission.value,
                )
                : await repository.updatePresenceAdmission(
                    computed.presenceAdmission.value,
                    computed.presenceAdmission.expectedRevision,
                ));
        }

        for (const member of computed.members) await repository.putMember(member);
        if (computed.initialPresenceSummary) {
            requireConditionalWrite(
                await repository.insertPresenceSummary(computed.initialPresenceSummary),
            );
        }
        if (computed.idempotency) {
            requireConditionalWrite(
                await repository.insertIdempotentGroupMutationReceipt(
                    computed.outbox.aggregateRef,
                    computed.idempotency.requestId,
                    computed.idempotency,
                ),
            );
        }
        await new StateMutationOutboxRepository(transaction).insertForAuthoritativeWrite(
            createStateMutationOutboxRecord(computed.outbox),
        );
        await repository.appendEvent(computed.event);
        return computed.receipt;
    });
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

function toExpiryCommand(
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

function toSessionCleanupCommand(
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
    randomId: () => string,
): string | null {
    return command.operation === 'rotateGroupJoinCode'
        ? command.input.joinCode ?? normalizeJoinCode(randomId())
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

function recordMutationPhase(
    dependencies: GroupStateServiceDependencies,
    command: GroupMutationCommand,
    phase: 'read' | 'compute' | 'validate' | 'write' | 'transaction',
    status: 'ok' | 'error',
    started: number,
    attempt: number,
    backoffMs: number,
    error?: unknown,
): void {
    recordRallarTiming(dependencies.timing, {
        component: 'group-state-service',
        operation: `mutation.${phase}`,
        serviceId: dependencies.serviceId,
        requestId: command.requestId ?? undefined,
        ...command.aggregateRef,
        details: { attempt, backoffMs, mutationOperation: command.operation },
    }, status, performance.now() - started, error);
}

function recordMutationConflict(
    dependencies: GroupStateServiceDependencies,
    command: GroupMutationCommand,
    attempt: number,
    backoffMs: number,
): void {
    recordRallarTiming(dependencies.timing, {
        component: 'group-state-service',
        operation: 'mutation.conflict',
        serviceId: dependencies.serviceId,
        requestId: command.requestId ?? undefined,
        ...command.aggregateRef,
        details: { attempt, backoffMs, conflict: true, mutationOperation: command.operation },
    }, 'ok', 0);
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
            return (...args: unknown[]) => {
                const first = args[0];
                const scope = first && typeof first === 'object' ? first as StateScope : undefined;
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
                    groupId: typeof args[1] === 'string'
                        ? args[1]
                        : requestRecord.groupId,
                    sessionId: typeof args[2] === 'string' ? args[2] : undefined,
                    ...requestRecord,
                }, () => value.apply(target, args));
            };
        },
    });
}
