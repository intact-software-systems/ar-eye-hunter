import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { ClientSessionRef } from "@shared/api/client-types.ts";
import type { GroupRef } from "@shared/api/group-types.ts";
import type { StateScope } from "@shared/api/state-types.ts";
import type { PSqlSql } from "@shared-server/postgres/PostgresSqlClient.ts";
import type { RuntimeStateEntry } from "@shared-server/runtime-state/RuntimeStateRepository.ts";
import {
  createClientStateEventRepository,
  createClientStateRepository,
  createGroupStateEventRepository,
  createGroupStateRepository,
} from "@shared-server/postgres/rallar-system/createStateRepositories.ts";
import { PSqlRuntimeStateRepository } from "@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts";
import { createClientStateService } from "@shared-server/rallar-system/services/client-state-service.ts";
import { createGroupStateService } from "@shared-server/rallar-system/services/group-state-service.ts";
import type { StateSyncPublisher } from "@shared-server/rallar-system/state-sync-publisher.ts";

const GROUP_PRESENCE_SESSION_LOCK_NAMESPACE =
  "group-state:presence-session-locks";
const POSTGRES_INTEGRATION_ENABLED =
  Deno.env.get("RALLAR_POSTGRES_INTEGRATION") === "1";
const ROOT_DENO_CONFIG_PATH = new URL("../../../deno.json", import.meta.url)
  .pathname;
const EXPIRY_WORKER_URL = new URL(
  "./fixtures/postgres-expiry-worker.ts",
  import.meta.url,
).href;

type PostgresSql =
  & PSqlSql
  & Readonly<{
    end(): Promise<void>;
  }>;
type PostgresFactory = (
  databaseUrl: string,
  options: Readonly<{ max: number; idle_timeout: number }>,
) => PostgresSql;

type ExpiryWorkerInput = Readonly<{
  mode: "client" | "group";
  scope: StateScope;
  atEpochMs: number;
  pidFilePath: string;
}>;

type ExpiryWorkerOutput = Readonly<{
  mode: ExpiryWorkerInput["mode"];
  backendPid: number;
  resultCount: number;
  eventTypes: readonly string[];
}>;

type HeldAdvisoryLock = Readonly<{
  release: () => void;
  done: Promise<unknown>;
}>;

const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;

describe("Postgres presence expiry concurrency", () => {
  postgresIt(
    "rebases client expiry CAS workers and preserves a concurrent reconnect",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const setupSql = await createSql(databaseUrl);
      const leftSql = await createSql(databaseUrl);
      const rightSql = await createSql(databaseUrl);
      const scope = uniqueScope("client-expiry-concurrency");
      const atEpochMs = Date.now();
      const sessionRef: ClientSessionRef = {
        ...scope,
        principalId: "alice",
        clientInstanceId: "browser-1",
        sessionId: "session-1",
      };

      try {
        await seedExpiredClientSession(
          setupSql,
          scope,
          sessionRef,
          atEpochMs,
        );
        const expiryBarrier = new PrincipalReadBarrier(2);
        const [leftResults, rightResults] = await Promise.all([
          createPostgresClientService(leftSql, expiryBarrier, atEpochMs)
            .expireExpiredSessions(atEpochMs),
          createPostgresClientService(rightSql, expiryBarrier, atEpochMs)
            .expireExpiredSessions(atEpochMs),
        ]);
        expect(leftResults.length + rightResults.length).toBe(1);

        const repository = createClientStateRepository(setupSql);
        const session = await repository.findSession(sessionRef);
        const events = await repository.listEvents({
          ...scope,
          principalId: sessionRef.principalId,
        });

        expect(session).toMatchObject({
          status: "expired",
          disconnectedAtEpochMs: atEpochMs - 1_000,
          disconnectReason: "expired",
        });
        expect(
          events.filter((event) => event.eventType === "session-expired"),
        ).toHaveLength(1);

        const reconnectRef: ClientSessionRef = {
          ...scope,
          principalId: "bob",
          clientInstanceId: "browser-2",
          sessionId: "session-reconnect",
        };
        await seedExpiredClientSession(
          setupSql,
          scope,
          reconnectRef,
          atEpochMs,
        );
        const reconnectBarrier = new PrincipalReadBarrier(2);
        await Promise.all([
          createPostgresClientService(leftSql, reconnectBarrier, atEpochMs)
            .expireExpiredSessions(atEpochMs),
          createPostgresClientService(rightSql, reconnectBarrier, atEpochMs + 1)
            .connectSession(
              scope,
              reconnectRef.principalId,
              reconnectRef.clientInstanceId,
              reconnectRef.sessionId,
              {
                generationId: "generation-2",
                connectionId: "connection-2",
                connectedAtEpochMs: atEpochMs + 1,
                lastHeartbeatAtEpochMs: atEpochMs + 1,
                expiresAtEpochMs: atEpochMs + 60_000,
                requestId: "postgres-reconnect-generation-2",
              },
            ),
        ]);
        expect(await repository.findSession(reconnectRef)).toMatchObject({
          status: "active",
          generationId: "generation-2",
          generationVersion: 2,
          connectionId: "connection-2",
        });
      } finally {
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await Promise.all([
          setupSql.end(),
          leftSql.end(),
          rightSql.end(),
        ]);
      }
    },
    60_000,
  );

  postgresIt(
    "serializes two group expiry workers and writes one durable disconnect event",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const tmpDirPath = await Deno.makeTempDir({
        prefix: "rallar-group-expiry-concurrency-",
      });
      const setupSql = await createSql(databaseUrl);
      const lockSql = await createSql(databaseUrl);
      const observerSql = await createSql(databaseUrl);
      const scope = uniqueScope("group-expiry-concurrency");
      const atEpochMs = Date.now();
      const groupRef: GroupRef = {
        ...scope,
        groupId: "room-1",
      };
      const sessionId = "session-1";
      let heldLock: HeldAdvisoryLock | undefined;
      const workerOutputs: Promise<ExpiryWorkerOutput>[] = [];

      try {
        await seedExpiredGroupPresenceSession(
          setupSql,
          scope,
          groupRef,
          sessionId,
          atEpochMs,
        );
        heldLock = await holdAdvisoryLock(
          lockSql,
          GROUP_PRESENCE_SESSION_LOCK_NAMESPACE,
          toGroupPresenceSessionLockKey({ ...groupRef, sessionId }),
        );

        const leftPidFilePath = `${tmpDirPath}/left-group-pid.json`;
        const rightPidFilePath = `${tmpDirPath}/right-group-pid.json`;
        workerOutputs.push(
          spawnExpiryWorker(databaseUrl, {
            mode: "group",
            scope,
            atEpochMs,
            pidFilePath: leftPidFilePath,
          }),
          spawnExpiryWorker(databaseUrl, {
            mode: "group",
            scope,
            atEpochMs,
            pidFilePath: rightPidFilePath,
          }),
        );

        const [leftBackendPid, rightBackendPid] = await Promise.all([
          waitForWorkerBackendPid(leftPidFilePath),
          waitForWorkerBackendPid(rightPidFilePath),
        ]);
        await waitForAdvisoryWaiters(
          observerSql,
          leftBackendPid,
          rightBackendPid,
          2,
        );

        heldLock.release();
        await heldLock.done;
        heldLock = undefined;

        const [leftOutput, rightOutput] = await Promise.all(workerOutputs);
        expect(leftOutput.mode).toBe("group");
        expect(rightOutput.mode).toBe("group");

        const repository = createGroupStateRepository(setupSql);
        const session = await repository.findPresenceSession({
          ...groupRef,
          sessionId,
        });
        const events = await repository.listEvents(groupRef);

        expect(session).toMatchObject({
          disconnectedAtEpochMs: atEpochMs,
          disconnectReason: "expired",
        });
        expect(
          events.filter(
            (event) =>
              event.eventType === "session-disconnected" &&
              event.reason === "expired",
          ),
        ).toHaveLength(1);
      } finally {
        if (heldLock) {
          heldLock.release();
          await heldLock.done.catch(() => undefined);
        }
        await Promise.allSettled(workerOutputs);
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await Promise.all([
          setupSql.end(),
          lockSql.end(),
          observerSql.end(),
          Deno.remove(tmpDirPath, { recursive: true }).catch(() => undefined),
        ]);
      }
    },
    60_000,
  );
});

async function seedExpiredClientSession(
  sql: PostgresSql,
  scope: StateScope,
  sessionRef: ClientSessionRef,
  atEpochMs: number,
): Promise<void> {
  await createClientStateService({
    runtimeRepository: toRuntimeRepository(sql),
    createClientStateEventStore: createClientStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => atEpochMs - 10_000,
    serviceId: "postgres-expiry-test-setup",
  }).connectSession(
    scope,
    sessionRef.principalId,
    sessionRef.clientInstanceId,
    sessionRef.sessionId,
    {
      generationId: "generation-1",
      presenceState: "online",
      transport: "ws",
      authenticatedAtEpochMs: atEpochMs - 20_000,
      connectedAtEpochMs: atEpochMs - 20_000,
      lastHeartbeatAtEpochMs: atEpochMs - 10_000,
      expiresAtEpochMs: atEpochMs - 1_000,
      actorPrincipalId: sessionRef.principalId,
      actorSessionId: sessionRef.sessionId,
      requestId: "seed-client-session",
    },
  );
}

async function seedExpiredGroupPresenceSession(
  sql: PostgresSql,
  scope: StateScope,
  groupRef: GroupRef,
  sessionId: string,
  atEpochMs: number,
): Promise<void> {
  const service = createGroupStateService({
    runtimeRepository: toRuntimeRepository(sql),
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => atEpochMs - 10_000,
    serviceId: "postgres-expiry-test-setup",
  });

  await service.createGroup(scope, {
    groupId: groupRef.groupId,
    displayName: "Room 1",
    kind: "room",
    joinMode: "open",
    createdByPrincipalId: "alice",
    actorPrincipalId: "alice",
    actorSessionId: sessionId,
    requestId: "seed-group",
  });
  await service.connectPresenceSession(scope, groupRef.groupId, sessionId, {
    principalId: "alice",
    connectedAtEpochMs: atEpochMs - 20_000,
    lastHeartbeatAtEpochMs: atEpochMs - 10_000,
    expiresAtEpochMs: atEpochMs - 1_000,
    actorPrincipalId: "alice",
    actorSessionId: sessionId,
    requestId: "seed-group-presence-session",
  });
}

async function holdAdvisoryLock(
  sql: PostgresSql,
  namespace: string,
  key: string,
): Promise<HeldAdvisoryLock> {
  let releaseLock!: () => void;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = sql.begin(async (transactionSql) => {
    await new PSqlRuntimeStateRepository(
      transactionSql as unknown as PSqlSql,
    ).lockKey(namespace, key);
    resolveReady();
    await released;
  });
  done.catch(rejectReady);
  await ready;

  return {
    release: releaseLock,
    done,
  };
}

async function spawnExpiryWorker(
  databaseUrl: string,
  input: ExpiryWorkerInput,
): Promise<ExpiryWorkerOutput> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-temporal",
      "--node-modules-dir=none",
      "--no-lock",
      "--config",
      ROOT_DENO_CONFIG_PATH,
      EXPIRY_WORKER_URL,
    ],
    env: {
      DATABASE_URL: databaseUrl,
      RALLAR_EXPIRY_WORKER_INPUT: JSON.stringify(input),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  if (!output.success) {
    throw new Error(
      `Expiry worker failed with code ${output.code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  const lastLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!lastLine) {
    throw new Error(
      `Expiry worker did not write JSON output\nstderr:\n${stderr}`,
    );
  }

  return JSON.parse(lastLine) as ExpiryWorkerOutput;
}

async function waitForWorkerBackendPid(pidFilePath: string): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      const raw = await Deno.readTextFile(pidFilePath);
      const parsed = JSON.parse(raw) as { backendPid?: unknown };
      if (typeof parsed.backendPid === "number") {
        return parsed.backendPid;
      }
    } catch {
      await delay(25);
    }
  }

  throw new Error(`Timed out waiting for worker backend pid: ${pidFilePath}`);
}

async function waitForAdvisoryWaiters(
  sql: PostgresSql,
  leftBackendPid: number,
  rightBackendPid: number,
  expectedWaiters: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const rows = await sql<{ waiter_count: number | string }[]>`
            select count(*)::int as waiter_count
            from pg_locks
            where locktype = 'advisory'
              and granted = false
              and pid in (${leftBackendPid}, ${rightBackendPid})
        `;
    const waiterCount = Number(rows[0]?.waiter_count ?? 0);
    if (waiterCount >= expectedWaiters) {
      return;
    }

    await delay(25);
  }

  throw new Error(
    `Timed out waiting for ${expectedWaiters} advisory lock waiters`,
  );
}

async function cleanupRuntimeState(
  sql: PostgresSql,
  applicationId: string,
): Promise<void> {
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

function createSql(databaseUrl: string): PostgresSql {
  const postgres = createRequire(import.meta.url)("postgres") as PostgresFactory;

  return postgres(databaseUrl, { max: 1, idle_timeout: 1 });
}

function toRuntimeRepository(sql: PostgresSql): PSqlRuntimeStateRepository {
  return new PSqlRuntimeStateRepository(sql as unknown as PSqlSql);
}

function createPostgresClientService(
  sql: PostgresSql,
  barrier: PrincipalReadBarrier,
  atEpochMs: number,
) {
  const runtimeRepository = new BarrierPSqlRuntimeStateRepository(
    sql as unknown as PSqlSql,
    barrier,
  );
  return createClientStateService({
    runtimeRepository,
    createClientStateEventStore: createClientStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => atEpochMs,
    sleep: () => Promise.resolve(),
    serviceId: "postgres-client-cas-worker",
  });
}

class BarrierPSqlRuntimeStateRepository extends PSqlRuntimeStateRepository {
  constructor(
    sql: PSqlSql,
    private readonly barrier: PrincipalReadBarrier,
  ) {
    super(sql);
  }

  override async findEntry(
    namespace: string,
    key: string,
  ): Promise<RuntimeStateEntry | undefined> {
    const entry = await super.findEntry(namespace, key);
    if (namespace === "client-state:principals") {
      await this.barrier.arrive();
    }
    return entry;
  }
}

class PrincipalReadBarrier {
  private arrived = 0;
  private readonly ready: Promise<void>;
  private release!: () => void;

  constructor(private readonly participants: number) {
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

function toGroupPresenceSessionLockKey(
  ref: GroupRef & Readonly<{ sessionId: string }>,
): string {
  return [
    ref.applicationId,
    ref.workspaceId ?? "_",
    ref.groupId,
    ref.sessionId,
  ].join(":");
}

function uniqueScope(prefix: string): StateScope {
  return {
    applicationId: `${prefix}-${crypto.randomUUID()}`,
    workspaceId: "workspace-1",
  };
}

function createPublisher(): StateSyncPublisher {
  return {
    publishClientSnapshot: () => Promise.resolve(),
    publishClientEvent: () => Promise.resolve(),
    publishGroupSnapshot: () => Promise.resolve(),
    publishGroupEvent: () => Promise.resolve(),
  };
}

function requireDatabaseUrl(): string {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1",
    );
  }

  return databaseUrl;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
