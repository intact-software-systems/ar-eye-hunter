import { Temporal } from '@js-temporal/polyfill';
import { vi } from 'vitest';

import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
  EntityStatus,
  isExpiredResourceEntry,
  type Key,
  type ResourceEntry,
  toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
  AuthSessionRepository,
  type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
// prettier-ignore
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/repositories/\
StateEventStore.ts';
import {
  AppClientInboxService,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import {
  type ClientMutationWritten,
  type ClientStateService,
  type ClientStateWritten,
  createClientStateService,
} from '@shared-server/rallar-system/services/client-state-service.ts';
// prettier-ignore
import {
  createWsSessionGenerationLifecycleService,
} from '@shared-server/rallar-system/services/ws-session-generation-lifecycle.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

export const CLIENT_STATE_TEST_SCOPE: StateScope = {
  applicationId: 'ar-eye-hunter',
  workspaceId: 'default',
};
const TEST_AUTHORITIES = new WeakMap<AppClientInboxService, Map<string, IssuedAuthSession>>();

export class TestResourceInbox extends InMemoryQueueBox {
  async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
    const entry = await this.getItem(key);
    return entry !== undefined && statuses.includes(entry.status);
  }
}
export function requireRightSnapshot(result: Either<string, ClientStateWritten>): ClientSnapshot {
  if (!result.right) {
    throw new Error(result.left ?? 'Expected client app-inbox right result');
  }

  return requireClientStateWrittenSnapshot(result.right);
}

export function requireRightWritten(
  result: Either<string, ClientStateWritten>,
): ClientMutationWritten {
  if (!result.right) {
    throw new Error(result.left ?? 'Expected client app-inbox right result');
  }

  return requireClientMutationWritten(result.right);
}

function requireClientStateWrittenSnapshot(written: ClientStateWritten): ClientSnapshot {
  return requireClientMutationWritten(written).snapshot;
}

function requireClientMutationWritten(written: ClientStateWritten): ClientMutationWritten {
  const result = written.result as
    | ClientStateWritten['result']
    | {
        left?: string;
        right?: ClientMutationWritten;
      };

  if ('fold' in result && typeof result.fold === 'function') {
    return result.fold(
      (error) => {
        throw new Error(error);
      },
      (value) => value,
    );
  }

  if (result.right) {
    return result.right;
  }

  throw new Error(result.left ?? 'Client mutation failed');
}

export class TestResourceInboxResults {
  private readonly data = new Map<string, ResourceEntry>();

  async replace(entry: ResourceEntry): Promise<ResourceEntry> {
    this.data.set(toKeyAsString(entry.key), entry);
    return entry;
  }

  async writeIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry> {
    const key = toKeyAsString(entry.key);
    const existing = this.data.get(key);
    if (existing !== undefined && !isExpiredResourceEntry(existing)) {
      return existing;
    }

    this.data.set(key, entry);
    return entry;
  }

  async findByKey(key: Key): Promise<ResourceEntry | undefined> {
    const entry = this.data.get(toKeyAsString(key));
    return entry === undefined || isExpiredResourceEntry(entry) ? undefined : entry;
  }
}

export async function processAppInbox<V, R>(
  service: AppClientInboxService,
  reader: InboxQueueReader,
  input: {
    type: AppInboxType;
    topicId?: string;
    resourceId?: string;
    contextId?: string;
    senderId?: string;
    data: V;
  },
): Promise<Either<string, R>> {
  const resultPromise = service.processAuthenticatedEntryUntilCompletion<V, R>(
    input,
    toTestIssuedAuthority(service, input),
  );
  await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

  return await resultPromise;
}

function toTestIssuedAuthority<V>(
  service: AppClientInboxService,
  input: Readonly<{
    senderId?: string;
    data: V;
  }>,
): IssuedAuthSession {
  const data =
    typeof input.data === 'object' && input.data !== null
      ? Object.fromEntries(Object.entries(input.data))
      : {};
  const request =
    typeof data.request === 'object' && data.request !== null
      ? Object.fromEntries(Object.entries(data.request))
      : {};
  const principalId =
    typeof data.principalId === 'string' ? data.principalId : (input.senderId ?? 'alice');
  const sessionId =
    typeof data.sessionId === 'string'
      ? data.sessionId
      : typeof request.actorSessionId === 'string'
        ? request.actorSessionId
        : `${principalId}-test-authority-session`;
  let authorities = TEST_AUTHORITIES.get(service);
  if (!authorities) {
    authorities = new Map();
    TEST_AUTHORITIES.set(service, authorities);
  }
  const key = `${principalId}:${sessionId}`;
  const existing = authorities.get(key);
  if (existing) return existing;
  const created = issuedSession(principalId, sessionId);
  authorities.set(key, created);
  return created;
}

export async function processAuthenticatedClientMutation<V, R = ClientStateWritten>(
  service: AppClientInboxService,
  input: {
    type: AppInboxType;
    topicId?: string;
    resourceId?: string;
    contextId?: string;
    senderId?: string;
    data: V;
  },
  authority: IssuedAuthSession,
): Promise<Either<string, R>> {
  return await service.processAuthenticatedEntryUntilCompletion<V, R>(input, authority);
}

export function issuedSession(clientId: string, sessionId: string): IssuedAuthSession {
  const nowEpochMs = Date.now();
  return {
    clientId,
    accessToken: `${clientId}-token`,
    username: clientId,
    sessionId,
    issuedAtEpochMs: nowEpochMs - 1_000,
    expiresAtEpochMs: nowEpochMs + 60_000,
  };
}

async function waitForQueueEntryStatus(
  queue: InMemoryQueueBox,
  status: EntityStatus,
): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if ((await readEntries(queue)).some((entry) => entry.status === status)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Expected app inbox entry with status ${status}`);
}

export async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
  const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));

  return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

export function createClientStateServiceStub(
  overrides: Partial<ClientStateService> = {},
): ClientStateService {
  return {
    sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(
      new FakeRuntimeStateRepository(),
    ),
    formationDamping: 'damped',
    listSnapshots: vi.fn(),
    readSnapshot: vi.fn(),
    readPresenceSnapshot: vi.fn(),
    listEvents: vi.fn(),
    listEventPage: vi.fn(),
    read: vi.fn(),
    compute: vi.fn(),
    validate: vi.fn(),
    write: vi.fn(),
    listExpiredSessionCandidates: vi.fn(async () => []),
    findSessionBySessionId: vi.fn(),
    readIssuedAuthSession: vi.fn(),
    observeSnapshot: vi.fn(async (snapshot) => snapshot),
    ...overrides,
  };
}

export function createAutoAuthorizingClientStateService(
  runtimeRepository: FakeRuntimeStateRepository,
  database: ReturnType<typeof createAppInboxTestDatabase>,
  eventStore: InMemoryClientStateEventStore = database.clientEventStore,
): ClientStateService {
  const authSessions = new AuthSessionRepository(runtimeRepository);
  const durable = createClientStateService({
    runtimeRepository,
    formationDamping: 'damped',
    createClientStateEventStore: () => eventStore,
    serviceId: 'server-12345678',
  });
  return {
    ...durable,
    read: async (command) => {
      if (command.authority.kind === 'issued-session') {
        const existing = await authSessions.findBySessionId(command.authority.sessionId);
        if (!existing) {
          await authSessions.putSession({
            clientId: command.authority.principalId,
            accessToken: `${command.authority.sessionId}-test-token`,
            username: command.authority.principalId,
            sessionId: command.authority.sessionId,
            issuedAtEpochMs: command.authority.sessionIssuedAtEpochMs,
            expiresAtEpochMs: command.authority.sessionExpiresAtEpochMs,
          });
        }
      }
      return await durable.read(command);
    },
  };
}

export function createPublisher() {
  return {
    publishClientSnapshot: vi.fn(async () => undefined),
    publishClientEvent: vi.fn(async () => undefined),
    publishGroupSnapshot: vi.fn(async () => undefined),
    publishGroupEvent: vi.fn(async () => undefined),
  };
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
