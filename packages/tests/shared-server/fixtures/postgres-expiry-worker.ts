import postgres from 'postgres';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
  BanGroupMemberRequest,
  ConnectClientSessionRequest,
  ConnectGroupPresenceSessionRequest,
  DisconnectClientSessionRequest,
  DisconnectGroupPresenceSessionRequest,
  HeartbeatClientSessionRequest,
  HeartbeatGroupPresenceSessionRequest,
  JoinGroupRequest,
  StateScope,
} from '@shared/api/state-types.ts';
import type {
  DeleteGroupTopologyConfigInput,
  GroupTopologyConfigMutationExecution,
  PutGroupTopologyConfigInput,
} from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  createClientStateRepository,
  createGroupStateRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import type { ClientMutationReceipt } from '@shared-server/rallar-system/services/client-state-mutations.ts';
import {
  type ClientStateWritten,
  toClientMutationCommand,
  toClientMutationIssuedSessionAuthority,
  toConnectCommandInput,
  toDisconnectCommandInput,
  toHeartbeatCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import { AppInboxType, SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC } from
  '@shared-server/rallar-system/services/AppInboxService.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { toTopologyAppInboxCommand } from
  '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  createPostgresAppInboxWorkerRuntime,
  type PersistedAppInboxAttempt,
} from './postgres-app-inbox-worker-runtime.ts';

type WorkerBarrier = Readonly<{
  readyDirectoryPath: string;
  releaseFilePath: string;
}>;

type WorkerCommandBase = Readonly<{
  scope: StateScope;
  atEpochMs: number;
  traceFilePath: string;
  barrier: WorkerBarrier;
}>;

type WorkerMutationRequest<T> = Omit<T, 'requestId'> & Readonly<{
  requestId: string;
}>;

type ClientWorkerInput =
  & WorkerCommandBase
  & Readonly<{
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
  }>
  & (
    | Readonly<{
      command: 'client-heartbeat';
      request: WorkerMutationRequest<HeartbeatClientSessionRequest>;
    }>
    | Readonly<{
      command: 'client-disconnect';
      request: WorkerMutationRequest<DisconnectClientSessionRequest>;
    }>
    | Readonly<{
      command: 'client-reconnect';
      request: WorkerMutationRequest<ConnectClientSessionRequest>;
    }>
  );

type GroupWorkerInput =
  & WorkerCommandBase
  & Readonly<{
    groupId: string;
  }>
  & (
    | Readonly<{
      command: 'group-join';
      request: WorkerMutationRequest<JoinGroupRequest>;
    }>
    | Readonly<{
      command: 'group-ban';
      targetPrincipalId: string;
      request: WorkerMutationRequest<BanGroupMemberRequest>;
    }>
    | Readonly<{
      command: 'group-presence-connect';
      sessionId: string;
      request: WorkerMutationRequest<ConnectGroupPresenceSessionRequest>;
    }>
    | Readonly<{
      command: 'group-presence-heartbeat';
      sessionId: string;
      request: WorkerMutationRequest<HeartbeatGroupPresenceSessionRequest>;
    }>
    | Readonly<{
      command: 'group-presence-disconnect';
      sessionId: string;
      request: WorkerMutationRequest<DisconnectGroupPresenceSessionRequest>;
    }>
  );

type TopologyWorkerInput =
  & Readonly<{
    groupRef: GroupRef;
    atEpochMs: number;
    traceFilePath: string;
    barrier: WorkerBarrier;
  }>
  & (
    | Readonly<{
      command: 'topology-config-put';
      request: WorkerMutationRequest<Omit<PutGroupTopologyConfigInput, 'groupRef'>>;
    }>
    | Readonly<{
      command: 'topology-config-delete';
      request: WorkerMutationRequest<Omit<DeleteGroupTopologyConfigInput, 'groupRef'>>;
    }>
  );

type StateMutationWorkerInput =
  | ClientWorkerInput
  | GroupWorkerInput
  | TopologyWorkerInput;

type CompactStateMutationWorkerOutput = Readonly<{
  operation: StateMutationWorkerInput['command'];
  requestId: string;
  commandHash: string;
  attemptCount: number;
  acceptedStorageRevision: number | null;
  acceptedCausalRevision: Readonly<Record<string, unknown>> | null;
  acceptedVersion: number | null;
  outboxIds: readonly string[];
  domainStatus: 'applied' | 'no-op' | 'rejected';
}>;

type WorkerTraceState = {
  backendPid: number;
  barrierWaitCount: number;
  attempts: PersistedAppInboxAttempt[];
};

async function main(): Promise<void> {
  const databaseUrl = Deno.env.get('DATABASE_URL');
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for postgres-expiry-worker');
  }

  const input = readInput();
  const sql = postgres(databaseUrl, { max: 2, idle_timeout: 1 });

  try {
    const [{ pid }] = await sql<{ pid: number }[]>`
        select pg_backend_pid()::int as pid
    `;
    const trace: WorkerTraceState = {
      backendPid: pid,
      barrierWaitCount: 0,
      attempts: [],
    };
    try {
      console.log(JSON.stringify(
        await runStateMutationWorker(
          input,
          sql as unknown as PSqlSql,
          trace,
        ),
      ));
    } finally {
      await Deno.writeTextFile(input.traceFilePath, JSON.stringify(trace));
    }
  } finally {
    await sql.end();
  }
}

async function runStateMutationWorker(
  input: StateMutationWorkerInput,
  sql: PSqlSql,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  requireRequestId(input.request.requestId);
  if (input.command.startsWith('client-')) {
    return await runClientMutation(input as ClientWorkerInput, sql, trace);
  }
  if (input.command.startsWith('group-')) {
    return await runGroupMutation(input as GroupWorkerInput, sql, trace);
  }
  return await runTopologyMutation(input as TopologyWorkerInput, sql, trace);
}

async function runClientMutation(
  input: ClientWorkerInput,
  sql: PSqlSql,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  const requestId = requireRequestId(input.request.requestId);
  const runtime = createPostgresAppInboxWorkerRuntime({
    sql,
    serviceId: `postgres-state-worker-${Deno.pid}`,
    atEpochMs: input.atEpochMs,
    barrier: input.barrier,
    trace,
  });
  const authoritySession: IssuedAuthSession = {
    clientId: input.principalId,
    accessToken: `${input.sessionId}-postgres-worker-token`,
    username: input.principalId,
    sessionId: input.sessionId,
    issuedAtEpochMs: 0,
    expiresAtEpochMs: 4_102_444_800_000,
  };
  await runtime.authSessions.putSession(authoritySession);
  runtime.armBarrier();
  const contextId = inboxContextId(
    input.scope.applicationId,
    input.scope.workspaceId,
    input.principalId,
  );
  const data = {
    scope: input.scope,
    principalId: input.principalId,
    clientInstanceId: input.clientInstanceId,
    sessionId: input.sessionId,
    request: input.request,
  };
  const result = await runtime.runUntilCompletion(() =>
    runtime.client.processAuthenticatedEntryUntilCompletion<typeof data, ClientStateWritten>({
      type: toClientAppInboxType(input.command),
      resourceId: requestId,
      contextId,
      senderId: input.principalId,
      data,
    }, authoritySession)
  );
  const written = result.fold(
    (error) => { throw new Error(error); },
    (value) => value,
  );

  const stored = await createClientStateRepository(
    new PSqlRuntimeStateRepository(sql),
  )
    .findIdempotentClientMutationReceipt(
      { ...input.scope, principalId: input.principalId },
      requestId,
    );
  if (stored) return compactClientReceipt(input.command, requestId, stored.receipt);
  const mutation = written.result.right;
  if (!mutation || mutation.event !== null) {
    throw new Error(`Applied client mutation receipt not found: ${requestId}`);
  }
  const entry = await runtime.resourceInbox.findAnyByKey(toAppQueueKey({
    topicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
    resourceId: requestId,
    contextId,
  }));
  if (!entry || entry.status !== 'COMPLETED') {
    throw new Error(`Completed client AppInbox entry not found: ${requestId}`);
  }
  const commandInput = toClientWorkerCommandInput(input);
  const command = await toClientMutationCommand(
    commandInput,
    {
      nowEpochMs: input.atEpochMs,
      serviceId: `postgres-state-worker-${Deno.pid}`,
      eventId: `postgres-client-event:${requestId}`,
      attemptCount: entry.dequeueAudit.attempts,
      expireAtEpochMs: Number(entry.audit.expiryTs.epochMilliseconds),
      formationDamping: 'damped',
    },
    toClientMutationIssuedSessionAuthority(
      authoritySession,
      commandInput.aggregateRef,
      commandInput.operation as Exclude<typeof commandInput.operation, 'expireSession'>,
    ),
  );
  return {
    operation: input.command,
    requestId,
    commandHash: command.facts.commandHash,
    attemptCount: entry.dequeueAudit.attempts,
    acceptedStorageRevision: null,
    acceptedCausalRevision: null,
    acceptedVersion: null,
    outboxIds: [],
    domainStatus: 'no-op',
  };
}

function toClientWorkerCommandInput(
  input: ClientWorkerInput,
) {
  if (input.command === 'client-heartbeat') {
    return toHeartbeatCommandInput(
      input.scope, input.principalId, input.clientInstanceId, input.sessionId,
      input.request, input.request.requestId,
    );
  }
  if (input.command === 'client-disconnect') {
    return toDisconnectCommandInput(
      'disconnectSession', input.scope, input.principalId, input.clientInstanceId,
      input.sessionId, input.request, input.request.requestId,
    );
  }
  return toConnectCommandInput(
    'connectSession', input.scope, input.principalId, input.clientInstanceId,
    input.sessionId, input.request, input.request.requestId, {},
  );
}

function toClientAppInboxType(command: ClientWorkerInput['command']): AppInboxType {
  if (command === 'client-heartbeat') return AppInboxType.CLIENT_SESSION_HEARTBEAT;
  if (command === 'client-disconnect') return AppInboxType.CLIENT_SESSION_DISCONNECT;
  return AppInboxType.CLIENT_SESSION_CONNECT;
}

function inboxContextId(...parts: string[]): string {
  return parts.map(encodeURIComponent).join(':');
}

async function runGroupMutation(
  input: GroupWorkerInput,
  sql: PSqlSql,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  const requestId = requireRequestId(input.request.requestId);
  const runtime = createPostgresAppInboxWorkerRuntime({
    sql,
    serviceId: `postgres-state-worker-${Deno.pid}`,
    atEpochMs: input.atEpochMs,
    barrier: input.barrier,
    trace,
  });
  const actorPrincipalId = requireString(
    input.request.actorPrincipalId,
    'actorPrincipalId',
  );
  const actorSessionId = requireString(
    input.request.actorSessionId,
    'actorSessionId',
  );
  const authority: IssuedAuthSession = {
    clientId: actorPrincipalId,
    accessToken: `${actorSessionId}-postgres-worker-token`,
    username: actorPrincipalId,
    sessionId: actorSessionId,
    issuedAtEpochMs: 0,
    expiresAtEpochMs: 4_102_444_800_000,
  };
  await runtime.authSessions.putSession(authority);
  const data = toGroupAppInboxData(input);
  runtime.armBarrier();
  const result = await runtime.runUntilCompletion(() =>
    runtime.group.processAuthenticatedEntryUntilCompletion<typeof data, unknown>({
      type: toGroupAppInboxType(input.command),
      resourceId: requestId,
      contextId: inboxContextId(
        input.scope.applicationId,
        input.scope.workspaceId,
        input.groupId,
      ),
      senderId: actorPrincipalId,
      data,
    }, authority)
  );
  const durableResult = result.fold(
    (error) => { throw new Error(error); },
    (value) => value,
  );

  const receipt = isGroupPresenceCommand(input.command)
    ? durableResult as GroupMutationReceipt
    : (await createGroupStateRepository(new PSqlRuntimeStateRepository(sql))
      .findIdempotentGroupMutationReceipt(
        { ...input.scope, groupId: input.groupId },
        requestId,
      ))?.receipt;
  if (!receipt) throw new Error(`Group mutation receipt not found: ${requestId}`);
  return compactGroupReceipt(input.command, requestId, receipt);
}

function toGroupAppInboxType(command: GroupWorkerInput['command']): AppInboxType {
  switch (command) {
    case 'group-join': return AppInboxType.GROUP_JOIN;
    case 'group-ban': return AppInboxType.GROUP_MEMBER_BAN;
    case 'group-presence-connect': return AppInboxType.GROUP_PRESENCE_CONNECT;
    case 'group-presence-heartbeat': return AppInboxType.GROUP_PRESENCE_HEARTBEAT;
    case 'group-presence-disconnect': return AppInboxType.GROUP_PRESENCE_DISCONNECT;
  }
}

function toGroupAppInboxData(input: GroupWorkerInput): Readonly<Record<string, unknown>> {
  if (input.command === 'group-ban') {
    return {
      scope: input.scope,
      groupId: input.groupId,
      principalId: requireString(input.targetPrincipalId, 'targetPrincipalId'),
      request: input.request,
    };
  }
  if (input.command === 'group-join') {
    return { scope: input.scope, groupId: input.groupId, request: input.request };
  }
  return {
    scope: input.scope,
    groupId: input.groupId,
    sessionId: requireString(input.sessionId, 'sessionId'),
    request: input.request,
  };
}

function isGroupPresenceCommand(
  command: GroupWorkerInput['command'],
): boolean {
  return command.startsWith('group-presence-');
}

async function runTopologyMutation(
  input: TopologyWorkerInput,
  sql: PSqlSql,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  const requestId = requireRequestId(input.request.requestId);
  const runtime = createPostgresAppInboxWorkerRuntime({
    sql,
    serviceId: `postgres-state-worker-${Deno.pid}`,
    atEpochMs: input.atEpochMs,
    barrier: input.barrier,
    trace,
  });
  const principalId = requireString(
    input.request.updatedByPrincipalId,
    'updatedByPrincipalId',
  );
  const authority: IssuedAuthSession = {
    clientId: principalId,
    accessToken: `${principalId}-topology-worker-token`,
    username: principalId,
    sessionId: `${principalId}-session`,
    issuedAtEpochMs: 0,
    expiresAtEpochMs: 4_102_444_800_000,
  };
  await runtime.authSessions.putSession(authority);
  const data = await toTopologyAppInboxCommand({
    actor: { principalId, sessionId: authority.sessionId },
    groupRef: input.groupRef,
    requestId,
    capturedAtEpochMs: input.atEpochMs,
    payload: input.command === 'topology-config-put'
      ? { operation: 'putConfig', config: input.request.config }
      : { operation: 'deleteConfig', target: 'config' },
  });
  runtime.armBarrier();
  const result = await runtime.runUntilCompletion(() =>
    runtime.group.processAuthenticatedEntryUntilCompletion<
      typeof data,
      GroupTopologyConfigMutationExecution
    >({
      type: input.command === 'topology-config-put'
        ? AppInboxType.TOPOLOGY_CONFIG_PUT
        : AppInboxType.TOPOLOGY_CONFIG_DELETE,
      resourceId: requestId,
      contextId: inboxContextId(
        input.groupRef.applicationId,
        input.groupRef.workspaceId,
        input.groupRef.groupId,
      ),
      senderId: principalId,
      data,
    }, authority)
  );
  const execution = result.fold(
    (error) => { throw new Error(error); },
    (value) => value,
  );
  return compactTopologyReceipt(input.command, requestId, execution.receipt);
}

function compactClientReceipt(
  operation: ClientWorkerInput['command'],
  requestId: string,
  receipt: ClientMutationReceipt,
): CompactStateMutationWorkerOutput {
  return {
    operation,
    requestId: requireMatchingRequestId(receipt.requestId, requestId),
    commandHash: receipt.commandHash,
    attemptCount: receipt.attemptCount,
    acceptedStorageRevision: receipt.acceptedStorageRevision,
    acceptedCausalRevision: {
      kind: 'client',
      stateRevision: receipt.stateRevision,
      snapshotVersion: receipt.snapshotVersion,
      presenceVersion: receipt.presenceVersion,
    },
    acceptedVersion: null,
    outboxIds: [...receipt.outboxIds],
    domainStatus: receipt.outcome,
  };
}

function compactGroupReceipt(
  operation: GroupWorkerInput['command'],
  requestId: string,
  receipt: GroupMutationReceipt,
): CompactStateMutationWorkerOutput {
  return {
    operation,
    requestId: requireMatchingRequestId(receipt.requestId, requestId),
    commandHash: receipt.commandHash,
    attemptCount: receipt.attemptCount,
    acceptedStorageRevision: receipt.acceptedStorageRevision,
    acceptedCausalRevision: {
      kind: 'group',
      stateRevision: receipt.stateRevision,
      causalRevision: { ...receipt.causalRevision },
      snapshotVersion: receipt.snapshotVersion,
    },
    acceptedVersion: null,
    outboxIds: [...receipt.outboxIds],
    domainStatus: receipt.outcome,
  };
}

function compactTopologyReceipt(
  operation: TopologyWorkerInput['command'],
  requestId: string,
  receipt: GroupTopologyConfigMutationReceipt,
): CompactStateMutationWorkerOutput {
  return {
    operation,
    requestId: requireMatchingRequestId(receipt.requestId, requestId),
    commandHash: receipt.commandHash,
    attemptCount: receipt.attemptCount,
    acceptedStorageRevision: receipt.acceptedStorageRevision,
    acceptedCausalRevision: receipt.acceptedCausalRevision === null ? null : {
      ...receipt.acceptedCausalRevision,
      causalRevision: { ...receipt.acceptedCausalRevision.causalRevision },
    },
    acceptedVersion: receipt.acceptedVersion,
    outboxIds: [...receipt.outboxIds],
    domainStatus: receipt.outcome,
  };
}

function readInput(): StateMutationWorkerInput {
  const raw = Deno.env.get('RALLAR_EXPIRY_WORKER_INPUT');
  if (!raw) {
    throw new Error('RALLAR_EXPIRY_WORKER_INPUT is required');
  }

  return JSON.parse(raw) as StateMutationWorkerInput;
}

function requireRequestId(requestId: unknown): string {
  return requireString(requestId, 'requestId');
}

function requireMatchingRequestId(
  actual: string | null,
  expected: string,
): string {
  if (actual !== expected) {
    throw new Error(`Mutation receipt requestId differs: expected ${expected}`);
  }
  return actual;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

await main();
