import { Temporal } from '@js-temporal/polyfill';
import { expect, vi } from 'vitest';
import {
  type AppInboxTestDatabase,
  createAppInboxTestDatabase,
} from '../../app-inbox-test-database.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
  AppGroupInboxService,
  AppInboxService,
  type AppInboxEnqueueInput,
  AppInboxType,
  type GroupCreateAppInboxPayload,
  type GroupInviteCreateAppInboxPayload,
  type GroupMemberBanAppInboxPayload,
  type GroupMemberUnbanAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  createGroupStateService,
  type GroupStateService,
  type GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { authSession } from '../group-state-test-runtime.ts';
import {
  TestResourceInbox,
  TestResourceInboxResults,
} from './group-state-inbox-resource-fixtures.ts';

export {
  TestResourceInbox,
  TestResourceInboxResults,
} from './group-state-inbox-resource-fixtures.ts';

export const SCOPE: StateScope = {
  applicationId: 'ar-eye-hunter',
  workspaceId: 'default',
};

export type AuthorityHarness = Readonly<{
  nowEpochMs: number;
  runtimeRepository: FakeRuntimeStateRepository;
  repository: GroupStateRepository;
  authSessions: AuthSessionRepository;
  groupStateService: GroupStateService;
  service: AppGroupInboxService;
  database: AppInboxTestDatabase;
  reader: InboxQueueReader;
  queue: TestResourceInbox;
  results: TestResourceInboxResults;
  sessions: Readonly<Record<string, IssuedAuthSession>>;
  queueEntries(): readonly ResourceEntry[];
}>;

export type OperationMatrixCase = Readonly<{
  type: AppInboxType;
  operation: string;
  authority: IssuedAuthSession;
  data: unknown;
  assertDomain(): Promise<void>;
}>;

export function createInviteOperationCase(
  input: Readonly<{
    harness: AuthorityHarness;
    groupId: string;
    ownerActor: Readonly<{
      actorPrincipalId: string;
      actorSessionId: string;
    }>;
    requestId: string;
    assertDomain: () => Promise<void>;
  }>,
): OperationMatrixCase {
  return {
    type: AppInboxType.GROUP_INVITE_CREATE,
    operation: 'createGroupInvite',
    authority: input.harness.sessions.owner,
    data: {
      scope: SCOPE,
      groupId: input.groupId,
      principalId: 'charlie',
      request: {
        invitationExpiresAtEpochMs: input.harness.nowEpochMs + 60_000,
        ...input.ownerActor,
        requestId: input.requestId,
      },
    } satisfies GroupInviteCreateAppInboxPayload,
    assertDomain: input.assertDomain,
  };
}

export function createGovernedOperationCase(
  input: Readonly<{
    harness: AuthorityHarness;
    groupId: string;
    ownerActor: Readonly<{
      actorPrincipalId: string;
      actorSessionId: string;
    }>;
    type: AppInboxType.GROUP_MEMBER_BAN | AppInboxType.GROUP_MEMBER_UNBAN;
    operation: 'banGroupMember' | 'unbanGroupMember';
    requestId: string;
    status: 'banned' | 'left';
  }>,
): OperationMatrixCase {
  return {
    type: input.type,
    operation: input.operation,
    authority: input.harness.sessions.owner,
    data: {
      scope: SCOPE,
      groupId: input.groupId,
      principalId: 'charlie',
      request: { ...input.ownerActor, requestId: input.requestId },
    } satisfies GroupMemberBanAppInboxPayload | GroupMemberUnbanAppInboxPayload,
    assertDomain: async () => {
      expect(
        (
          await input.harness.repository.readSnapshot({
            ...SCOPE,
            groupId: input.groupId,
          })
        )?.members.find((member) => member.principalId === 'charlie'),
      ).toMatchObject({ status: input.status });
    },
  };
}

export async function readMatrixMember(
  harness: AuthorityHarness,
  groupId: string,
  principalId: string,
) {
  const snapshot = await harness.repository.readSnapshot({ ...SCOPE, groupId });
  return snapshot?.members.find((member) => member.principalId === principalId);
}

export async function readMatrixPresenceSession(
  harness: AuthorityHarness,
  groupId: string,
  sessionId: string,
) {
  return await harness.repository.findPresenceSession({ ...SCOPE, groupId, sessionId });
}

export function listRoomEvents(harness: AuthorityHarness, groupId: string) {
  return harness.repository.listEvents({ ...SCOPE, groupId });
}

export async function runOperationMatrix(
  harness: AuthorityHarness,
  groupId: string,
  cases: readonly OperationMatrixCase[],
): Promise<void> {
  const read = vi.spyOn(harness.groupStateService, 'read');
  const compute = vi.spyOn(harness.groupStateService, 'compute');
  const validate = vi.spyOn(harness.groupStateService, 'validate');
  const write = vi.spyOn(harness.groupStateService, 'write');
  const observeSnapshot = vi.spyOn(
    harness.groupStateService as GroupStateService &
      Readonly<{
        observeSnapshot(snapshot: GroupSnapshot): Promise<GroupSnapshot>;
      }>,
    'observeSnapshot',
  );
  const authorityRead = vi.spyOn(harness.authSessions, 'findBySessionId');
  for (const testCase of cases) {
    read.mockClear();
    compute.mockClear();
    validate.mockClear();
    write.mockClear();
    authorityRead.mockClear();
    const previousOutboxCount = harness.database.outboxEntries.size;
    const requestId = (testCase.data as { request: { requestId: string } }).request.requestId;
    const result = await processAuthenticated(harness.service, harness.reader, testCase.authority, {
      type: testCase.type,
      resourceId: requestId,
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
      senderId: testCase.authority.clientId,
      data: testCase.data,
    });

    expect(result.right, `${testCase.operation} result`).toBeDefined();
    expect(read).toHaveBeenCalledOnce();
    expect(compute).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(authorityRead).toHaveBeenCalled();
    const command = read.mock.calls[0]?.[0];
    expect(command?.command.operation).toBe(testCase.operation);
    expect(command?.facts).toMatchObject({
      attemptCount: 1,
      serviceId: 'server-12345678',
      internalAuthority: 'none',
      authenticatedAuthority: {
        principalId: testCase.authority.clientId,
        sessionId: testCase.authority.sessionId,
      },
    });
    expect(command?.facts.eventId).toMatch(/^group-event:/u);
    expect(command?.facts.commandHash).toMatch(/^sha256:/u);
    expect(harness.database.outboxEntries.size).toBe(previousOutboxCount + 1);
    expect(
      harness
        .queueEntries()
        .some(
          (entry) => entry.status === EntityStatus.COMPLETED && entry.dequeueAudit.attempts === 1,
        ),
    ).toBe(true);
    await testCase.assertDomain();
  }
  await vi.waitFor(() => expect(observeSnapshot).toHaveBeenCalledTimes(cases.length));
}

export async function createAuthorityHarness(
  principalIds: readonly string[],
  options: Readonly<{ wakeQueue?: () => void }> = {},
): Promise<AuthorityHarness> {
  const nowEpochMs = Date.now();
  const runtimeRepository = new FakeRuntimeStateRepository();
  const authSessions = new AuthSessionRepository(runtimeRepository);
  const sessions = Object.fromEntries(
    principalIds.map((principalId) => [
      principalId,
      authSession({
        clientId: principalId,
        sessionId: `${principalId}-session`,
        accessToken: `${principalId}-token`,
        nowEpochMs,
      }),
    ]),
  );
  for (const session of Object.values(sessions)) {
    await authSessions.putSession(session);
  }
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
  const groupStateService = createGroupStateService({
    runtimeRepository,
    createGroupStateEventStore: () => database.groupEventStore,
    serviceId: 'server-12345678',
    now: () => nowEpochMs,
    authSessionRepository: authSessions,
  } as Parameters<typeof createGroupStateService>[0] &
    Readonly<{
      authSessionRepository: AuthSessionRepository;
    }>);
  return {
    nowEpochMs,
    runtimeRepository,
    repository: new GroupStateRepository(runtimeRepository, { events: database.groupEventStore }),
    authSessions,
    groupStateService,
    service: createAuthorityAppInboxService({
      reader,
      queue,
      results,
      database,
      groupStateService,
      wakeQueue: options.wakeQueue,
    }),
    database,
    reader,
    queue,
    results,
    sessions,
    queueEntries: () => [
      ...(queue as unknown as { data: Map<string, ResourceEntry> }).data.values(),
    ],
  };
}

interface AuthorityAppInboxServiceInput {
  readonly reader: InboxQueueReader;
  readonly queue: TestResourceInbox;
  readonly results: TestResourceInboxResults;
  readonly database: AppInboxTestDatabase;
  readonly groupStateService: GroupStateService;
  readonly wakeQueue?: () => void;
}

function createAuthorityAppInboxService(
  input: AuthorityAppInboxServiceInput,
): AppGroupInboxService {
  return new AppGroupInboxService(
    input.reader,
    input.queue as never,
    input.results as never,
    input.database,
    input.groupStateService,
    'server-12345678',
    undefined,
    undefined,
    input.wakeQueue,
  );
}

export async function createRoom(
  harness: AuthorityHarness,
  groupId: string,
  displayName: string,
): Promise<GroupStateWritten> {
  const owner = harness.sessions.owner;
  const created = await processAuthenticated<GroupCreateAppInboxPayload, GroupStateWritten>(
    harness.service,
    harness.reader,
    owner,
    {
      type: AppInboxType.GROUP_CREATE,
      resourceId: `create-${groupId}`,
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
      senderId: owner.clientId,
      data: {
        scope: SCOPE,
        request: {
          groupId,
          displayName,
          kind: 'room',
          joinMode: 'open',
          createdByPrincipalId: owner.clientId,
          actorPrincipalId: owner.clientId,
          actorSessionId: owner.sessionId,
          requestId: `create-${groupId}`,
        },
      },
    },
  );
  expect(created.right?.status).toBe('created');
  if (!created.right) throw new Error('Expected authenticated group creation result');
  return created.right;
}

export async function processAuthenticated<V, R>(
  service: AppGroupInboxService,
  reader: InboxQueueReader,
  authority: IssuedAuthSession,
  input: AppInboxEnqueueInput<V>,
): Promise<Either<string, R>> {
  const pending = authenticatedProcessor<V, R>(service)(input, authority);
  const outcome = await Promise.race([
    pending.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    waitForQueueEntry(reader.inbox as unknown as InMemoryQueueBox).then(() => 'queued' as const),
  ]);
  if (outcome === 'queued') {
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
  }
  return await pending;
}

export function authenticatedProcessor<V, R>(
  service: AppGroupInboxService,
): (enqueue: AppInboxEnqueueInput<V>, authority: IssuedAuthSession) => Promise<Either<string, R>> {
  return service.processAuthenticatedEntryUntilCompletion.bind(service) as unknown as (
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
  ) => Promise<Either<string, R>>;
}

export async function waitForQueueEntry(queue: InMemoryQueueBox): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const data = (
      queue as unknown as {
        data: Map<string, ResourceEntry>;
      }
    ).data;
    if (data.size > 0 && [...data.values()].some((entry) => entry.status === EntityStatus.NEW)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Expected authenticated app inbox entry to be enqueued');
}

export function createResilience(): ResilienceDto {
  const duration = Temporal.Duration.from({ seconds: 10 });
  return ResilienceDto.toResilienceDto(
    new CircuitBreakerPolicy(10, duration, duration, duration),
    1,
    10,
    1,
    1,
  );
}
