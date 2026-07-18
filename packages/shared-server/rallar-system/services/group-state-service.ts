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
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
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
import type { StateSyncPublisher } from '../state-sync-publisher.ts';
import {
    computeGroupMutation,
    type GroupMutationCommand,
    type GroupMutationComputed,
    type GroupMutationFacts,
    type GroupMutationReceipt,
    type GroupMutationRead,
    validateGroupMutation,
    validateGroupMutationCommand,
} from './group-state-mutations.ts';
import {
    recordRallarTiming,
    type RallarTimingSink,
    timeRallarAsync,
} from './timing.ts';

const DEFAULT_GROUP_JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type GroupWritten = Readonly<{
    snapshot: GroupSnapshot;
    event: GroupEvent;
}>;

export type GroupMutationWritten = Readonly<{
    snapshot: GroupSnapshot;
    event?: GroupEvent;
}>;

export type GroupStateWritten = Readonly<{
    status: 'created' | 'ok' | 'error';
    result: Either<string, GroupMutationWritten>;
}>;

export type GroupJoinCodeMutationWritten =
    & GroupJoinCodeResponse
    & Readonly<{ event?: GroupEvent }>;

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

export type DisconnectPresenceBySessionRequest = Omit<
    DisconnectGroupPresenceSessionRequest,
    'generationId'
>;

export type GroupStateService = Readonly<{
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
    createGroup(scope: StateScope, request: CreateGroupRequest): Promise<GroupStateWritten>;
    updateGroup(
        scope: StateScope,
        groupId: string,
        request: UpdateGroupRequest,
    ): Promise<GroupStateWritten>;
    appointDirector(
        scope: StateScope,
        groupId: string,
        request: AppointGroupDirectorRequest,
    ): Promise<GroupStateWritten>;
    joinGroup(
        scope: StateScope,
        groupId: string,
        request: JoinGroupRequest,
    ): Promise<GroupStateWritten>;
    createGroupInvite(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: CreateGroupInviteRequest,
    ): Promise<GroupStateWritten>;
    revokeGroupInvite(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: RevokeGroupInviteRequest,
    ): Promise<GroupStateWritten>;
    acceptGroupInvite(
        scope: StateScope,
        groupId: string,
        request: AcceptGroupInviteRequest,
    ): Promise<GroupStateWritten>;
    rotateGroupJoinCode(
        scope: StateScope,
        groupId: string,
        request: RotateGroupJoinCodeRequest,
    ): Promise<GroupJoinCodeWritten>;
    removeGroupMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: RemoveGroupMemberRequest,
    ): Promise<GroupStateWritten>;
    banGroupMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: BanGroupMemberRequest,
    ): Promise<GroupStateWritten>;
    unbanGroupMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: UnbanGroupMemberRequest,
    ): Promise<GroupStateWritten>;
    setGroupMemberRole(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: SetGroupMemberRoleRequest,
    ): Promise<GroupStateWritten>;
    transferGroupOwnership(
        scope: StateScope,
        groupId: string,
        request: TransferGroupOwnershipRequest,
    ): Promise<GroupStateWritten>;
    upsertMember(
        scope: StateScope,
        groupId: string,
        principalId: string,
        request: UpsertGroupMemberRequest,
    ): Promise<GroupStateWritten>;
    connectPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: ConnectGroupPresenceSessionRequest,
    ): Promise<GroupStateWritten>;
    connectPresenceSessionReceipt(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: ConnectGroupPresenceSessionRequest,
    ): Promise<GroupMutationReceipt>;
    heartbeatPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: HeartbeatGroupPresenceSessionRequest,
    ): Promise<GroupStateWritten>;
    heartbeatPresenceSessionReceipt(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: HeartbeatGroupPresenceSessionRequest,
    ): Promise<GroupMutationReceipt>;
    disconnectPresenceSession(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: DisconnectGroupPresenceSessionRequest,
    ): Promise<GroupStateWritten>;
    disconnectPresenceSessionReceipt(
        scope: StateScope,
        groupId: string,
        sessionId: string,
        request: DisconnectGroupPresenceSessionRequest,
    ): Promise<GroupMutationReceipt>;
    disconnectPresenceSessionsBySessionId(
        sessionId: string,
        request?: DisconnectPresenceBySessionRequest,
    ): Promise<readonly GroupSnapshot[]>;
    disconnectPresenceSessionsBySessionIdWritten(
        sessionId: string,
        request?: DisconnectPresenceBySessionRequest,
    ): Promise<readonly GroupStateWritten[]>;
    expireExpiredPresenceSessions(
        atEpochMs?: number,
    ): Promise<readonly GroupStateWritten[]>;
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
}>;

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
}>;

export function createGroupStateService(
    dependencies: GroupStateServiceDependencies,
): GroupStateService {
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
        mutationAtEpochMs: number = now(),
        internalAuthority: GroupMutationFacts['internalAuthority'] = 'none',
    ): Promise<GroupMutationExecution> => {
        validateGroupMutationCommand(command);
        const facts: GroupMutationFacts = {
            nowEpochMs: mutationAtEpochMs,
            serviceId: dependencies.serviceId,
            eventId: randomId(),
            commandHash: await hashStateMutationCommand(command),
            joinCodeVerifier: await commandJoinCodeVerifier(command),
            internalAuthority,
        };
        let lastConflict: RuntimeStateWriteConflictError | undefined;
        for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
            const backoffMs = await waitForRuntimeStateWriteRetry(
                attempt as 0 | 1 | 2,
                { sleep: dependencies.sleep },
            );
            const read = await timeMutationPhase(
                dependencies,
                command,
                'read',
                attempt,
                backoffMs,
                async () => await readGroupMutation(repositoryFor(runtime), command),
            );
            const computed = await timeMutationPhase(
                dependencies,
                command,
                'compute',
                attempt,
                backoffMs,
                () => computeGroupMutation({ command, read, facts }),
            );
            await timeMutationPhase(
                dependencies,
                command,
                'validate',
                attempt,
                backoffMs,
                () => validateGroupMutation({ command, read, facts, computed }),
            );
            if (computed.outcome === 'idempotency-conflict') {
                throw new GroupMutationIdempotencyConflictError(
                    command.commandId,
                    computed.existingCommandHash,
                    computed.receivedCommandHash,
                );
            }
            if (computed.outcome !== 'write') {
                return { receipt: computed.receipt, source: computed.outcome };
            }
            try {
                const receipt = await timeMutationPhase(
                    dependencies,
                    command,
                    'write',
                    attempt,
                    backoffMs,
                    async () => await timeMutationPhase(
                        dependencies,
                        command,
                        'transaction',
                        attempt,
                        backoffMs,
                        async () => await writeGroupMutation(runtime, repositoryFor, computed),
                    ),
                );
                dependencies.wakeStateMutationOutbox?.();
                return { receipt, source: 'write' };
            } catch (error) {
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
    ): Promise<GroupStateWritten> => {
        const execution = await executeReceipt(command, now(), internalAuthority);
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
                ...(execution.receipt.event.kind === 'group'
                    ? { event: execution.receipt.event.event }
                    : {}),
            }),
        };
    };

    const service: GroupStateService = {
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
        createGroup: async (scope, request) =>
            await executeCompatible(toCreateCommand(scope, request, randomId)),
        updateGroup: async (scope, groupId, request) =>
            await executeCompatible(toUpdateCommand(scope, groupId, request, randomId)),
        appointDirector: async (scope, groupId, request) =>
            await executeCompatible(toDirectorCommand(scope, groupId, request, randomId)),
        joinGroup: async (scope, groupId, request) =>
            await executeCompatible(toJoinCommand('joinGroup', scope, groupId, request, randomId)),
        createGroupInvite: async (scope, groupId, principalId, request) =>
            await executeCompatible(toInviteCommand(scope, groupId, principalId, request, randomId)),
        revokeGroupInvite: async (scope, groupId, principalId, request) =>
            await executeCompatible(toTargetCommand(
                'revokeGroupInvite', scope, groupId, principalId, request, randomId,
            )),
        acceptGroupInvite: async (scope, groupId, request) =>
            await executeCompatible(toJoinCommand(
                'acceptGroupInvite', scope, groupId, request, randomId,
            )),
        rotateGroupJoinCode: async (scope, groupId, request) => {
            const command = toRotateCommand(scope, groupId, request, randomId, now());
            const execution = await executeReceipt(command);
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
                    ...(execution.receipt.event.kind === 'group'
                        ? { event: execution.receipt.event.event }
                        : {}),
                }),
            };
        },
        removeGroupMember: async (scope, groupId, principalId, request) =>
            await executeCompatible(toTargetCommand(
                'removeGroupMember', scope, groupId, principalId, request, randomId,
            )),
        banGroupMember: async (scope, groupId, principalId, request) =>
            await executeCompatible(toTargetCommand(
                'banGroupMember', scope, groupId, principalId, request, randomId,
            )),
        unbanGroupMember: async (scope, groupId, principalId, request) =>
            await executeCompatible(toTargetCommand(
                'unbanGroupMember', scope, groupId, principalId, request, randomId,
            )),
        setGroupMemberRole: async (scope, groupId, principalId, request) =>
            await executeCompatible(toRoleCommand(scope, groupId, principalId, request, randomId)),
        transferGroupOwnership: async (scope, groupId, request) =>
            await executeCompatible(toTransferCommand(scope, groupId, request, randomId)),
        upsertMember: async (scope, groupId, principalId, request) =>
            await executeCompatible(toUpsertMemberCommand(
                scope, groupId, principalId, request, randomId,
            )),
        connectPresenceSession: async (scope, groupId, sessionId, request) =>
            await executeCompatible(toConnectPresenceCommand(
                scope, groupId, sessionId, request, randomId,
            )),
        connectPresenceSessionReceipt: async (scope, groupId, sessionId, request) =>
            (await executeReceipt(toConnectPresenceCommand(
                scope, groupId, sessionId, request, randomId,
            ))).receipt,
        heartbeatPresenceSession: async (scope, groupId, sessionId, request) =>
            await executeCompatible(toHeartbeatPresenceCommand(
                scope, groupId, sessionId, request, randomId,
            )),
        heartbeatPresenceSessionReceipt: async (scope, groupId, sessionId, request) =>
            (await executeReceipt(toHeartbeatPresenceCommand(
                scope, groupId, sessionId, request, randomId,
            ))).receipt,
        disconnectPresenceSession: async (scope, groupId, sessionId, request) =>
            await executeCompatible(toDisconnectPresenceCommand(
                scope, groupId, sessionId, request, randomId,
            )),
        disconnectPresenceSessionReceipt: async (scope, groupId, sessionId, request) =>
            (await executeReceipt(toDisconnectPresenceCommand(
                scope, groupId, sessionId, request, randomId,
            ))).receipt,
        disconnectPresenceSessionsBySessionId: async (sessionId, request = {}) => {
            const written = await service.disconnectPresenceSessionsBySessionIdWritten(
                sessionId,
                request,
            );
            return written.flatMap((result) =>
                result.result.right ? [result.result.right.snapshot] : []
            );
        },
        disconnectPresenceSessionsBySessionIdWritten: async (sessionId, request = {}) => {
            const sessions = (await repositoryFor(runtime).listAllPresenceSessions())
                .filter((session) =>
                    session.sessionId === sessionId &&
                    session.disconnectedAtEpochMs === undefined
                );
            const written: GroupStateWritten[] = [];
            for (const session of sessions) {
                written.push(await executeCompatible(toDisconnectPresenceCommand(
                    {
                        applicationId: session.applicationId,
                        workspaceId: session.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
                    }, session.groupId, session.sessionId, {
                        ...request,
                        generationId: session.generationId,
                        principalId: request.principalId ?? session.principalId,
                        actorPrincipalId:
                            request.actorPrincipalId ?? session.principalId,
                        actorSessionId: request.actorSessionId ?? session.sessionId,
                    }, randomId), 'session-cleanup'));
            }
            return written;
        },
        expireExpiredPresenceSessions: async (atEpochMs = now()) => {
            const candidates = (await repositoryFor(runtime).listAllPresenceSessions())
                .filter((session) =>
                    session.disconnectedAtEpochMs === undefined &&
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
                        ...(execution.receipt.event.kind === 'group'
                            ? { event: execution.receipt.event.event }
                            : {}),
                    }),
                });
            }
            return written;
        },
    };

    return withGroupStateServiceTiming(service, dependencies.timing, dependencies.serviceId);
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
        : targetPresence?.value.principalId ?? actorPrincipalId;
    const ownerPrincipalId = group?.value.ownerPrincipalId;
    const director = readRallarGroupDirectorAppointment(group?.value.metadata);
    const [actorMember, targetMember, targetAdmission, authorityMember,
        authorityAdmission, directorMember, directorAdmission] = await Promise.all([
        actorPrincipalId
            ? repository.findMember({ ...command.aggregateRef, principalId: actorPrincipalId })
            : Promise.resolve(undefined),
        targetPrincipalId && targetPrincipalId !== actorPrincipalId
            ? repository.findMember({ ...command.aggregateRef, principalId: targetPrincipalId })
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
            ? repository.findMember({
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
            ? repository.findMember({
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
    const authorityPresenceSessions = await Promise.all(
        [
            ...(authorityAdmission?.value.admittedSessions ?? []),
            ...(directorAdmission?.value.admittedSessions ?? []),
        ].map((session) =>
            repository.findPresenceSession({
                ...command.aggregateRef,
                sessionId: session.sessionId,
            })
        ),
    ).then((sessions) => sessions.filter(
        (session): session is GroupPresenceSession => session !== undefined,
    ));
    return {
        idempotency: idempotency ?? null,
        group: group ?? null,
        actorMember: actorMember ?? null,
        targetMember: targetPrincipalId === actorPrincipalId
            ? actorMember ?? null
            : targetMember ?? null,
        authorityMember: ownerPrincipalId === actorPrincipalId
            ? actorMember ?? null
            : ownerPrincipalId === targetPrincipalId
            ? targetMember ?? null
            : authorityMember ?? null,
        directorMember: director?.principalId === actorPrincipalId
            ? actorMember ?? null
            : director?.principalId === targetPrincipalId
            ? targetMember ?? null
            : director?.principalId === ownerPrincipalId
            ? authorityMember ?? null
            : directorMember ?? null,
        targetPresence: targetPresence ?? null,
        targetAdmission: targetAdmission ?? null,
        authorityAdmission: authorityAdmission ?? null,
        directorAdmission: directorAdmission ?? null,
        authorityPresenceSessions,
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
                : await repository.updatePresence(
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
        await new StateMutationOutboxRepository(transaction).putOrLoad(
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
    nowEpochMs: number,
): GroupMutationCommand {
    return {
        operation: 'rotateGroupJoinCode',
        aggregateRef: { ...scope, groupId },
        ...identity(request.requestId, randomId),
        input: {
            joinCode: normalizeJoinCode(request.joinCode ?? randomId()),
            expiresAtEpochMs: request.expiresAtEpochMs ??
                nowEpochMs + DEFAULT_GROUP_JOIN_CODE_TTL_MS,
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
    const commandId = [
        'expire-group-presence',
        session.applicationId,
        session.workspaceId ?? '',
        session.groupId,
        session.sessionId,
        session.generationId,
        session.generationVersion,
        session.expiresAtEpochMs,
    ].join(':');
    return {
        operation: 'disconnectPresence',
        aggregateRef: {
            applicationId: session.applicationId,
            ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
            groupId: session.groupId,
        },
        sessionId: session.sessionId,
        commandId,
        requestId: commandId,
        input: {
            principalId: session.principalId,
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            observedExpiresAtEpochMs: session.expiresAtEpochMs,
            disconnectedAtEpochMs: atEpochMs,
            lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs,
            expiresAtEpochMs: session.expiresAtEpochMs,
            actorPrincipalId: session.principalId,
            actorSessionId: session.sessionId,
            reason: 'expired',
            traceId: null,
        },
    };
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

async function commandJoinCodeVerifier(
    command: GroupMutationCommand,
): Promise<string | null> {
    const joinCode = command.operation === 'rotateGroupJoinCode'
        ? command.input.joinCode
        : command.operation === 'joinGroup' || command.operation === 'acceptGroupInvite'
        ? command.input.joinCode
        : null;
    if (!joinCode) return null;
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(joinCode.trim().toUpperCase()),
    );
    return Array.from(new Uint8Array(digest))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

async function timeMutationPhase<T>(
    dependencies: GroupStateServiceDependencies,
    command: GroupMutationCommand,
    phase: 'read' | 'compute' | 'validate' | 'write' | 'transaction',
    attempt: number,
    backoffMs: number,
    action: () => T | Promise<T>,
): Promise<T> {
    const started = performance.now();
    try {
        const result = await action();
        recordRallarTiming(dependencies.timing, {
            component: 'group-state-service',
            operation: `mutation.${phase}`,
            serviceId: dependencies.serviceId,
            requestId: command.requestId ?? undefined,
            ...command.aggregateRef,
            details: { attempt, backoffMs, mutationOperation: command.operation },
        }, 'ok', performance.now() - started);
        return result;
    } catch (error) {
        recordRallarTiming(dependencies.timing, {
            component: 'group-state-service',
            operation: `mutation.${phase}`,
            serviceId: dependencies.serviceId,
            requestId: command.requestId ?? undefined,
            ...command.aggregateRef,
            details: { attempt, backoffMs, mutationOperation: command.operation },
        }, 'error', performance.now() - started, error);
        throw error;
    }
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
                const request = args.at(-1);
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
