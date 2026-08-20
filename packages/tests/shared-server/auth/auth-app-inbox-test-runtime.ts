import { Temporal } from '@js-temporal/polyfill';
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
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
// prettier-ignore
import { createAuthMutationService } from '@shared-server/rallar-system/auth/\
auth-mutation-service.ts';
// prettier-ignore
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/\
auth-credential-issuer.ts';
// prettier-ignore
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/\
app-auth-inbox-service.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import type {
  AppInboxTestDatabase,
  AppInboxTestDatabaseOptions,
} from '../app-inbox-test-database-contracts.ts';
import type { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

export interface AuthInboxTestHarness {
  readonly queue: TestResourceInbox;
  readonly results: TestResourceInboxResults;
  readonly reader: InboxQueueReader;
  readonly service: AppAuthInboxService;
}

export interface AuthInboxTestRuntime extends AuthInboxTestHarness {
  readonly credentialIssuer: ReturnType<typeof createHmacAuthCredentialIssuer>;
  readonly database: AppInboxTestDatabase;
}

interface CreateAuthInboxTestRuntimeInput {
  readonly runtimeRepository: FakeRuntimeStateRepository;
  readonly serviceId: string;
  readonly credentialSecret: string;
  readonly databaseOptions?: AppInboxTestDatabaseOptions;
}

interface RunAuthInboxCommandInput<Result, P extends Promise<Either<AppInboxFailure, Result>>> {
  readonly pending: P;
  readonly queue: InMemoryQueueBox;
  readonly reader: InboxQueueReader;
  readonly minimumEntries?: number;
}

export class TestResourceInbox extends InMemoryQueueBox {
  async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
    const entry = await this.getItem(key);
    return entry !== undefined && statuses.includes(entry.status);
  }
}

export class TestResourceInboxResults {
  private readonly data = new Map<string, ResourceEntry>();

  replace(entry: ResourceEntry): Promise<ResourceEntry> {
    this.data.set(toKeyAsString(entry.key), entry);
    return Promise.resolve(entry);
  }

  findByKey(key: Key): Promise<ResourceEntry | undefined> {
    const entry = this.data.get(toKeyAsString(key));
    return Promise.resolve(
      entry === undefined || isExpiredResourceEntry(entry) ? undefined : entry,
    );
  }

  allEntries(): ResourceEntry[] {
    return [...this.data.values()];
  }
}

export function createAuthInboxTestHarness(
  runtime: FakeRuntimeStateRepository,
  serviceId = 'auth-test-service',
): AuthInboxTestHarness {
  return createAuthInboxTestRuntime({
    runtimeRepository: runtime,
    serviceId,
    credentialSecret: `${serviceId}-secret-0123456789abcdef`,
  });
}

export function createAuthInboxTestRuntime({
  runtimeRepository,
  serviceId,
  credentialSecret,
  databaseOptions,
}: CreateAuthInboxTestRuntimeInput): AuthInboxTestRuntime {
  const queue = new TestResourceInbox();
  const results = new TestResourceInboxResults();
  const reader = new InboxQueueReader(queue);
  const credentialIssuer = createHmacAuthCredentialIssuer(credentialSecret);
  const database = createAppInboxTestDatabase(queue, results, {
    ...databaseOptions,
    runtimeRepository,
  });
  const service = new AppAuthInboxService(
    {
      inboxQueueReader: reader,
      resourceInboxRepository: queue,
      resourceInboxResultsRepository: results,
      database: database,
      authMutationService: createAuthMutationService({ runtimeRepository, serviceId }),
      credentialIssuer: credentialIssuer,
    },
    {
      serviceId: serviceId,
    },
  );
  return { queue, results, reader, service, credentialIssuer, database };
}

export function createAuthInboxTestResilience(firstRetryDelayMs?: number): ResilienceDto {
  const duration = Temporal.Duration.from({ seconds: 10 });
  const args = [new CircuitBreakerPolicy(10, duration, duration, duration), 1, 10, 1, 1] as const;
  if (firstRetryDelayMs === undefined) {
    return ResilienceDto.toResilienceDto(...args);
  }
  return ResilienceDto.toResilienceDto(...args, 10, {
    maxAttempts: 20,
    delaysAfterAttemptMs: [firstRetryDelayMs],
    maxDelayMs: firstRetryDelayMs,
    jitterRatio: 0,
    staleDueThresholdMs: 30_000,
  });
}

export async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
  const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));
  return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

export async function waitForAuthInboxEntry(
  queue: InMemoryQueueBox,
  minimumEntries = 1,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await queue.getAllKeys()).length >= minimumEntries) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Auth AppInbox test entry was not enqueued');
}

export async function runAuthInboxCommand<
  Result,
  P extends Promise<Either<AppInboxFailure, Result>>,
>({
  pending,
  queue,
  reader,
  minimumEntries = 1,
}: RunAuthInboxCommandInput<Result, P>): Promise<Awaited<P>> {
  await waitForAuthInboxEntry(queue, minimumEntries);
  await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAuthInboxTestResilience());
  return await pending;
}

export const createResilience = createAuthInboxTestResilience;
export const waitForQueuedEntry = waitForAuthInboxEntry;
export const runAuthCommand = runAuthInboxCommand;
