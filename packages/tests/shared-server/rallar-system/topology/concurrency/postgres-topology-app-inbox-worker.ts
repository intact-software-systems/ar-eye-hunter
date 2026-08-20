import postgres from 'postgres';

import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
// prettier-ignore
import type {
  GroupTopologyConfigMutationReceipt,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
  fromCanonicalGroupTopologyConfigPatch,
  toCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
// prettier-ignore
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
// prettier-ignore
import type {
  GroupTopologyConfigMutationExecution,
} from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import {
  type AppInboxFailure,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
// prettier-ignore
import type {
  JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import {
  requireExactKeys,
  requireExactOptionalKeys,
  requireOneOf,
  requireString,
} from '@shared-server/rallar-system/services/exact-object-codec.ts';
// prettier-ignore
import {
  toTopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
// prettier-ignore
import {
  createPostgresAppInboxWorkerRuntime,
  type PostgresAppInboxWorkerRuntime,
  type PostgresAppInboxWorkerTrace,
  type TopologyReadBarrierPrimitive,
  waitForPostgresWorkerBarrier,
  type WorkerBarrier,
} from '../../../fixtures/postgres-app-inbox-worker-runtime.ts';
import { toPSqlSql } from '../../../fixtures/postgres-sql-adapter.ts';

interface WorkerInput {
  readonly command: 'put-config' | 'put-override';
  readonly barrierPhase: 'topology-read' | 'transaction';
  readonly groupRef: GroupRef;
  readonly atEpochMs: number;
  readonly traceFilePath: string;
  readonly barrier: WorkerBarrier;
  readonly request: Readonly<{
    requestId: string;
    updatedByPrincipalId: string;
    config: GroupTopologyConfigPatch;
    expiresAtEpochMs?: number;
  }>;
}

interface WorkerOutput {
  readonly requestId: string;
  readonly status: 'applied' | 'rejected';
  readonly attemptCount: number;
  readonly acceptedVersion: number | null;
  readonly outboxIds: readonly string[];
  readonly receipt: GroupTopologyConfigMutationReceipt | null;
  readonly failure: AppInboxFailure | null;
}

type WorkerResult = Either<AppInboxFailure, GroupTopologyConfigMutationExecution>;

type TopologyAppInboxWorkerTrace = PostgresAppInboxWorkerTrace & {
  backendPid: number;
  topologyReadBarrierPrimitive: TopologyReadBarrierPrimitive | null;
};

async function main(): Promise<void> {
  const databaseUrl = Deno.env.get('DATABASE_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const input = readInput();
  const postgresSql = postgres(databaseUrl, { max: 2, idle_timeout: 1 });
  const sql = toPSqlSql(postgresSql);
  const [{ pid }] = await sql<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
  const trace: TopologyAppInboxWorkerTrace = {
    backendPid: pid,
    barrierWaitCount: 0,
    topologyReadBarrierPrimitive: null,
    attempts: [],
  };
  try {
    console.log(JSON.stringify(await runWorker(input, sql, trace)));
  } finally {
    await Deno.writeTextFile(input.traceFilePath, JSON.stringify(trace));
    await postgresSql.end();
  }
}

async function runWorker(
  input: WorkerInput,
  sql: PSqlSql,
  trace: TopologyAppInboxWorkerTrace,
): Promise<WorkerOutput> {
  const authority = createWorkerAuthority(input);
  const runtime = createTopologyAppInboxRuntime(input, sql, trace);
  await runtime.authSessions.putSession(authority);
  const result = await writeTopologyAppInboxCommand(runtime, input, authority);
  const attemptCount = await readRequestAttemptCount(sql, input.request.requestId);
  return toWorkerOutput(input.request.requestId, result, attemptCount);
}

function createWorkerAuthority(input: WorkerInput): IssuedAuthSession {
  const principalId = input.request.updatedByPrincipalId;
  return {
    clientId: principalId,
    accessToken: `${input.request.requestId}-token`,
    username: principalId,
    sessionId: `${input.request.requestId}-session`,
    issuedAtEpochMs: 0,
    expiresAtEpochMs: 4_102_444_800_000,
  };
}

function createTopologyAppInboxRuntime(
  input: WorkerInput,
  sql: PSqlSql,
  trace: TopologyAppInboxWorkerTrace,
): PostgresAppInboxWorkerRuntime {
  return createPostgresAppInboxWorkerRuntime({
    sql,
    serviceId: `postgres-topology-inbox-${Deno.pid}`,
    atEpochMs: input.atEpochMs,
    barrier: input.barrierPhase === 'transaction' ? input.barrier : undefined,
    beforeTopologyConfigRead: input.barrierPhase === 'topology-read'
      ? async (primitive) => {
        trace.topologyReadBarrierPrimitive = primitive;
        await waitForPostgresWorkerBarrier(
          input.barrier,
          `postgres-topology-inbox-${Deno.pid}`,
        );
      }
      : undefined,
    trace,
  });
}

async function writeTopologyAppInboxCommand(
  runtime: PostgresAppInboxWorkerRuntime,
  input: WorkerInput,
  authority: IssuedAuthSession,
): Promise<WorkerResult> {
  const principalId = input.request.updatedByPrincipalId;
  const data = await toTopologyAppInboxCommand({
    actor: { principalId, sessionId: authority.sessionId },
    groupRef: input.groupRef,
    requestId: input.request.requestId,
    capturedAtEpochMs: input.atEpochMs,
    payload: input.command === 'put-config'
      ? { operation: 'putConfig', config: input.request.config }
      : {
        operation: 'putOverride',
        config: input.request.config,
        ttlMs: null,
        expiresAtEpochMs: input.request.expiresAtEpochMs ?? input.atEpochMs + 60_000,
      },
  });
  runtime.armBarrier();
  const result = await runtime.runUntilCompletion(() =>
    runtime.group.processAuthenticatedTopologyEntryUntilCompletionResult(
      {
        type: input.command === 'put-config'
          ? AppInboxType.TOPOLOGY_CONFIG_PUT
          : AppInboxType.TOPOLOGY_OVERRIDE_PUT,
        resourceId: input.request.requestId,
        contextId: [
          input.groupRef.applicationId,
          input.groupRef.workspaceId,
          input.groupRef.groupId,
        ]
          .map(encodeURIComponent)
          .join(':'),
        senderId: principalId,
        data,
      },
      authority,
    )
  );
  return result.mapRight((value) => {
    if (!('receipt' in value)) {
      throw new TypeError('Expected topology config mutation result');
    }
    return value;
  });
}

async function readRequestAttemptCount(sql: PSqlSql, requestId: string): Promise<number> {
  const requestResourceId = toAppQueueKey({
    resourceId: requestId,
    topicId: '',
    contextId: '',
  }).resourceId;
  const [attemptRow] = await sql<Array<{ attemptCount: number }>>`
    select ri_attempts::int as "attemptCount"
    from resource_inbox
    where ri_resource_id = ${requestResourceId}
  `;
  if (!attemptRow) {
    throw new Error(`Topology AppInbox row is absent: ${requestId}`);
  }
  return attemptRow.attemptCount;
}

function toWorkerOutput(
  requestId: string,
  result: WorkerResult,
  attemptCount: number,
): WorkerOutput {
  return result.fold<WorkerOutput>(
    (failure) => ({
      requestId,
      status: 'rejected',
      attemptCount,
      acceptedVersion: null,
      outboxIds: [],
      receipt: null,
      failure,
    }),
    (execution) => ({
      requestId,
      status: 'applied',
      attemptCount: execution.receipt.attemptCount,
      acceptedVersion: execution.receipt.acceptedVersion,
      outboxIds: execution.receipt.outboxIds,
      receipt: execution.receipt,
      failure: null,
    }),
  );
}

function readInput(): WorkerInput {
  const raw = Deno.env.get('RALLAR_TOPOLOGY_CONCURRENCY_WORKER_INPUT');
  if (!raw) throw new Error('RALLAR_TOPOLOGY_CONCURRENCY_WORKER_INPUT is required');
  const parsed: JsonWireValue = JSON.parse(raw);
  return decodeWorkerInput(parsed);
}

function decodeWorkerInput(value: JsonWireValue): WorkerInput {
  const input = requireWorkerRecord(value, 'Topology concurrency worker input');
  requireExactKeys(
    input,
    ['command', 'barrierPhase', 'groupRef', 'atEpochMs', 'traceFilePath', 'barrier', 'request'],
    'Topology concurrency worker input',
  );
  const request = requireWorkerRecord(input.request, 'Topology concurrency worker request');
  requireExactOptionalKeys(
    request,
    ['requestId', 'updatedByPrincipalId', 'config'],
    ['expiresAtEpochMs'],
    'Topology concurrency worker request',
  );
  requireString(input.traceFilePath, 'Topology concurrency worker traceFilePath');
  requireString(request.requestId, 'Topology concurrency worker requestId');
  requireString(request.updatedByPrincipalId, 'Topology concurrency worker updatedByPrincipalId');
  return {
    command: requireOneOf(
      input.command,
      ['put-config', 'put-override'] as const,
      'Topology concurrency worker command',
    ),
    barrierPhase: requireOneOf(
      input.barrierPhase,
      ['topology-read', 'transaction'] as const,
      'Topology concurrency worker barrierPhase',
    ),
    groupRef: decodeGroupRef(input.groupRef),
    atEpochMs: requireWorkerEpoch(input.atEpochMs, 'Topology concurrency worker atEpochMs'),
    traceFilePath: input.traceFilePath,
    barrier: decodeWorkerBarrier(input.barrier),
    request: {
      requestId: request.requestId,
      updatedByPrincipalId: request.updatedByPrincipalId,
      config: fromCanonicalGroupTopologyConfigPatch(
        toCanonicalGroupTopologyConfigPatch(request.config),
      ),
      ...(request.expiresAtEpochMs === undefined ? {} : {
        expiresAtEpochMs: requireWorkerEpoch(
          request.expiresAtEpochMs,
          'Topology concurrency worker expiresAtEpochMs',
        ),
      }),
    },
  };
}

function decodeGroupRef(value: JsonWireValue): GroupRef {
  const groupRef = requireWorkerRecord(value, 'Topology concurrency worker groupRef');
  requireExactKeys(
    groupRef,
    ['applicationId', 'workspaceId', 'groupId'],
    'Topology concurrency worker groupRef',
  );
  requireString(groupRef.applicationId, 'Topology concurrency worker applicationId');
  requireString(groupRef.workspaceId, 'Topology concurrency worker workspaceId');
  requireString(groupRef.groupId, 'Topology concurrency worker groupId');
  return {
    applicationId: groupRef.applicationId,
    workspaceId: groupRef.workspaceId,
    groupId: groupRef.groupId,
  };
}

function decodeWorkerBarrier(value: JsonWireValue): WorkerBarrier {
  const barrier = requireWorkerRecord(value, 'Topology concurrency worker barrier');
  requireExactKeys(
    barrier,
    ['readyDirectoryPath', 'releaseFilePath'],
    'Topology concurrency worker barrier',
  );
  requireString(
    barrier.readyDirectoryPath,
    'Topology concurrency worker barrier readyDirectoryPath',
  );
  requireString(barrier.releaseFilePath, 'Topology concurrency worker barrier releaseFilePath');
  return {
    readyDirectoryPath: barrier.readyDirectoryPath,
    releaseFilePath: barrier.releaseFilePath,
  };
}

function requireWorkerEpoch(value: JsonWireValue, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function requireWorkerRecord(
  value: JsonWireValue,
  label: string,
): Readonly<Record<string, JsonWireValue>> {
  if (!isWorkerRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function isWorkerRecord(value: JsonWireValue): value is Readonly<Record<string, JsonWireValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

await main();
