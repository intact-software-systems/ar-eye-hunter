import { Temporal } from '@js-temporal/polyfill';
import type { StateScope } from '@shared/api/state-types.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
  createClientStateEventRepository,
  createGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import { AppGroupInboxService } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

export type WorkerBarrier = Readonly<{
  readyDirectoryPath: string;
  releaseFilePath: string;
}>;

export type PersistedAppInboxAttempt = Readonly<{
  resourceId: string;
  attempt: number;
  classification: ResourceInboxAttemptReleaseTelemetry['classification'];
  status: ResourceInboxAttemptReleaseTelemetry['status'];
  retryDelayMs: number;
}>;

type RetriedAppInboxAttempt = Readonly<
  Pick<PersistedAppInboxAttempt, 'resourceId' | 'attempt' | 'classification' | 'retryDelayMs'>
>;

export interface FindRetriedAppInboxAttemptSequenceInput {
  readonly traces: readonly Readonly<{
    attempts: readonly RetriedAppInboxAttempt[];
  }>[];
  readonly ownedResourceIds: readonly string[];
}

export type PostgresAppInboxWorkerTrace = {
  barrierWaitCount: number;
  attempts: PersistedAppInboxAttempt[];
};

export type PostgresAppInboxWorkerRuntime = Readonly<{
  client: AppClientInboxService;
  group: AppGroupInboxService;
  authSessions: AuthSessionRepository;
  resourceInbox: ResourceInboxRepository;
  resourceInboxResults: ResourceInboxResultsRepository;
  armBarrier(): void;
  runUntilCompletion<R>(start: () => Promise<R>): Promise<R>;
  runUntilAllCompletion<R>(starts: readonly (() => Promise<R>)[]): Promise<readonly R[]>;
}>;

export type AuthenticatedGroupAppInboxData = Readonly<
  {
    scope: StateScope;
    groupId: string;
    request: Readonly<{ requestId: string } & Record<string, unknown>>;
  } & Record<string, unknown>
>;

export function createPostgresAppInboxTestAuthority(
  principalId: string,
  sessionId: string,
): IssuedAuthSession {
  return {
    clientId: principalId,
    accessToken: `${sessionId}-postgres-worker-token`,
    username: principalId,
    sessionId,
    issuedAtEpochMs: 0,
    expiresAtEpochMs: 4_102_444_800_000,
  };
}

export function createPostgresAppInboxWorkerTrace(): PostgresAppInboxWorkerTrace {
  return { barrierWaitCount: 0, attempts: [] };
}

export function groupAppInboxStart<R>(
  runtime: PostgresAppInboxWorkerRuntime,
  authority: IssuedAuthSession,
  type: AppInboxType,
  data: AuthenticatedGroupAppInboxData,
): () => Promise<Either<string, R>> {
  return () =>
    runtime.group.processAuthenticatedEntryUntilCompletion<AuthenticatedGroupAppInboxData, R>(
      {
        type,
        resourceId: data.request.requestId,
        contextId: [data.scope.applicationId, data.scope.workspaceId, data.groupId]
          .map(encodeURIComponent)
          .join(':'),
        senderId: authority.clientId,
        data,
      },
      authority,
    );
}

export async function runGroupAppInbox<R>(
  runtime: PostgresAppInboxWorkerRuntime,
  authority: IssuedAuthSession,
  type: AppInboxType,
  data: AuthenticatedGroupAppInboxData,
): Promise<R> {
  return unwrapAppInboxResult(
    await runtime.runUntilCompletion(groupAppInboxStart<R>(runtime, authority, type, data)),
  );
}

export function unwrapAppInboxResult<L, R>(result: Either<L, R>): R {
  return result.fold(
    (error) => {
      throw new Error(String(error));
    },
    (value) => value,
  );
}

export function findSingleRetriedAppInboxAttemptSequence(
  input: FindRetriedAppInboxAttemptSequenceInput,
): readonly RetriedAppInboxAttempt[] {
  const ownedResourceIds = new Set(input.ownedResourceIds);
  const attempts = input.traces
    .flatMap((trace) => trace.attempts)
    .filter((attempt) => ownedResourceIds.has(attempt.resourceId));
  const retried = attempts.filter((attempt) => attempt.classification === 'retryable');
  if (retried.length !== 1) {
    throw new Error(`Expected one retryable AppInbox attempt, found ${retried.length}`);
  }
  return attempts
    .filter((attempt) => attempt.resourceId === retried[0]!.resourceId)
    .sort((left, right) => left.attempt - right.attempt);
}

export async function waitForPostgresAppInboxWorkerParticipants(
  readyDirectoryPath: string,
  participantCount: number,
  workerDone: readonly Promise<unknown>[],
): Promise<void> {
  const waitForMarkers = async (): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        let markerCount = 0;
        for await (const _entry of Deno.readDir(readyDirectoryPath)) markerCount += 1;
        if (markerCount >= participantCount) return;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for AppInbox workers: ${readyDirectoryPath}`);
  };
  await Promise.race([
    waitForMarkers(),
    Promise.race(workerDone).then(() => {
      throw new Error(`AppInbox worker exited before barrier: ${readyDirectoryPath}`);
    }),
  ]);
}

export function createPostgresAppInboxWorkerRuntime(
  input: Readonly<{
    sql: PSqlSql;
    serviceId: string;
    atEpochMs: number;
    barrier?: WorkerBarrier;
    beforeMutationTransaction?: () => Promise<void>;
    trace: PostgresAppInboxWorkerTrace;
  }>,
): PostgresAppInboxWorkerRuntime {
  const runtimeRepository = new PSqlRuntimeStateRepository(input.sql);
  const authSessions = new AuthSessionRepository(runtimeRepository);
  const resourceInbox = new ResourceInboxRepository(input.sql);
  const inbox = new InboxQueueReader(new PSqlQueueBox(resourceInbox), {
    onAttemptReleaseTelemetry: (event) =>
      input.trace.attempts.push({
        resourceId: event.key.resourceId,
        attempt: event.attempt,
        classification: event.classification,
        status: event.status,
        retryDelayMs: event.retryDelayMs,
      }),
  });
  const results = new ResourceInboxResultsRepository(input.sql);
  const transactionGate = createTransactionGate(
    input.sql,
    input.beforeMutationTransaction ??
      (input.barrier
        ? async () => await waitAtBarrier(input.barrier!, input.serviceId)
        : undefined),
    input.trace,
  );
  const waitOptions = {
    nowEpochMs: () => input.atEpochMs,
    waitRetryIntervalMsecs: 1,
    waitMaxRetryIntervalMsecs: 5,
    waitJitterRatio: 0,
  } as const;
  const clientState = createClientStateService({
    runtimeRepository,
    createClientStateEventStore: createClientStateEventRepository,
    serviceId: input.serviceId,
  });
  const groupState = createGroupStateService({
    runtimeRepository,
    createGroupStateEventStore: createGroupStateEventRepository,
    authSessionRepository: authSessions,
    now: () => input.atEpochMs,
    serviceId: input.serviceId,
  });
  const client = new AppClientInboxService(
    inbox,
    resourceInbox,
    results,
    transactionGate.sql,
    clientState,
    input.serviceId,
    undefined,
    waitOptions,
  );
  const group = new AppGroupInboxService(
    inbox,
    resourceInbox,
    results,
    transactionGate.sql,
    groupState,
    input.serviceId,
    undefined,
    waitOptions,
  );
  group.setTopologyManagementService(
    new GroupTopologyManagementService({
      findGroupSnapshotByRef: (ref) => groupState.readSnapshot(ref),
      groupStateRepository: new GroupStateRepository(runtimeRepository),
      configRepository: new GroupTopologyConfigRepository(runtimeRepository),
      topologyService: new RallarRtcTopologyService(),
      now: () => input.atEpochMs,
      serviceId: input.serviceId,
    }),
  );

  const runUntilAllCompletion = async <R>(
    starts: readonly (() => Promise<R>)[],
  ): Promise<readonly R[]> => {
    let settled = false;
    const pending = Promise.all(starts.map((start) => start())).finally(() => (settled = true));
    while (!settled) {
      await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createWorkerResilience());
      await yieldEventLoop();
    }
    return await pending;
  };

  return {
    client,
    group,
    authSessions,
    resourceInbox,
    resourceInboxResults: results,
    armBarrier: transactionGate.arm,
    runUntilCompletion: async <R>(start: () => Promise<R>) =>
      (await runUntilAllCompletion([start]))[0]!,
    runUntilAllCompletion,
  };
}

function createTransactionGate(
  sql: PSqlSql,
  beforeMutationTransaction: (() => Promise<void>) | undefined,
  trace: PostgresAppInboxWorkerTrace,
): Readonly<{ sql: PSqlSql; arm(): void }> {
  let armed = false;
  let consumed = false;
  const gated = function <T>(
    stringsOrValues: TemplateStringsArray | readonly unknown[],
    ...values: unknown[]
  ): Promise<T> | unknown {
    return Array.isArray(stringsOrValues)
      ? sql(stringsOrValues)
      : sql<T>(stringsOrValues as TemplateStringsArray, ...values);
  } as PSqlSql;
  gated.begin = async <T>(write: (transaction: PSqlTransactionSql) => Promise<T>) => {
    if (armed && !consumed && beforeMutationTransaction) {
      consumed = true;
      trace.barrierWaitCount += 1;
      await beforeMutationTransaction();
    }
    return await sql.begin(write);
  };
  return { sql: gated, arm: () => (armed = true) };
}

function createWorkerResilience(): ResilienceDto {
  const duration = Temporal.Duration.from({ seconds: 10 });
  return ResilienceDto.toResilienceDto(
    new CircuitBreakerPolicy(100, duration, duration, duration),
    1,
    1,
    1,
    1,
  );
}

async function waitAtBarrier(barrier: WorkerBarrier, participantId: string): Promise<void> {
  await Deno.mkdir(barrier.readyDirectoryPath, { recursive: true });
  await Deno.writeTextFile(
    `${barrier.readyDirectoryPath}/${encodeURIComponent(participantId)}.json`,
    JSON.stringify({ workerPid: Deno.pid }),
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(barrier.releaseFilePath);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for worker barrier release: ${barrier.releaseFilePath}`);
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
