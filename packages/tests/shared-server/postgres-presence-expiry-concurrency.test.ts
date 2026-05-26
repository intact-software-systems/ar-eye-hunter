import { describe, expect, it } from "vitest";
import type { ClientSessionRef } from "@shared/api/client-types.ts";
import type { GroupRef } from "@shared/api/group-types.ts";
import type { StateScope } from "@shared/api/state-types.ts";
import type { PSqlSql } from "@shared-server/postgres/PostgresSqlClient.ts";
import { PSqlRuntimeStateRepository } from "@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts";
import { ClientStateRepository } from "@shared-server/rallar-system/repositories/ClientStateRepository.ts";
import { GroupStateRepository } from "@shared-server/rallar-system/repositories/GroupStateRepository.ts";
import { createClientStateService } from "@shared-server/rallar-system/services/client-state-service.ts";
import { createGroupStateService } from "@shared-server/rallar-system/services/group-state-service.ts";
import type { StateSyncPublisher } from "@shared-server/rallar-system/state-sync-publisher.ts";

const CLIENT_SESSION_LOCK_NAMESPACE = "client-state:session-locks";
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
type PostgresModule = Readonly<{
  default: (
    databaseUrl: string,
    options: Readonly<{ max: number; idle_timeout: number }>,
  ) => PostgresSql;
}>;

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
    "serializes two client expiry workers and writes one durable expiry event",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const tmpDirPath = await Deno.makeTempDir({
        prefix: "rallar-client-expiry-concurrency-",
      });
      const setupSql = await createSql(databaseUrl);
      const lockSql = await createSql(databaseUrl);
      const observerSql = await createSql(databaseUrl);
      const scope = uniqueScope("client-expiry-concurrency");
      const atEpochMs = Date.now();
      const sessionRef: ClientSessionRef = {
        ...scope,
        principalId: "alice",
        clientInstanceId: "browser-1",
        sessionId: "session-1",
      };
      let heldLock: HeldAdvisoryLock | undefined;
      const workerOutputs: Promise<ExpiryWorkerOutput>[] = [];

      try {
        await seedExpiredClientSession(
          setupSql,
          scope,
          sessionRef,
          atEpochMs,
        );
        heldLock = await holdAdvisoryLock(
          lockSql,
          CLIENT_SESSION_LOCK_NAMESPACE,
          toClientSessionLockKey(sessionRef),
        );

        const leftPidFilePath = `${tmpDirPath}/left-client-pid.json`;
        const rightPidFilePath = `${tmpDirPath}/right-client-pid.json`;
        workerOutputs.push(
          spawnExpiryWorker(databaseUrl, {
            mode: "client",
            scope,
            atEpochMs,
            pidFilePath: leftPidFilePath,
          }),
          spawnExpiryWorker(databaseUrl, {
            mode: "client",
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
        expect(leftOutput.mode).toBe("client");
        expect(rightOutput.mode).toBe("client");

        const repository = new ClientStateRepository(
          toRuntimeRepository(setupSql),
        );
        const session = await repository.findSession(sessionRef);
        const events = await repository.listEvents({
          ...scope,
          principalId: sessionRef.principalId,
        });

        expect(session).toMatchObject({
          status: "expired",
          disconnectedAtEpochMs: atEpochMs,
          disconnectReason: "expired",
        });
        expect(
          events.filter((event) => event.eventType === "session-expired"),
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

        const repository = new GroupStateRepository(
          toRuntimeRepository(setupSql),
        );
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
    syncPublisher: createPublisher(),
    now: () => atEpochMs - 10_000,
    serviceId: "postgres-expiry-test-setup",
  }).connectSession(
    scope,
    sessionRef.principalId,
    sessionRef.clientInstanceId,
    sessionRef.sessionId,
    {
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
      "--node-modules-dir=auto",
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
        delete from runtime_state_store
        where store_key like ${`app=${encodeURIComponent(applicationId)}:%`}
    `;
}

async function createSql(databaseUrl: string): Promise<PostgresSql> {
  const postgresSpecifier = "postgres";
  const postgresModule = await import(postgresSpecifier) as PostgresModule;

  return postgresModule.default(databaseUrl, { max: 1, idle_timeout: 1 });
}

function toRuntimeRepository(sql: PostgresSql): PSqlRuntimeStateRepository {
  return new PSqlRuntimeStateRepository(sql as unknown as PSqlSql);
}

function toClientSessionLockKey(ref: ClientSessionRef): string {
  return [
    ref.applicationId,
    ref.workspaceId ?? "_",
    ref.principalId,
    ref.clientInstanceId,
    ref.sessionId,
  ].join(":");
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
    publishClientSnapshot: async () => undefined,
    publishClientEvent: async () => undefined,
    publishGroupSnapshot: async () => undefined,
    publishGroupEvent: async () => undefined,
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
