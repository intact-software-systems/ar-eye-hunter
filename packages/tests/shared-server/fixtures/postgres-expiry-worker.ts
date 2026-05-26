import postgres from "postgres";
import type { StateScope } from "@shared/api/state-types.ts";
import type { PSqlSql } from "@shared-server/postgres/PostgresSqlClient.ts";
import { PSqlRuntimeStateRepository } from "@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts";
import { createClientStateService } from "@shared-server/rallar-system/services/client-state-service.ts";
import { createGroupStateService } from "@shared-server/rallar-system/services/group-state-service.ts";
import type { StateSyncPublisher } from "@shared-server/rallar-system/state-sync-publisher.ts";

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

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for postgres-expiry-worker");
}

const input = readInput();
const sql = postgres(databaseUrl, { max: 1, idle_timeout: 1 });

try {
  const [{ pid }] = await sql<{ pid: number }[]>`
        select pg_backend_pid()::int as pid
    `;
  await Deno.writeTextFile(
    input.pidFilePath,
    JSON.stringify({ backendPid: pid }),
  );

  const runtimeRepository = new PSqlRuntimeStateRepository(
    sql as unknown as PSqlSql,
  );
  const output = await runExpiryWorker(input, runtimeRepository, pid);
  console.log(JSON.stringify(output));
} finally {
  await sql.end();
}

async function runExpiryWorker(
  input: ExpiryWorkerInput,
  runtimeRepository: PSqlRuntimeStateRepository,
  backendPid: number,
): Promise<ExpiryWorkerOutput> {
  if (input.mode === "client") {
    const results = await createClientStateService({
      runtimeRepository,
      syncPublisher: createPublisher(),
      now: () => input.atEpochMs,
      serviceId: `postgres-expiry-worker-${Deno.pid}`,
    }).expireExpiredSessions(input.atEpochMs);

    return {
      mode: input.mode,
      backendPid,
      resultCount: results.length,
      eventTypes: results
        .map((result) => result.result.right?.event?.eventType)
        .filter(isDefined),
    };
  }

  const results = await createGroupStateService({
    runtimeRepository,
    syncPublisher: createPublisher(),
    now: () => input.atEpochMs,
    serviceId: `postgres-expiry-worker-${Deno.pid}`,
  }).expireExpiredPresenceSessions(input.atEpochMs);

  return {
    mode: input.mode,
    backendPid,
    resultCount: results.length,
    eventTypes: results
      .map((result) => result.result.right?.event?.eventType)
      .filter(isDefined),
  };
}

function readInput(): ExpiryWorkerInput {
  const raw = Deno.env.get("RALLAR_EXPIRY_WORKER_INPUT");
  if (!raw) {
    throw new Error("RALLAR_EXPIRY_WORKER_INPUT is required");
  }

  return JSON.parse(raw) as ExpiryWorkerInput;
}

function createPublisher(): StateSyncPublisher {
  return {
    publishClientSnapshot: async () => undefined,
    publishClientEvent: async () => undefined,
    publishGroupSnapshot: async () => undefined,
    publishGroupEvent: async () => undefined,
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
