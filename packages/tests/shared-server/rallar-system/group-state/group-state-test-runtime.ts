import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import {
    groupStateMaintenanceRequestId,
    toExpiryCommand,
    toSessionCleanupCommand
} from '@shared-server/rallar-system/group-state/group-presence-mutation-command.ts';
import {
    type GroupJoinCodeWritten,
    type GroupMutationDescriptor,
    type GroupStateService,
    type GroupStateServiceDependencies,
    type GroupStateWritten
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { GroupStateEventStore } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import type {
    RuntimeStateGuardedBatchTransactionalRepositoryLike,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { persistAuthSession } from '../auth/auth-test-fixtures.ts';
import { GroupStateTestMutationExecutor, type GroupStateTestMutationResult } from './group-state-test-mutation-executor.ts';

type GroupStateTestMutationMethod = (
    ...args: GroupStateMethodArgument[]
) => Promise<GroupStateWritten>;

type GroupStateTestReceiptMethod = (
    ...args: GroupStateMethodArgument[]
) => Promise<GroupMutationReceipt>;

export type GroupStateTestService =
    & GroupStateService
    & Readonly<{
        createGroup: GroupStateTestMutationMethod;
        updateGroup: GroupStateTestMutationMethod;
        appointDirector: GroupStateTestMutationMethod;
        joinGroup: GroupStateTestMutationMethod;
        createGroupInvite: GroupStateTestMutationMethod;
        revokeGroupInvite: GroupStateTestMutationMethod;
        acceptGroupInvite: GroupStateTestMutationMethod;
        grantGroupAdmission: GroupStateTestMutationMethod;
        declineGroupAdmission: GroupStateTestMutationMethod;
        rotateGroupJoinCode: (
            ...args: GroupStateMethodArgument[]
        ) => Promise<GroupJoinCodeWritten>;
        removeGroupMember: GroupStateTestMutationMethod;
        banGroupMember: GroupStateTestMutationMethod;
        unbanGroupMember: GroupStateTestMutationMethod;
        setGroupMemberRole: GroupStateTestMutationMethod;
        transferGroupOwnership: GroupStateTestMutationMethod;
        upsertMember: GroupStateTestMutationMethod;
        connectPresenceSession: GroupStateTestMutationMethod;
        connectPresenceSessionReceipt: GroupStateTestReceiptMethod;
        heartbeatPresenceSession: GroupStateTestMutationMethod;
        heartbeatPresenceSessionReceipt: GroupStateTestReceiptMethod;
        disconnectPresenceSession: GroupStateTestMutationMethod;
        disconnectPresenceSessionReceipt: GroupStateTestReceiptMethod;
    }>;

export type TestGroupStateMaintenanceService = Readonly<{
    disconnectPresenceSessionsBySessionId(
        sessionId: string,
        disconnectedAtEpochMs: number
    ): Promise<readonly import('@shared/api/group-types.ts').GroupSnapshot[]>;
    disconnectPresenceSessionsBySessionIdWritten(
        sessionId: string,
        disconnectedAtEpochMs: number
    ): Promise<readonly GroupStateWritten[]>;
    expireExpiredPresenceSessions(atEpochMs: number): Promise<readonly GroupStateWritten[]>;
}>;

export type TestGroupStateRuntime = Readonly<{
    service: GroupStateTestService;
    durable: GroupStateService;
    maintenance: TestGroupStateMaintenanceService;
}>;

export interface AuthSessionInput {
    readonly clientId: string;
    readonly sessionId: string;
    readonly accessToken: string;
    readonly nowEpochMs: number;
}

type TestGroupStateServiceDependencies =
    & Omit<GroupStateServiceDependencies, 'authSessionRepository' | 'groupStateEventStore' | 'runtimeRepository' | 'readPlannedLayoutIdentity'>
    & Readonly<{
        runtimeRepository: RuntimeStateGuardedBatchTransactionalRepositoryLike;
        groupStateEventStoreFor?: (
            runtime: RuntimeStateOptimisticTransactionalRepositoryLike
        ) => GroupStateEventStore;
        sleep?: (delayMs: number) => Promise<void>;
        readPlannedLayoutIdentity?: GroupStateServiceDependencies['readPlannedLayoutIdentity'];
    }>;

export function authSession({
    clientId,
    sessionId,
    accessToken,
    nowEpochMs
}: AuthSessionInput): IssuedAuthSession {
    return {
        clientId,
        sessionId,
        accessToken,
        username: clientId,
        issuedAtEpochMs: nowEpochMs - 1_000,
        expiresAtEpochMs: nowEpochMs + 60_000
    };
}

export function createTestGroupStateRuntime(
    dependencies: TestGroupStateServiceDependencies
): TestGroupStateRuntime {
    const issued = new Map<string, PersistedAuthSession>();
    const now = dependencies.now ?? (() => Date.now());
    const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
    const eventStoreFor = resolveGroupStateEventStoreFactory(dependencies);
    const durable = createGroupStateService({
        runtimeRepository: dependencies.runtimeRepository,
        groupStateEventStore: eventStoreFor(dependencies.runtimeRepository),
        now: dependencies.now,
        randomId: dependencies.randomId,
        serviceId: dependencies.serviceId,
        readPlannedLayoutIdentity: dependencies.readPlannedLayoutIdentity ?? (async () => null),
        timing: dependencies.timing,
        authSessionRepository: {
            findBySessionId: (sessionId) => Promise.resolve(issued.get(sessionId))
        }
    });
    const repositoryFor = (runtime: RuntimeStateOptimisticTransactionalRepositoryLike) => createTestGroupStateRepository(runtime, eventStoreFor(runtime));
    const mutationExecutor = new GroupStateTestMutationExecutor({
        durableService: durable,
        runtimeRepository: dependencies.runtimeRepository,
        groupStateEventStoreFor: eventStoreFor,
        serviceId: dependencies.serviceId,
        randomId,
        sleep: dependencies.sleep
    });
    const service = createAuthenticatedTestGroupStateService(durable, issued, mutationExecutor);
    const maintenance = createTestGroupStateMaintenanceService(
        dependencies.runtimeRepository,
        repositoryFor,
        mutationExecutor
    );
    return { service, durable, maintenance };
}

function resolveGroupStateEventStoreFactory(
    dependencies: TestGroupStateServiceDependencies
): (runtime: RuntimeStateOptimisticTransactionalRepositoryLike) => GroupStateEventStore {
    if (dependencies.groupStateEventStoreFor !== undefined) {
        return dependencies.groupStateEventStoreFor;
    }
    const eventStore = (
        dependencies.runtimeRepository as
            & RuntimeStateOptimisticTransactionalRepositoryLike
            & Partial<Readonly<{ groupStateEventStore: GroupStateEventStore; }>>
    ).groupStateEventStore;
    if (eventStore === undefined) {
        throw new TypeError('Test group-state runtime construction requires an explicit event store owner');
    }
    return () => eventStore;
}

function createAuthenticatedTestGroupStateService(
    durable: GroupStateService,
    issued: Map<string, PersistedAuthSession>,
    mutationExecutor: GroupStateTestMutationExecutor
): GroupStateTestService {
    let testRequestSequence = 0;
    const service = Object.assign({}, durable);
    for (const method of USER_MUTATIONS) {
        Object.defineProperty(service, method, {
            enumerable: true,
            value: async (
                ...args: GroupStateMethodArgument[]
            ): Promise<GroupStateTestMutationResult> => {
                const originalDescriptor = descriptorForMethod(method, args);
                const descriptor = originalDescriptor.request.requestId
                    ? originalDescriptor
                    : {
                        ...originalDescriptor,
                        request: {
                            ...originalDescriptor.request,
                            requestId: `test-group-mutation-${++testRequestSequence}`
                        }
                    };
                const request = args.at(-1) as GroupMutationDescriptor['request'];
                const principalId = readPrincipalId(request);
                const sessionId = PRESENCE_MUTATIONS.has(method)
                    ? String(args[2])
                    : String(request.actorSessionId ?? `${principalId}-session`);
                const authority = createTestAuthSession(principalId, sessionId);
                issued.set(authority.sessionId, await persistAuthSession(authority));
                return await mutationExecutor.executeAuthenticated(
                    descriptor,
                    authority,
                    method.endsWith('Receipt')
                );
            }
        });
    }
    return service as GroupStateTestService;
}

function createTestGroupStateMaintenanceService(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
    repositoryFor: (
        runtime: RuntimeStateOptimisticTransactionalRepositoryLike
    ) => GroupStateRepository,
    mutationExecutor: GroupStateTestMutationExecutor
): TestGroupStateMaintenanceService {
    const maintenance: TestGroupStateMaintenanceService = {
        disconnectPresenceSessionsBySessionId: async (sessionId, disconnectedAtEpochMs) =>
            (
                await maintenance.disconnectPresenceSessionsBySessionIdWritten(
                    sessionId,
                    disconnectedAtEpochMs
                )
            ).flatMap((written) => (written.result ? [written.result.snapshot] : [])),
        disconnectPresenceSessionsBySessionIdWritten: async (sessionId, disconnectedAtEpochMs) => {
            const sessions = (await repositoryFor(runtimeRepository).listAllPresenceSessions()).filter(
                (session) => session.sessionId === sessionId && session.disconnectedAtEpochMs === null
            );
            const results = [];
            for (const session of sessions) {
                const computed = await mutationExecutor.executeInternal(
                    toSessionCleanupCommand(session, disconnectedAtEpochMs),
                    'session-cleanup',
                    disconnectedAtEpochMs
                );
                results.push(await mutationExecutor.toMutationResult('disconnectPresence', computed));
            }
            return results;
        },
        expireExpiredPresenceSessions: async (atEpochMs) => {
            const sessions = (await repositoryFor(runtimeRepository).listAllPresenceSessions()).filter(
                (session) => session.disconnectedAtEpochMs === null && session.expiresAtEpochMs <= atEpochMs
            );
            const results = [];
            for (const session of sessions) {
                const computed = await mutationExecutor.executeInternal(
                    toExpiryCommand(session, atEpochMs),
                    'expiry',
                    atEpochMs
                );
                if (computed.outcome !== 'write') {
                    continue;
                }
                results.push(await mutationExecutor.toMutationResult('disconnectPresence', computed));
            }
            return results;
        }
    };
    return maintenance;
}

export function createTestGroupStateService(
    dependencies: TestGroupStateServiceDependencies
): GroupStateTestService {
    return createTestGroupStateRuntime(dependencies).service;
}

export function createTestAuthSession(
    principalId: string,
    sessionId: string = `${principalId}-session`
): IssuedAuthSession {
    return {
        clientId: principalId,
        sessionId,
        accessToken: `test-token:${principalId}:${sessionId}`,
        username: principalId,
        issuedAtEpochMs: 1,
        expiresAtEpochMs: TEST_OUTBOX_EXPIRE_AT_EPOCH_MS
    };
}

type GroupStateMethodArgument =
    | GroupMutationDescriptor['scope']
    | GroupMutationDescriptor['request']
    | string;

function descriptorForMethod(
    method: string,
    args: readonly GroupStateMethodArgument[]
): GroupMutationDescriptor {
    const scope = args[0] as GroupMutationDescriptor['scope'];
    const groupId = method === 'createGroup' ? String((args[1] as { groupId: string; }).groupId) : String(args[1]);
    const isTarget = TARGET_MUTATIONS.has(method);
    const isPresence = PRESENCE_MUTATIONS.has(method);
    const requestIndex = method === 'createGroup' ? 1 : isTarget || isPresence ? 3 : 2;
    const request = args[requestIndex] as GroupMutationDescriptor['request'];
    const operation = METHOD_OPERATION[method];
    if (!operation) {
        throw new TypeError(`Unknown test group mutation method: ${method}`);
    }
    return mutationDescriptor({
        operation,
        scope,
        groupId,
        request,
        targetPrincipalId: isTarget
            ? String(args[2])
            : operation === 'transferGroupOwnership'
            ? String((request as { newOwnerPrincipalId: string; }).newOwnerPrincipalId)
            : isPresence && 'principalId' in request
            ? String(request.principalId ?? '') || null
            : null,
        sessionId: isPresence ? String(args[2]) : null
    });
}

function readPrincipalId(request: GroupMutationDescriptor['request']): string {
    return String(
        request.actorPrincipalId ??
            ('createdByPrincipalId' in request ? request.createdByPrincipalId : undefined) ??
            ('principalId' in request ? request.principalId : undefined) ??
            'alice'
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
    grantGroupAdmission: 'grantGroupAdmission',
    declineGroupAdmission: 'declineGroupAdmission',
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
    disconnectPresenceSessionReceipt: 'disconnectPresence'
};

const USER_MUTATIONS = Object.keys(METHOD_OPERATION);
const TARGET_MUTATIONS = new Set([
    'createGroupInvite',
    'revokeGroupInvite',
    'grantGroupAdmission',
    'declineGroupAdmission',
    'removeGroupMember',
    'banGroupMember',
    'unbanGroupMember',
    'setGroupMemberRole',
    'upsertMember'
]);
const PRESENCE_MUTATIONS = new Set([
    'connectPresenceSession',
    'connectPresenceSessionReceipt',
    'heartbeatPresenceSession',
    'heartbeatPresenceSessionReceipt',
    'disconnectPresenceSession',
    'disconnectPresenceSessionReceipt'
]);
const TEST_OUTBOX_EXPIRE_AT_EPOCH_MS = 253_402_300_799_999;

void groupStateMaintenanceRequestId;
void (null as GroupPresenceSession | null);
