import { Either } from '@shared/resilience/Either.ts';
import type { GroupEvent, GroupPresenceSession } from '@shared/api/group-types.ts';
import { persistAuthSession, type AuthSession, type StoredAuthSession } from './auth-fixture.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { hashMutationCommand, type JsonWireValue } from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
    isRuntimeStateGuardedBatchRepositoryLike,
    validateRuntimeStateGuardedBatchResult,
} from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';
import {
    requireConditionalWrite,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import {
    createGroupStateService,
    groupStateMaintenanceRequestId,
    mutationDescriptor,
    toExpiryCommand,
    toSessionCleanupCommand,
    type GroupMutationDescriptor,
    type GroupStateService,
    type GroupStateServiceDependencies,
    type GroupStateMutationCommand,
    type GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { materializeGroupStateGuardedBatch } from '@shared-server/rallar-system/services/group-state-guarded-batch.ts';
import type {
    GroupMutationComputed,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationReceipt,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

export type TestAuthenticatedGroupStateService = GroupStateService &
    Readonly<Record<string, (...args: any[]) => Promise<any>>>;

export type TestGroupStateMaintenanceService = Readonly<{
    disconnectPresenceSessionsBySessionId(
        sessionId: string,
        disconnectedAtEpochMs: number,
    ): Promise<readonly import('@shared/api/group-types.ts').GroupSnapshot[]>;
    disconnectPresenceSessionsBySessionIdWritten(
        sessionId: string,
        disconnectedAtEpochMs: number,
    ): Promise<readonly GroupStateWritten[]>;
    expireExpiredPresenceSessions(
        atEpochMs: number,
    ): Promise<readonly GroupStateWritten[]>;
}>;

export type TestGroupStateRuntime = Readonly<{
    service: TestAuthenticatedGroupStateService;
    durable: GroupStateService;
    maintenance: TestGroupStateMaintenanceService;
}>;

type TestGroupStateServiceDependencies =
    Omit<GroupStateServiceDependencies, 'authSessionRepository'> &
    Readonly<{
        syncPublisher?: unknown;
        sleep?: (delayMs: number) => Promise<void>;
    }>;

export function createTestGroupStateRuntime(
    dependencies: TestGroupStateServiceDependencies,
): TestGroupStateRuntime {
    const issued = new Map<string, StoredAuthSession>();
    const now = dependencies.now ?? (() => Date.now());
    const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
    let testRequestSequence = 0;
    const durable = createGroupStateService({
        runtimeRepository: dependencies.runtimeRepository,
        createGroupStateEventStore: dependencies.createGroupStateEventStore,
        now: dependencies.now,
        randomId: dependencies.randomId,
        serviceId: dependencies.serviceId,
        timing: dependencies.timing,
        authSessionRepository: {
            findBySessionId: (sessionId) => Promise.resolve(issued.get(sessionId)),
        },
    });
    const repositoryFor = (runtime: RuntimeStateOptimisticTransactionalRepositoryLike) =>
        new GroupStateRepository(runtime, {
            events: dependencies.createGroupStateEventStore?.(runtime),
        });

    const executeDescriptor = async (
        descriptor: GroupMutationDescriptor,
        authority: AuthSession,
        receiptOnly: boolean,
    ): Promise<unknown> => {
        issued.set(authority.sessionId, await persistAuthSession(authority));
        const prepared = await durable.prepareMutation(descriptor, authority);
        let computed: GroupMutationComputed | undefined;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const command: GroupStateMutationCommand = {
                authorityProof: prepared.authorityProof,
                descriptor: prepared.descriptor,
                command: prepared.command,
                facts: { ...prepared.facts, attemptCount: attempt },
            };
            try {
                const read = await durable.read(command);
                computed = durable.compute(command, read);
                durable.validate(command, read, computed);
                if (computed.outcome === 'idempotency-conflict') {
                    throw new TypeError('Validated idempotency conflict is unreachable');
                }
                if (computed.outcome === 'write') {
                    await dependencies.runtimeRepository.begin(async (transaction) => {
                        await writeComputedForTest(
                            transaction,
                            repositoryFor(transaction),
                            computed as GroupMutationComputedWrite,
                        );
                    });
                }
                return await toCompatibleResult(
                    repositoryFor(dependencies.runtimeRepository),
                    prepared.command.operation,
                    computed,
                    receiptOnly,
                );
            } catch (error) {
                if (!(error instanceof RuntimeStateWriteConflictError)) {
                    throw error;
                }
                if (attempt === 3) throw new RuntimeStateRetryExhaustedError(error);
                await dependencies.sleep?.(attempt === 1 ? 2 : 8);
            }
        }
        throw new TypeError(`Missing computed group mutation: ${String(computed)}`);
    };

    const service = Object.assign({}, durable) as TestAuthenticatedGroupStateService;
    for (const method of USER_MUTATIONS) {
        Object.defineProperty(service, method, {
            enumerable: true,
            value: async (...args: unknown[]) => {
                const originalDescriptor = descriptorForMethod(method, args);
                const descriptor = originalDescriptor.request.requestId
                    ? originalDescriptor
                    : {
                        ...originalDescriptor,
                        request: {
                            ...originalDescriptor.request,
                            requestId: `test-group-mutation-${++testRequestSequence}`,
                        },
                    };
                const request = args.at(-1) as Record<string, unknown>;
                const principalId = String(
                    request.actorPrincipalId ??
                    request.createdByPrincipalId ??
                    request.principalId ??
                    'alice',
                );
                const sessionId = PRESENCE_MUTATIONS.has(method)
                    ? String(args[2])
                    : String(request.actorSessionId ?? `${principalId}-session`);
                return await executeDescriptor(
                    descriptor,
                    createTestAuthSession(principalId, sessionId),
                    method.endsWith('Receipt'),
                );
            },
        });
    }

    const executeInternal = async (
        command: ReturnType<typeof toExpiryCommand> | ReturnType<typeof toSessionCleanupCommand>,
        authority: GroupMutationFacts['internalAuthority'],
        atEpochMs: number,
    ): Promise<Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict' }>> => {
        const commandHash = await hashMutationCommand(command as JsonWireValue);
        let computed: GroupMutationComputed | undefined;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const read = await import('@shared-server/rallar-system/group-state/mutation/read-group-mutation.ts')
                .then(({ readGroupMutation }) =>
                    readGroupMutation(repositoryFor(dependencies.runtimeRepository), command)
                );
            const facts: GroupMutationFacts = {
                nowEpochMs: atEpochMs,
                expireAtEpochMs: TEST_OUTBOX_EXPIRE_AT_EPOCH_MS,
                serviceId: dependencies.serviceId,
                eventId: randomId(),
                commandHash,
                attemptCount: attempt,
                resolvedJoinCode: null,
                joinCodeVerifier: null,
                internalAuthority: authority,
                authenticatedAuthority: null,
            };
            const mutation = await import(
                '@shared-server/rallar-system/services/group-state-mutations.ts'
            );
            computed = mutation.computeGroupMutation({ command, read, facts });
            mutation.validateGroupMutation({ command, read, facts, computed });
            if (computed.outcome === 'idempotency-conflict') {
                throw new TypeError('Validated idempotency conflict is unreachable');
            }
            if (computed.outcome !== 'write') return computed;
            try {
                await dependencies.runtimeRepository.begin(async (transaction) => {
                    await writeComputedForTest(
                        transaction,
                        repositoryFor(transaction),
                        computed as GroupMutationComputedWrite,
                    );
                });
                return computed;
            } catch (error) {
                if (!(error instanceof RuntimeStateWriteConflictError)) {
                    throw error;
                }
                if (attempt === 3) throw new RuntimeStateRetryExhaustedError(error);
                await dependencies.sleep?.(attempt === 1 ? 2 : 8);
            }
        }
        throw new TypeError(`Missing internal group mutation: ${String(computed)}`);
    };

    const maintenance: TestGroupStateMaintenanceService = {
        disconnectPresenceSessionsBySessionId: async (sessionId, disconnectedAtEpochMs) =>
            (await maintenance.disconnectPresenceSessionsBySessionIdWritten(
                sessionId,
                disconnectedAtEpochMs,
            )).flatMap((written) => written.result.right ? [written.result.right.snapshot] : []),
        disconnectPresenceSessionsBySessionIdWritten: async (
            sessionId,
            disconnectedAtEpochMs,
        ) => {
            const sessions = (await repositoryFor(
                dependencies.runtimeRepository,
            ).listAllPresenceSessions()).filter((session) =>
                session.sessionId === sessionId && session.disconnectedAtEpochMs === null
            );
            const results = [];
            for (const session of sessions) {
                const computed = await executeInternal(
                    toSessionCleanupCommand(session, disconnectedAtEpochMs),
                    'session-cleanup',
                    disconnectedAtEpochMs,
                );
                results.push(await toCompatibleResult(
                    repositoryFor(dependencies.runtimeRepository),
                    'disconnectPresence',
                    computed,
                ));
            }
            return results;
        },
        expireExpiredPresenceSessions: async (atEpochMs) => {
            const sessions = (await repositoryFor(
                dependencies.runtimeRepository,
            ).listAllPresenceSessions()).filter((session) =>
                session.disconnectedAtEpochMs === null &&
                session.expiresAtEpochMs <= atEpochMs
            );
            const results = [];
            for (const session of sessions) {
                const computed = await executeInternal(
                    toExpiryCommand(session, atEpochMs),
                    'expiry',
                    atEpochMs,
                );
                if (computed.outcome !== 'write') continue;
                results.push(await toCompatibleResult(
                    repositoryFor(dependencies.runtimeRepository),
                    'disconnectPresence',
                    computed,
                ));
            }
            return results;
        },
    };

    return { service, durable, maintenance };
}

export function createTestGroupStateService(
    dependencies: Omit<GroupStateServiceDependencies, 'authSessionRepository'>,
): TestAuthenticatedGroupStateService {
    return createTestGroupStateRuntime(dependencies).service;
}

export function createTestAuthSession(
    principalId: string,
    sessionId: string = `${principalId}-session`,
): AuthSession {
    return {
        clientId: principalId,
        sessionId,
        accessToken: `test-token:${principalId}:${sessionId}`,
        username: principalId,
        issuedAtEpochMs: 1,
        expiresAtEpochMs: TEST_OUTBOX_EXPIRE_AT_EPOCH_MS,
    };
}

async function writeComputedForTest(
    transaction: RuntimeStateOptimisticTransactionalRepositoryLike,
    repository: GroupStateRepository,
    computed: GroupMutationComputedWrite,
): Promise<GroupMutationReceipt> {
    if (isRuntimeStateGuardedBatchRepositoryLike(transaction)) {
        const materialized = materializeGroupStateGuardedBatch(computed);
        const result = validateRuntimeStateGuardedBatchResult(
            materialized.batch,
            await transaction.executeGuardedBatch(materialized.batch),
        );
        if (
            result.guard.status === 'conflict' ||
            result.effects.some((effect) => effect.status !== 'applied')
        ) {
            throw new RuntimeStateWriteConflictError();
        }
    } else if (computed.guard.kind === 'group') {
        requireConditionalWrite(
            computed.guard.operation === 'insert'
                ? await repository.insertGroup(computed.guard.value)
                : await repository.updateGroup(
                    computed.guard.value,
                    computed.guard.expectedRevision,
                ),
        );
    } else {
        requireConditionalWrite(
            computed.guard.operation === 'insert'
                ? await repository.insertPresence(computed.guard.value)
                : computed.guard.operation === 'update'
                ? await repository.updatePresence(
                    computed.guard.value,
                    computed.guard.expectedRevision,
                )
                : await repository.deletePresence(
                    computed.guard.value,
                    computed.guard.expectedRevision,
                ),
        );
    }
    if (!isRuntimeStateGuardedBatchRepositoryLike(transaction) && computed.presenceAdmission) {
        requireConditionalWrite(
            computed.presenceAdmission.operation === 'insert'
                ? await repository.insertPresenceAdmission(
                    computed.presenceAdmission.value,
                )
                : await repository.updatePresenceAdmission(
                    computed.presenceAdmission.value,
                    computed.presenceAdmission.expectedRevision,
                ),
        );
    }
    if (!isRuntimeStateGuardedBatchRepositoryLike(transaction)) {
        for (const member of computed.members) await repository.putMember(member);
    }
    if (!isRuntimeStateGuardedBatchRepositoryLike(transaction) && computed.initialPresenceSummary) {
        const summary = computed.initialPresenceSummary;
        requireConditionalWrite(summary.operation === 'insert'
            ? await repository.insertPresenceSummary(summary.value)
            : await repository.updatePresenceSummary(summary.value, summary.expectedRevision));
    }
    if (!isRuntimeStateGuardedBatchRepositoryLike(transaction) && computed.idempotency) {
        requireConditionalWrite(
            await repository.insertIdempotentGroupMutationReceipt(
                computed.receipt.aggregateRef,
                computed.idempotency.requestId,
                computed.idempotency,
            ),
        );
    }
    await repository.appendEvent(computed.event);
    return computed.receipt;
}

async function toCompatibleResult(
    repository: GroupStateRepository,
    operation: GroupStateMutationCommand['command']['operation'],
    computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict' }>,
    receiptOnly: boolean = false,
): Promise<any> {
    const receipt = computed.receipt;
    if (receiptOnly) {
        return receipt;
    }
    const snapshot = await repository.readSnapshot(receipt.aggregateRef);
    if (!snapshot) throw new TypeError(`Group snapshot not found: ${receipt.aggregateRef.groupId}`);
    const event = await receiptEvent(repository, receipt);
    if (operation === 'rotateGroupJoinCode') {
        return receipt.outcome === 'rejected'
            ? { status: 'error', result: Either.ofLeft(receipt.rejection ?? 'Rejected') }
            : {
                status: 'ok',
                result: Either.ofRight({
                    joinCode: receipt.joinCode,
                    expiresAtEpochMs: receipt.joinCodeExpiresAtEpochMs,
                    snapshot,
                    event,
                }),
            };
    }
    return receipt.outcome === 'rejected'
        ? { status: 'error', result: Either.ofLeft(receipt.rejection ?? 'Rejected') }
        : {
            status: operation === 'createGroup' ? 'created' : 'ok',
            result: Either.ofRight({ snapshot, event }),
        };
}

async function receiptEvent(
    repository: GroupStateRepository,
    receipt: GroupMutationReceipt,
): Promise<GroupEvent | null> {
    if (receipt.eventId === null) return null;
    return (await repository.listEvents(receipt.aggregateRef))
        .find((event) => event.eventId === receipt.eventId) ?? null;
}

function descriptorForMethod(
    method: string,
    args: readonly unknown[],
): GroupMutationDescriptor {
    const scope = args[0] as GroupMutationDescriptor['scope'];
    const groupId = method === 'createGroup'
        ? String((args[1] as { groupId: string }).groupId)
        : String(args[1]);
    const isTarget = TARGET_MUTATIONS.has(method);
    const isPresence = PRESENCE_MUTATIONS.has(method);
    const requestIndex = method === 'createGroup' ? 1 : isTarget || isPresence ? 3 : 2;
    const request = args[requestIndex] as GroupMutationDescriptor['request'];
    const operation = METHOD_OPERATION[method];
    if (!operation) throw new TypeError(`Unknown test group mutation method: ${method}`);
    return mutationDescriptor(
        operation,
        scope,
        groupId,
        request,
        isTarget
            ? String(args[2])
            : operation === 'transferGroupOwnership'
            ? String((request as { newOwnerPrincipalId: string }).newOwnerPrincipalId)
            : isPresence && 'principalId' in request
            ? String(request.principalId ?? '') || null
            : null,
        isPresence ? String(args[2]) : null,
    );
}

const METHOD_OPERATION: Readonly<Record<string, GroupMutationDescriptor['operation']>> = {
    createGroup: 'createGroup',
    updateGroup: 'updateGroup',
    appointDirector: 'appointDirector',
    joinGroup: 'joinGroup',
    createGroupInvite: 'createGroupInvite',
    revokeGroupInvite: 'revokeGroupInvite',
    acceptGroupInvite: 'acceptGroupInvite',
    rotateGroupJoinCode: 'rotateGroupJoinCode',
    removeGroupMember: 'removeGroupMember',
    banGroupMember: 'banGroupMember',
    unbanGroupMember: 'unbanGroupMember',
    setGroupMemberRole: 'setGroupMemberRole',
    transferGroupOwnership: 'transferGroupOwnership',
    upsertMember: 'upsertMember',
    connectPresenceSession: 'connectPresence',
    connectPresenceSessionReceipt: 'connectPresence',
    heartbeatPresenceSession: 'heartbeatPresence',
    heartbeatPresenceSessionReceipt: 'heartbeatPresence',
    disconnectPresenceSession: 'disconnectPresence',
    disconnectPresenceSessionReceipt: 'disconnectPresence',
};

const USER_MUTATIONS = Object.keys(METHOD_OPERATION);
const TARGET_MUTATIONS = new Set([
    'createGroupInvite', 'revokeGroupInvite', 'removeGroupMember',
    'banGroupMember', 'unbanGroupMember', 'setGroupMemberRole', 'upsertMember',
]);
const PRESENCE_MUTATIONS = new Set([
    'connectPresenceSession', 'connectPresenceSessionReceipt',
    'heartbeatPresenceSession', 'heartbeatPresenceSessionReceipt',
    'disconnectPresenceSession', 'disconnectPresenceSessionReceipt',
]);
const TEST_OUTBOX_EXPIRE_AT_EPOCH_MS = 253_402_300_799_999;

void groupStateMaintenanceRequestId;
void (null as GroupPresenceSession | null);
