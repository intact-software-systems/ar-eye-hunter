import { createRequire } from 'node:module';
import type { ClientSessionRef } from '@shared/api/client-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/RuntimeStateRepository.ts';

import {
  createGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';

import {
  PSqlRuntimeStateRepository,
} from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { createTestGroupStateRuntime } from '../../../group-state/group-state-test-runtime.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';

import {
  createPostgresClientPhaseDriver,
} from '../../../client-state/postgres-client-mutation-test-driver.ts';

import {
  createPostgresTestRequestIdFactory,
} from '../../../fixtures/create-postgres-test-request-id-factory.ts';
type PostgresSql = PSqlSql &
  Readonly<{
    end(): Promise<void>;
  }>;
type PostgresFactory = (
  databaseUrl: string,
  options: Readonly<{ max: number; idle_timeout: number }>,
) => PostgresSql;
const requestIdFor = createPostgresTestRequestIdFactory();

interface SeedExpiredClientSessionInput {
  readonly sql: PostgresSql;
  readonly scope: StateScope;
  readonly sessionRef: ClientSessionRef;
  readonly atEpochMs: number;
}

export async function seedExpiredClientSession(
  input: SeedExpiredClientSessionInput,
): Promise<void> {
  await createPostgresClientPhaseDriver({
    sql: input.sql,
    runtimeRepository: toRuntimeRepository(input.sql),
    atEpochMs: input.atEpochMs - 10_000,
    serviceId: 'postgres-expiry-test-setup',
  }).connectSession(
    input.scope,
    input.sessionRef.principalId,
    input.sessionRef.clientInstanceId,
    input.sessionRef.sessionId,
    {
      generationId: 'generation-1',
      presenceState: 'online',
      transport: 'ws',
      authenticatedAtEpochMs: input.atEpochMs - 20_000,
      connectedAtEpochMs: input.atEpochMs - 20_000,
      lastHeartbeatAtEpochMs: input.atEpochMs - 10_000,
      expiresAtEpochMs: input.atEpochMs - 1_000,
      actorPrincipalId: input.sessionRef.principalId,
      actorSessionId: input.sessionRef.sessionId,
      requestId: requestIdFor('seed-client-session'),
    },
  );
}

interface SeedExpiredGroupPresenceSessionInput {
  readonly sql: PostgresSql;
  readonly scope: StateScope;
  readonly groupRef: GroupRef;
  readonly sessionId: string;
  readonly atEpochMs: number;
}

export async function seedExpiredGroupPresenceSession(
  input: SeedExpiredGroupPresenceSessionInput,
): Promise<void> {
  const service = createTestGroupStateRuntime({
    runtimeRepository: toRuntimeRepository(input.sql),
    formationDamping: 'damped',
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => input.atEpochMs - 10_000,
    serviceId: 'postgres-expiry-test-setup',
  }).service;

  await service.createGroup(input.scope, {
    groupId: input.groupRef.groupId,
    displayName: 'Room 1',
    kind: 'room',
    joinMode: 'open',
    createdByPrincipalId: 'alice',
    actorPrincipalId: 'alice',
    actorSessionId: input.sessionId,
    requestId: requestIdFor('seed-group'),
  });
  await service.connectPresenceSession(input.scope, input.groupRef.groupId, input.sessionId, {
    generationId: 'generation-1',
    principalId: 'alice',
    connectedAtEpochMs: input.atEpochMs - 20_000,
    lastHeartbeatAtEpochMs: input.atEpochMs - 10_000,
    expiresAtEpochMs: input.atEpochMs - 1_000,
    actorPrincipalId: 'alice',
    actorSessionId: input.sessionId,
    requestId: requestIdFor('seed-group-presence-session'),
  });
}

export async function cleanupRuntimeState(sql: PostgresSql, applicationId: string): Promise<void> {
  await sql`
        delete from client_state_events
        where application_id = ${applicationId}
    `;
  await sql`
        delete from group_state_events
        where application_id = ${applicationId}
    `;
  await sql`
        delete from runtime_state_store
        where store_key like ${`app=${encodeURIComponent(applicationId)}:%`}
    `;
}

export function createSql(databaseUrl: string, maxConnections = 1): PostgresSql {
  const postgres = createRequire(import.meta.url)('postgres') as PostgresFactory;

  return postgres(databaseUrl, { max: maxConnections, idle_timeout: 1 });
}

export function toRuntimeRepository(sql: PostgresSql): PSqlRuntimeStateRepository {
  return new PSqlRuntimeStateRepository(sql);
}

interface CreatePostgresClientServiceInput {
  readonly sql: PostgresSql;
  readonly barrier: PrincipalReadBarrier;
  readonly atEpochMs: number;
  readonly applicationId?: string;
}

export function createPostgresClientService(input: CreatePostgresClientServiceInput) {
  const runtimeRepository = new BarrierPSqlRuntimeStateRepository(
    input.sql,
    input.barrier,
    input.applicationId,
  );
  return createPostgresClientPhaseDriver({
    sql: input.sql,
    runtimeRepository,
    atEpochMs: input.atEpochMs,
    serviceId: 'postgres-client-cas-worker',
  });
}

interface CreatePostgresGroupRuntimeInput {
  readonly sql: PostgresSql;
  readonly barrier: GroupPresenceReadBarrier;
  readonly atEpochMs: number;
  readonly barrierNamespace?: string;
  readonly applicationId?: string;
}

export function createPostgresGroupRuntime(input: CreatePostgresGroupRuntimeInput) {
  return createTestGroupStateRuntime({
    runtimeRepository: new BarrierGroupPSqlRuntimeStateRepository(
      input.sql,
      input.barrier,
      input.barrierNamespace,
      input.applicationId,
    ),
    formationDamping: 'damped',
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => input.atEpochMs,
    sleep: () => Promise.resolve(),
    serviceId: 'postgres-group-cas-worker',
  });
}

class BarrierPSqlRuntimeStateRepository extends PSqlRuntimeStateRepository {
  private readonly barrier: PrincipalReadBarrier;
  private readonly applicationId?: string;

  constructor(sql: PSqlSql, barrier: PrincipalReadBarrier, applicationId?: string) {
    super(sql);
    this.barrier = barrier;
    this.applicationId = applicationId;
  }

  override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
    const entry = await super.findEntry(namespace, key);
    if (namespace === 'client-state:principals') {
      await this.barrier.arrive();
    }
    return entry;
  }

  override async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
    const entries = await super.findAllEntries(namespace);
    const applicationId = this.applicationId;
    return applicationId === undefined
      ? entries
      : entries.filter((entry) =>
          entry.key.startsWith(`app=${encodeURIComponent(applicationId)}:`),
        );
  }
}

class BarrierGroupPSqlRuntimeStateRepository extends PSqlRuntimeStateRepository {
  private readonly barrier: GroupPresenceReadBarrier;
  private readonly barrierNamespace: string;
  private readonly applicationId?: string;

  constructor(
    sql: PSqlSql,
    barrier: GroupPresenceReadBarrier,
    barrierNamespace = 'group-state:sessions',
    applicationId?: string,
  ) {
    super(sql);
    this.barrier = barrier;
    this.barrierNamespace = barrierNamespace;
    this.applicationId = applicationId;
  }

  override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
    const entry = await super.findEntry(namespace, key);
    if (namespace === this.barrierNamespace) {
      await this.barrier.arrive();
    }
    return entry;
  }

  override async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
    const entries = await super.findAllEntries(namespace);
    const applicationId = this.applicationId;
    return applicationId === undefined
      ? entries
      : entries.filter((entry) =>
          entry.key.startsWith(`app=${encodeURIComponent(applicationId)}:`),
        );
  }
}

export class PrincipalReadBarrier {
  private arrived = 0;
  private readonly ready: Promise<void>;
  private release!: () => void;

  private readonly participants: number;

  constructor(participants: number) {
    this.participants = participants;
    this.ready = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async arrive(): Promise<void> {
    if (this.arrived >= this.participants) return;
    this.arrived += 1;
    if (this.arrived === this.participants) this.release();
    await this.ready;
  }
}

export class GroupPresenceReadBarrier extends PrincipalReadBarrier {}

export function createPublisher(): StateSyncPublisher {
  return {
    publishClientSnapshot: () => Promise.resolve(),
    publishClientEvent: () => Promise.resolve(),
    publishGroupSnapshot: () => Promise.resolve(),
    publishGroupEvent: () => Promise.resolve(),
  };
}

interface SeedConnectedClientSessionInput {
  readonly sql: PostgresSql;
  readonly scope: StateScope;
  readonly sessionRef: ClientSessionRef;
  readonly atEpochMs: number;
}

export async function seedConnectedClientSession(
  input: SeedConnectedClientSessionInput,
): Promise<void> {
  await createPostgresClientPhaseDriver({
    sql: input.sql,
    runtimeRepository: toRuntimeRepository(input.sql),
    atEpochMs: input.atEpochMs,
    serviceId: 'postgres-worker-client-setup',
  }).connectSession(
    input.scope,
    input.sessionRef.principalId,
    input.sessionRef.clientInstanceId,
    input.sessionRef.sessionId,
    {
      generationId: 'generation-1',
      connectionId: 'connection-1',
      connectedAtEpochMs: input.atEpochMs,
      lastHeartbeatAtEpochMs: input.atEpochMs,
      expiresAtEpochMs: input.atEpochMs + 60_000,
      actorPrincipalId: input.sessionRef.principalId,
      actorSessionId: input.sessionRef.sessionId,
      requestId: requestIdFor('worker-client-seed'),
    },
  );
}
