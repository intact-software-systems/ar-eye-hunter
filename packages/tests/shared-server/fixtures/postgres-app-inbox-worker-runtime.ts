import { Temporal } from '@js-temporal/polyfill';
import type { StateScope } from '@shared/api/state-types.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
// prettier-ignore
import type {
  ResourceInboxAttemptReleaseTelemetry,
} from '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
// prettier-ignore
import type {
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
// prettier-ignore
import type {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
// prettier-ignore
import type {
  AuthSessionRepository,
  IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
// prettier-ignore
import type {
  GroupStateInboxDurableResult,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
// prettier-ignore
import {
  isAuthenticatedGroupMutationEnqueue,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
// prettier-ignore
import type {
  AppClientInboxService,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
// prettier-ignore
import type {
  AppGroupInboxService,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
// prettier-ignore
import type {
  JsonWireObject,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';

import { createPostgresAppInboxWorkerServices } from './postgres-app-inbox-worker-services.ts';

export interface WorkerBarrier {
  readonly readyDirectoryPath: string;
  readonly releaseFilePath: string;
}

export interface PersistedAppInboxAttempt {
  readonly resourceId: string;
  readonly attempt: number;
  readonly classification: ResourceInboxAttemptReleaseTelemetry['classification'];
  readonly status: ResourceInboxAttemptReleaseTelemetry['status'];
  readonly retryDelayMs: number;
}

type RetriedAppInboxAttempt = Readonly<
  Pick<PersistedAppInboxAttempt, 'resourceId' | 'attempt' | 'classification' | 'retryDelayMs'>
>;

export interface FindRetriedAppInboxAttemptSequenceInput {
  readonly traces: readonly Readonly<{
    attempts: readonly RetriedAppInboxAttempt[];
  }>[];
  readonly ownedResourceIds: readonly string[];
}

export interface PostgresAppInboxWorkerTrace {
  barrierWaitCount: number;
  attempts: PersistedAppInboxAttempt[];
}

export type TopologyReadBarrierPrimitive = 'readRuntimeStateBatch';

export interface PostgresAppInboxWorkerRuntime {
  readonly client: AppClientInboxService;
  readonly group: AppGroupInboxService;
  readonly authSessions: AuthSessionRepository;
  readonly resourceInbox: ResourceInboxRepository;
  readonly resourceInboxResults: ResourceInboxResultsRepository;
  armBarrier(): void;
  runUntilCompletion<R>(start: () => Promise<R>): Promise<R>;
  runUntilAllCompletion<R>(starts: readonly (() => Promise<R>)[]): Promise<readonly R[]>;
}

export type AuthenticatedGroupAppInboxData = JsonWireObject &
  Readonly<{
    scope: StateScope;
    groupId: string;
    request: JsonWireObject & Readonly<{ requestId: string }>;
  }>;

export interface GroupAppInboxMutationInput {
  readonly runtime: PostgresAppInboxWorkerRuntime;
  readonly authority: IssuedAuthSession;
  readonly type: AppInboxType;
  readonly data: AuthenticatedGroupAppInboxData;
}

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

export function groupAppInboxStart(
  input: GroupAppInboxMutationInput,
): () => Promise<Either<string, GroupStateInboxDurableResult>> {
  const enqueue = {
    type: input.type,
    resourceId: input.data.request.requestId,
    contextId: [input.data.scope.applicationId, input.data.scope.workspaceId, input.data.groupId]
      .map(encodeURIComponent)
      .join(':'),
    senderId: input.authority.clientId,
    data: input.data,
  };
  if (!isAuthenticatedGroupMutationEnqueue(enqueue)) {
    throw new TypeError(`Authenticated group mutation type is required: ${input.type}`);
  }
  return () =>
    input.runtime.group.processAuthenticatedGroupEntryUntilCompletion(enqueue, input.authority);
}

export async function runGroupAppInbox(
  input: GroupAppInboxMutationInput,
): Promise<GroupStateInboxDurableResult> {
  return unwrapAppInboxResult(await input.runtime.runUntilCompletion(groupAppInboxStart(input)));
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

export async function waitForPostgresAppInboxWorkerParticipants<T>(
  readyDirectoryPath: string,
  participantCount: number,
  workerDone: readonly Promise<T>[],
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
    beforeTopologyConfigRead?: (primitive: TopologyReadBarrierPrimitive) => Promise<void>;
    beforeMutationTransaction?: () => Promise<void>;
    trace: PostgresAppInboxWorkerTrace;
  }>,
): PostgresAppInboxWorkerRuntime {
  const barrier = input.barrier;
  const transactionGate = createPostgresWorkerTransactionGate(
    input.sql,
    input.beforeMutationTransaction ??
      (barrier
        ? async () => await waitForPostgresWorkerBarrier(barrier, input.serviceId)
        : undefined),
    input.trace,
  );
  const services = createPostgresAppInboxWorkerServices({
    ...input,
    transactionSql: transactionGate.sql,
  });

  const runUntilAllCompletion = async <R>(
    starts: readonly (() => Promise<R>)[],
  ): Promise<readonly R[]> => {
    let settled = false;
    const pending = Promise.all(starts.map((start) => start())).finally(() => (settled = true));
    while (!settled) {
      await services.inbox.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createWorkerResilience(),
      );
      await yieldEventLoop();
    }
    return await pending;
  };

  return {
    client: services.client,
    group: services.group,
    authSessions: services.authSessions,
    resourceInbox: services.resourceInbox,
    resourceInboxResults: services.resourceInboxResults,
    armBarrier: transactionGate.arm,
    runUntilCompletion: async <R>(start: () => Promise<R>) => {
      const [result] = await runUntilAllCompletion([start]);
      if (result === undefined) {
        throw new TypeError('AppInbox worker completed without a result');
      }
      return result;
    },
    runUntilAllCompletion,
  };
}

export function createPostgresWorkerTransactionGate(
  sql: PSqlSql,
  beforeMutationTransaction: (() => Promise<void>) | undefined,
  trace: Pick<PostgresAppInboxWorkerTrace, 'barrierWaitCount'>,
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

export async function waitForPostgresWorkerBarrier(
  barrier: WorkerBarrier,
  participantId: string,
): Promise<void> {
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
