import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import {
  persistAuthSession,
  type AuthSession,
  type StoredAuthSession,
} from '../auth/auth-test-fixtures.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
  createGroupStateService,
  groupStateMaintenanceRequestId,
  mutationDescriptor,
  toExpiryCommand,
  toSessionCleanupCommand,
  type GroupMutationDescriptor,
  type GroupStateService,
  type GroupStateServiceDependencies,
  type GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupStateTestMutationExecutor } from './group-state-test-mutation-executor.ts';

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
  expireExpiredPresenceSessions(atEpochMs: number): Promise<readonly GroupStateWritten[]>;
}>;

export type TestGroupStateRuntime = Readonly<{
  service: TestAuthenticatedGroupStateService;
  durable: GroupStateService;
  maintenance: TestGroupStateMaintenanceService;
}>;

export interface AuthSessionInput {
  readonly clientId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly nowEpochMs: number;
}

type TestGroupStateServiceDependencies = Omit<
  GroupStateServiceDependencies,
  'authSessionRepository'
> &
  Readonly<{
    syncPublisher?: unknown;
    sleep?: (delayMs: number) => Promise<void>;
  }>;

export function authSession({
  clientId,
  sessionId,
  accessToken,
  nowEpochMs,
}: AuthSessionInput): IssuedAuthSession {
  return {
    clientId,
    sessionId,
    accessToken,
    username: clientId,
    issuedAtEpochMs: nowEpochMs - 1_000,
    expiresAtEpochMs: nowEpochMs + 60_000,
  };
}

export function createTestGroupStateRuntime(
  dependencies: TestGroupStateServiceDependencies,
): TestGroupStateRuntime {
  const issued = new Map<string, StoredAuthSession>();
  const now = dependencies.now ?? (() => Date.now());
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const durable = createGroupStateService({
    runtimeRepository: dependencies.runtimeRepository,
    formationDamping: 'damped',
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
  const mutationExecutor = new GroupStateTestMutationExecutor({
    durableService: durable,
    runtimeRepository: dependencies.runtimeRepository,
    createGroupStateEventStore: dependencies.createGroupStateEventStore,
    serviceId: dependencies.serviceId,
    randomId,
    sleep: dependencies.sleep,
  });
  const service = createAuthenticatedTestGroupStateService(durable, issued, mutationExecutor);
  const maintenance = createTestGroupStateMaintenanceService(
    dependencies.runtimeRepository,
    repositoryFor,
    mutationExecutor,
  );
  return { service, durable, maintenance };
}

function createAuthenticatedTestGroupStateService(
  durable: GroupStateService,
  issued: Map<string, StoredAuthSession>,
  mutationExecutor: GroupStateTestMutationExecutor,
): TestAuthenticatedGroupStateService {
  let testRequestSequence = 0;
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
        const authority = createTestAuthSession(principalId, sessionId);
        issued.set(authority.sessionId, await persistAuthSession(authority));
        return await mutationExecutor.executeAuthenticated(
          descriptor,
          authority,
          method.endsWith('Receipt'),
        );
      },
    });
  }
  return service;
}

function createTestGroupStateMaintenanceService(
  runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
  repositoryFor: (
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
  ) => GroupStateRepository,
  mutationExecutor: GroupStateTestMutationExecutor,
): TestGroupStateMaintenanceService {
  const maintenance: TestGroupStateMaintenanceService = {
    disconnectPresenceSessionsBySessionId: async (sessionId, disconnectedAtEpochMs) =>
      (
        await maintenance.disconnectPresenceSessionsBySessionIdWritten(
          sessionId,
          disconnectedAtEpochMs,
        )
      ).flatMap((written) => (written.result.right ? [written.result.right.snapshot] : [])),
    disconnectPresenceSessionsBySessionIdWritten: async (sessionId, disconnectedAtEpochMs) => {
      const sessions = (await repositoryFor(runtimeRepository).listAllPresenceSessions()).filter(
        (session) => session.sessionId === sessionId && session.disconnectedAtEpochMs === null,
      );
      const results = [];
      for (const session of sessions) {
        const computed = await mutationExecutor.executeInternal(
          toSessionCleanupCommand(session, disconnectedAtEpochMs),
          'session-cleanup',
          disconnectedAtEpochMs,
        );
        results.push(await mutationExecutor.toCompatibleResult('disconnectPresence', computed));
      }
      return results;
    },
    expireExpiredPresenceSessions: async (atEpochMs) => {
      const sessions = (await repositoryFor(runtimeRepository).listAllPresenceSessions()).filter(
        (session) =>
          session.disconnectedAtEpochMs === null && session.expiresAtEpochMs <= atEpochMs,
      );
      const results = [];
      for (const session of sessions) {
        const computed = await mutationExecutor.executeInternal(
          toExpiryCommand(session, atEpochMs),
          'expiry',
          atEpochMs,
        );
        if (computed.outcome !== 'write') continue;
        results.push(await mutationExecutor.toCompatibleResult('disconnectPresence', computed));
      }
      return results;
    },
  };
  return maintenance;
}

export function createTestGroupStateService(
  dependencies: TestGroupStateServiceDependencies,
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

function descriptorForMethod(method: string, args: readonly unknown[]): GroupMutationDescriptor {
  const scope = args[0] as GroupMutationDescriptor['scope'];
  const groupId =
    method === 'createGroup' ? String((args[1] as { groupId: string }).groupId) : String(args[1]);
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
  'createGroupInvite',
  'revokeGroupInvite',
  'removeGroupMember',
  'banGroupMember',
  'unbanGroupMember',
  'setGroupMemberRole',
  'upsertMember',
]);
const PRESENCE_MUTATIONS = new Set([
  'connectPresenceSession',
  'connectPresenceSessionReceipt',
  'heartbeatPresenceSession',
  'heartbeatPresenceSessionReceipt',
  'disconnectPresenceSession',
  'disconnectPresenceSessionReceipt',
]);
const TEST_OUTBOX_EXPIRE_AT_EPOCH_MS = 253_402_300_799_999;

void groupStateMaintenanceRequestId;
void (null as GroupPresenceSession | null);
