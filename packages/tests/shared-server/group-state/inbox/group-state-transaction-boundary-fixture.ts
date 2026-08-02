import { Temporal } from '@js-temporal/polyfill';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { CreateGroupRequest } from '@shared/api/state-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { GroupStateInboxHandler } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import {
  AuthSessionRepository,
  type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/services/app-inbox-transaction-writer.ts';
import {
  AppInboxType,
  SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
  type AppInboxMessageContext,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  type AppInboxTestDatabaseStage,
  createAppInboxTestDatabase,
} from '../../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { authSession } from '../group-state-test-runtime.ts';
import {
  TestResourceInbox,
  TestResourceInboxResults,
} from './group-state-inbox-resource-fixtures.ts';

const NOW_EPOCH_MS = Date.parse('2026-08-02T00:00:00.000Z');
const GROUP_ID = 'transaction-boundary-room';
const REQUEST_ID = 'create-transaction-boundary-room';
const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

export type GroupTransactionFailurePhase = 'domain-write' | AppInboxTestDatabaseStage;

export interface GroupStateTransactionBoundaryHarness {
  readonly context: AppInboxMessageContext;
  readonly handler: GroupStateInboxHandler;
  readonly queue: TestResourceInbox;
  readonly results: TestResourceInboxResults;
  readonly repository: GroupStateRepository;
  readonly outboxEntries: ReadonlyMap<string, ResourceEntry>;
  readonly reachedStages: readonly string[];
  readonly observedSnapshots: readonly GroupSnapshot[];
  readonly groupRef: typeof SCOPE & Readonly<{ groupId: string }>;
  readWakeCount(): number;
}

interface TransactionBoundaryStorage {
  readonly runtimeRepository: FakeRuntimeStateRepository;
  readonly queue: TestResourceInbox;
  readonly results: TestResourceInboxResults;
  readonly database: ReturnType<typeof createAppInboxTestDatabase>;
  readonly reachedStages: string[];
}

interface TransactionBoundaryGroupStateOwner {
  readonly service: GroupStateService;
  readonly observedSnapshots: GroupSnapshot[];
}

export async function createGroupStateTransactionBoundaryHarness(
  failurePhase?: GroupTransactionFailurePhase,
): Promise<GroupStateTransactionBoundaryHarness> {
  const storage = createTransactionBoundaryStorage(failurePhase);
  const groupState = await createTransactionBoundaryGroupStateService(storage);
  const prepared = await groupState.service.prepareMutation(
    mutationDescriptor('createGroup', SCOPE, GROUP_ID, createGroupRequest()),
    createOwnerAuthority(),
  );
  const context = await createReservedContext(storage.queue, prepared);
  let wakeCount = 0;
  const transactionWriter = new AppInboxTransactionWriter({
    database: storage.database,
    serviceId: 'server-12345678',
    nowEpochMs: () => NOW_EPOCH_MS,
    toTimingDetails: () => ({}),
  });
  transactionWriter.begin(context);
  const handler = new GroupStateInboxHandler({
    groupStateService: groupState.service,
    writeMutation: async (messageContext, write) =>
      await transactionWriter.writeMutation(messageContext, write),
    wakeQueue: () => {
      wakeCount += 1;
    },
  });
  return {
    context,
    handler,
    queue: storage.queue,
    results: storage.results,
    repository: new GroupStateRepository(storage.runtimeRepository, {
      events: storage.database.groupEventStore,
    }),
    outboxEntries: storage.database.outboxEntries,
    reachedStages: storage.reachedStages,
    observedSnapshots: groupState.observedSnapshots,
    groupRef: { ...SCOPE, groupId: GROUP_ID },
    readWakeCount: () => wakeCount,
  };
}

function createTransactionBoundaryStorage(
  failurePhase?: GroupTransactionFailurePhase,
): TransactionBoundaryStorage {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const queue = new TestResourceInbox();
  const results = new TestResourceInboxResults();
  const reachedStages: string[] = [];
  const database = createAppInboxTestDatabase(queue, results, {
    runtimeRepository,
    onStage: async (stage) => {
      reachedStages.push(stage);
      if (stage === failurePhase) throw new Error(`controlled ${stage} failure`);
    },
  });
  if (failurePhase === 'domain-write') {
    runtimeRepository.beforeConditionalWrite = () => {
      reachedStages.push('domain-write');
      throw new Error('controlled domain-write failure');
    };
  }
  return { runtimeRepository, queue, results, database, reachedStages };
}

async function createTransactionBoundaryGroupStateService(
  storage: TransactionBoundaryStorage,
): Promise<TransactionBoundaryGroupStateOwner> {
  const authSessions = new AuthSessionRepository(storage.runtimeRepository);
  const authority = createOwnerAuthority();
  await authSessions.putSession(authority);
  const groupStateService = createGroupStateService({
    runtimeRepository: storage.runtimeRepository,
    createGroupStateEventStore: () => storage.database.groupEventStore,
    serviceId: 'server-12345678',
    now: () => NOW_EPOCH_MS,
    randomId: () => 'fixed-random-id',
    authSessionRepository: authSessions,
  });
  const observedSnapshots: GroupSnapshot[] = [];
  groupStateService.observeSnapshot = async (snapshot) => {
    observedSnapshots.push(snapshot);
    return snapshot;
  };
  return { service: groupStateService, observedSnapshots };
}

function createOwnerAuthority(): IssuedAuthSession {
  return {
    ...authSession({
      clientId: 'owner',
      sessionId: 'owner-session',
      accessToken: 'owner-token',
      nowEpochMs: NOW_EPOCH_MS,
    }),
    expiresAtEpochMs: 253_402_300_799_999,
  };
}

function createGroupRequest(): CreateGroupRequest {
  return {
    groupId: GROUP_ID,
    displayName: 'Transaction boundary room',
    kind: 'room' as const,
    joinMode: 'open' as const,
    createdByPrincipalId: 'owner',
    actorPrincipalId: 'owner',
    actorSessionId: 'owner-session',
    requestId: REQUEST_ID,
  };
}

async function createReservedContext(
  queue: TestResourceInbox,
  authority: unknown,
): Promise<AppInboxMessageContext> {
  const enqueue = {
    type: AppInboxType.GROUP_CREATE,
    resourceId: REQUEST_ID,
    contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${GROUP_ID}`,
    authority,
    data: { scope: SCOPE, request: createGroupRequest() },
  };
  const createdAt = Temporal.Instant.fromEpochMilliseconds(NOW_EPOCH_MS);
  const entry: ResourceEntry = {
    key: {
      topicId: SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
      resourceId: REQUEST_ID,
      contextId: enqueue.contextId,
    },
    resource: JSON.stringify(enqueue),
    typeId: AppInboxType.GROUP_CREATE,
    status: EntityStatus.RESERVED,
    audit: {
      date: createdAt.toZonedDateTimeISO('UTC').toPlainTime(),
      createdBy: 'owner',
      createdTs: createdAt.toZonedDateTimeISO('UTC').toPlainDateTime(),
      expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.999Z'),
    },
    dequeueAudit: { attempts: 1, startTs: createdAt },
  };
  await queue.enqueue(entry);
  return { enqueue, entry, message: {} as never };
}
