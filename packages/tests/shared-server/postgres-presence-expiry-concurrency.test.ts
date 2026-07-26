import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ClientSessionRef } from "@shared/api/client-types.ts";
import type { AuditStamp, Group, GroupEvent, GroupRef } from "@shared/api/group-types.ts";
import { toGroupSnapshotStateRevision } from "@shared/api/group-client-views.ts";
import type {
  ConnectClientSessionRequest,
  StateScope,
} from "@shared/api/state-types.ts";
import { NEVER_EXPIRE_AT_TIMESTAMP } from "@shared/persistence/PersistenceProvider.ts";
import type { PSqlSql } from "@shared-server/postgres/PostgresSqlClient.ts";
import type { RuntimeStateEntry } from "@shared-server/runtime-state/RuntimeStateRepository.ts";
import {
  createClientStateEventRepository,
  createClientStateRepository,
  createGroupStateEventRepository,
  createGroupStateRepository,
} from "@shared-server/postgres/rallar-system/createStateRepositories.ts";
import { PSqlRuntimeStateRepository } from "@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts";
import {
  createClientStateService,
  requiresClientWrite,
  toClientMutationCommand,
  toClientMutationIssuedSessionAuthority,
  toClientMutationSystemAuthority,
  toConnectCommandInput,
  toExpiryCommandInput,
} from "@shared-server/rallar-system/services/client-state-service.ts";
import type {
  ClientMutationCommandInput,
  ClientMutationComputed,
} from "@shared-server/rallar-system/services/client-state-mutations.ts";
import { AuthSessionRepository } from "@shared-server/rallar-system/repositories/AuthSessionRepository.ts";
import type { IssuedAuthSession } from "@shared-server/rallar-system/repositories/AuthSessionRepository.ts";
import { RuntimeStateWriteConflictError } from "@shared-server/runtime-state/optimistic-runtime-state-write.ts";
import { createTestGroupStateRuntime } from "./group-state-test-runtime.ts";
import type { StateSyncPublisher } from "@shared-server/rallar-system/state-sync-publisher.ts";
import { groupStateMaintenanceRequestId } from "@shared-server/rallar-system/services/group-state-service.ts";

const POSTGRES_INTEGRATION_ENABLED =
  process.env.RALLAR_POSTGRES_INTEGRATION === "1";

type PostgresSql =
  & PSqlSql
  & Readonly<{
    end(): Promise<void>;
  }>;
type PostgresFactory = (
  databaseUrl: string,
  options: Readonly<{ max: number; idle_timeout: number }>,
) => PostgresSql;

type WorkerInput = Readonly<{
  command:
    | "client-heartbeat"
    | "client-disconnect"
    | "client-reconnect"
    | "group-join"
    | "group-ban"
    | "group-presence-connect"
    | "group-presence-heartbeat"
    | "group-presence-disconnect";
  scope: StateScope;
  atEpochMs: number;
  traceFilePath: string;
  barrier: Readonly<{ readyFilePath: string; releaseFilePath: string }>;
  principalId?: string;
  clientInstanceId?: string;
  groupId?: string;
  targetPrincipalId?: string;
  sessionId?: string;
  request: Readonly<Record<string, unknown>>;
}>;
type WorkerOutput = Readonly<{
  operation: WorkerInput["command"];
  requestId: string;
  commandHash: string;
  attemptCount: number;
  acceptedStorageRevision: number | null;
  acceptedCausalRevision: Readonly<Record<string, unknown>> | null;
  acceptedVersion: number | null;
  outboxIds: readonly string[];
  domainStatus: "applied" | "no-op" | "rejected";
}>;
type WorkerTrace = Readonly<{
  backendPid: number;
  barrierWaitCount: number;
  sleeps: readonly Readonly<{ delayMs: number; inTransaction: boolean }>[];
  phases: readonly Readonly<{
    component: string;
    operation: string;
    status: "ok" | "error";
    attempt: number | null;
    backoffMs: number | null;
  }>[];
}>;
type WorkerHandle = Readonly<{ done: Promise<WorkerOutput> }>;

const ROOT_DENO_CONFIG_PATH = fileURLToPath(new URL("../../../deno.json", import.meta.url));
const STATE_MUTATION_WORKER_PATH = fileURLToPath(
  new URL("./fixtures/postgres-expiry-worker.ts", import.meta.url),
);

const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;

describe("Postgres presence expiry concurrency", () => {
  postgresIt(
    "rejects client and group worker inputs without request ids before mutation",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const setupSql = await createSql(databaseUrl);
      const scope = uniqueScope("worker-request-id");
      const groupRef: GroupRef = { ...scope, groupId: "room-1" };
      const atEpochMs = Date.now();
      const sessionRef: ClientSessionRef = {
        ...scope,
        principalId: "alice",
        clientInstanceId: "browser-1",
        sessionId: "session-1",
      };
      const tmpDirPath = await mkdtemp(path.join(tmpdir(), "rallar-worker-request-id-"));
      const inputs: readonly WorkerInput[] = [
        {
          command: "client-heartbeat",
          scope,
          atEpochMs: atEpochMs + 1_000,
          traceFilePath: path.join(tmpDirPath, "client-trace.json"),
          barrier: {
            readyFilePath: path.join(tmpDirPath, "client-ready.json"),
            releaseFilePath: path.join(tmpDirPath, "client-release"),
          },
          principalId: sessionRef.principalId,
          clientInstanceId: sessionRef.clientInstanceId,
          sessionId: sessionRef.sessionId,
          request: {
            generationId: "generation-1",
            lastHeartbeatAtEpochMs: atEpochMs + 1_000,
            expiresAtEpochMs: atEpochMs + 61_000,
            actorPrincipalId: sessionRef.principalId,
          },
        },
        {
          command: "group-join",
          scope,
          groupId: groupRef.groupId,
          atEpochMs: atEpochMs + 1_000,
          traceFilePath: path.join(tmpDirPath, "group-trace.json"),
          barrier: {
            readyFilePath: path.join(tmpDirPath, "group-ready.json"),
            releaseFilePath: path.join(tmpDirPath, "group-release"),
          },
          request: {
            actorPrincipalId: "bob",
            actorSessionId: "bob-session",
          },
        },
      ];
      const handles: WorkerHandle[] = [];

      try {
        await seedConnectedClientSession(setupSql, scope, sessionRef, atEpochMs);
        const setup = createTestGroupStateRuntime({
          runtimeRepository: toRuntimeRepository(setupSql),
          createGroupStateEventStore: createGroupStateEventRepository,
          syncPublisher: createPublisher(),
          now: () => atEpochMs,
          sleep: () => Promise.resolve(),
          serviceId: "postgres-worker-request-id-setup",
        }).service;
        await setup.createGroup(scope, {
          groupId: groupRef.groupId,
          displayName: "Worker request id",
          kind: "room",
          joinMode: "open",
          maxMembers: 4,
          createdByPrincipalId: "alice",
          actorPrincipalId: "alice",
          actorSessionId: "alice-session",
          requestId: "worker-request-id-create",
        });
        await Promise.all(inputs.map((input) =>
          writeFile(input.barrier.releaseFilePath, "release", "utf8")
        ));
        handles.push(...inputs.map((input) => spawnWorker(databaseUrl, input)));

        for (const handle of handles) {
          await expect(handle.done).rejects.toThrow("requestId is required");
        }
        const clientSession = await createClientStateRepository(setupSql)
          .findSession(sessionRef);
        expect(clientSession).toMatchObject({
          generationId: "generation-1",
          lastHeartbeatAtEpochMs: atEpochMs,
          expiresAtEpochMs: atEpochMs + 60_000,
        });
        const group = await createGroupStateRepository(setupSql).readSnapshot(groupRef);
        expect(group?.members.some((member) => member.principalId === "bob"))
          .toBe(false);
        const traces = await Promise.all(inputs.map((input) => readTrace(input.traceFilePath)));
        expect(traces.map((trace) => trace.barrierWaitCount)).toEqual([0, 0]);
      } finally {
        await Promise.allSettled(handles.map((handle) => handle.done));
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await setupSql.end();
        await rm(tmpDirPath, { recursive: true, force: true });
      }
    },
    60_000,
  );

  postgresIt(
    "rebases independent client heartbeat workers with compact durable receipts",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const setupSql = await createSql(databaseUrl);
      const scope = uniqueScope("client-worker-heartbeat");
      const atEpochMs = Date.now();
      const sessionRef: ClientSessionRef = {
        ...scope,
        principalId: "alice",
        clientInstanceId: "browser-1",
        sessionId: "session-1",
      };
      const tmpDirPath = await mkdtemp(path.join(tmpdir(), "rallar-client-heartbeat-"));
      const inputs: readonly WorkerInput[] = [0, 1].map((index) => ({
        command: "client-heartbeat",
        scope,
        atEpochMs: atEpochMs + 1_000 + index,
        traceFilePath: path.join(tmpDirPath, `heartbeat-${index}-trace.json`),
        barrier: {
          readyFilePath: path.join(tmpDirPath, `heartbeat-${index}-ready.json`),
          releaseFilePath: path.join(tmpDirPath, `heartbeat-${index}-release`),
        },
        principalId: sessionRef.principalId,
        clientInstanceId: sessionRef.clientInstanceId,
        sessionId: sessionRef.sessionId,
        request: {
          generationId: "generation-1",
          lastHeartbeatAtEpochMs: atEpochMs + 1_000 + index,
          expiresAtEpochMs: atEpochMs + 61_000 + index,
          actorPrincipalId: sessionRef.principalId,
          actorSessionId: sessionRef.sessionId,
          requestId: `worker-client-heartbeat-${index}`,
        },
      }));
      const handles: WorkerHandle[] = [];

      try {
        await seedConnectedClientSession(setupSql, scope, sessionRef, atEpochMs);
        handles.push(...inputs.map((input) => spawnWorker(databaseUrl, input)));
        await Promise.all(inputs.map((input, index) =>
          waitForWorkerBarrier(input.barrier.readyFilePath, handles[index]!)
        ));
        await writeFile(inputs[0]!.barrier.releaseFilePath, "release", "utf8");
        const first = await handles[0]!.done;
        await writeFile(inputs[1]!.barrier.releaseFilePath, "release", "utf8");
        const outputs = [first, await handles[1]!.done];

        outputs.forEach(expectCompactWorkerOutput);
        expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
        const traces = await Promise.all(inputs.map((input) => readTrace(input.traceFilePath)));
        assertOneWorkerRebased(outputs, traces);
        expect(await createClientStateRepository(setupSql).findSession(sessionRef))
          .toMatchObject({
            generationId: "generation-1",
            lastHeartbeatAtEpochMs: atEpochMs + 1_001,
            expiresAtEpochMs: atEpochMs + 61_001,
          });
        await expectPendingWorkerOutboxes(
          toRuntimeRepository(setupSql),
          outputs,
          "client",
          ["client-state-sync"],
        );
      } finally {
        await Promise.allSettled(handles.map((handle) => handle.done));
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await setupSql.end();
        await rm(tmpDirPath, { recursive: true, force: true });
      }
    },
    60_000,
  );

  postgresIt(
    "rebases independent client disconnect and reconnect workers without stale generation loss",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const setupSql = await createSql(databaseUrl);
      const scope = uniqueScope("client-worker-reconnect");
      const atEpochMs = Date.now();
      const sessionRef: ClientSessionRef = {
        ...scope,
        principalId: "alice",
        clientInstanceId: "browser-1",
        sessionId: "reused-session",
      };
      const tmpDirPath = await mkdtemp(path.join(tmpdir(), "rallar-client-worker-race-"));
      const disconnectReleaseFilePath = path.join(tmpDirPath, "disconnect-release");
      const reconnectReleaseFilePath = path.join(tmpDirPath, "reconnect-release");
      const inputs: readonly WorkerInput[] = [
        {
          command: "client-disconnect",
          scope,
          atEpochMs: atEpochMs + 1_000,
          traceFilePath: path.join(tmpDirPath, "disconnect-trace.json"),
          barrier: {
            readyFilePath: path.join(tmpDirPath, "disconnect-ready.json"),
            releaseFilePath: disconnectReleaseFilePath,
          },
          principalId: sessionRef.principalId,
          clientInstanceId: sessionRef.clientInstanceId,
          sessionId: sessionRef.sessionId,
          request: {
            generationId: "generation-1",
            disconnectedAtEpochMs: atEpochMs + 1_000,
            actorPrincipalId: sessionRef.principalId,
            actorSessionId: sessionRef.sessionId,
            requestId: "worker-client-disconnect",
          },
        },
        {
          command: "client-reconnect",
          scope,
          atEpochMs: atEpochMs + 1_001,
          traceFilePath: path.join(tmpDirPath, "reconnect-trace.json"),
          barrier: {
            readyFilePath: path.join(tmpDirPath, "reconnect-ready.json"),
            releaseFilePath: reconnectReleaseFilePath,
          },
          principalId: sessionRef.principalId,
          clientInstanceId: sessionRef.clientInstanceId,
          sessionId: sessionRef.sessionId,
          request: {
            generationId: "generation-2",
            connectionId: "connection-2",
            connectedAtEpochMs: atEpochMs + 1_001,
            lastHeartbeatAtEpochMs: atEpochMs + 1_001,
            expiresAtEpochMs: atEpochMs + 61_001,
            actorPrincipalId: sessionRef.principalId,
            actorSessionId: sessionRef.sessionId,
            requestId: "worker-client-reconnect",
          },
        },
      ];
      const handles: WorkerHandle[] = [];

      try {
        await seedConnectedClientSession(setupSql, scope, sessionRef, atEpochMs);
        handles.push(...inputs.map((input) => spawnWorker(databaseUrl, input)));
        await Promise.all(inputs.map((input, index) =>
          waitForWorkerBarrier(input.barrier.readyFilePath, handles[index]!)
        ));
        await writeFile(disconnectReleaseFilePath, "release", "utf8");
        const disconnectOutput = await handles[0]!.done;
        await writeFile(reconnectReleaseFilePath, "release", "utf8");

        const outputs = [disconnectOutput, await handles[1]!.done];
        outputs.forEach(expectCompactWorkerOutput);
        expect(outputs.every((output) => output.domainStatus === "applied")).toBe(true);
        expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
        const traces = await Promise.all(inputs.map((input) => readTrace(input.traceFilePath)));
        assertOneWorkerRebased(outputs, traces);
        expect(traces.every((trace) =>
          trace.sleeps.every((sleep) => !sleep.inTransaction)
        )).toBe(true);

        const repository = createClientStateRepository(setupSql);
        expect(await repository.findSession(sessionRef)).toMatchObject({
          status: "active",
          generationId: "generation-2",
          generationVersion: 2,
          connectionId: "connection-2",
        });
        await expectPendingWorkerOutboxes(
          toRuntimeRepository(setupSql),
          outputs,
          "client",
          ["client-state-sync"],
        );
        expect(JSON.stringify(outputs)).not.toMatch(/DATABASE_URL|accessToken|commandMac|app:app/u);
      } finally {
        await Promise.allSettled(handles.map((handle) => handle.done));
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await setupSql.end();
        await rm(tmpDirPath, { recursive: true, force: true });
      }
    },
    60_000,
  );

  postgresIt(
    "rebases independent group join and ban workers and retains both accepted mutations",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const setupSql = await createSql(databaseUrl);
      const scope = uniqueScope("group-worker-membership");
      const groupRef: GroupRef = { ...scope, groupId: "room-1" };
      const atEpochMs = Date.now();
      const tmpDirPath = await mkdtemp(path.join(tmpdir(), "rallar-group-worker-race-"));
      const releaseFilePath = path.join(tmpDirPath, "release");
      const inputs: readonly WorkerInput[] = [
        {
          command: "group-join",
          scope,
          groupId: groupRef.groupId,
          atEpochMs: atEpochMs + 1_000,
          traceFilePath: path.join(tmpDirPath, "join-trace.json"),
          barrier: {
            readyFilePath: path.join(tmpDirPath, "join-ready.json"),
            releaseFilePath,
          },
          request: {
            actorPrincipalId: "bob",
            actorSessionId: "bob-session",
            requestId: "worker-group-join-bob",
          },
        },
        {
          command: "group-ban",
          scope,
          groupId: groupRef.groupId,
          targetPrincipalId: "carol",
          atEpochMs: atEpochMs + 1_001,
          traceFilePath: path.join(tmpDirPath, "ban-trace.json"),
          barrier: {
            readyFilePath: path.join(tmpDirPath, "ban-ready.json"),
            releaseFilePath,
          },
          request: {
            actorPrincipalId: "alice",
            actorSessionId: "alice-session",
            requestId: "worker-group-ban-carol",
          },
        },
      ];
      const handles: WorkerHandle[] = [];

      try {
        const setup = createTestGroupStateRuntime({
          runtimeRepository: toRuntimeRepository(setupSql),
          createGroupStateEventStore: createGroupStateEventRepository,
          syncPublisher: createPublisher(),
          now: () => atEpochMs,
          sleep: () => Promise.resolve(),
          serviceId: "postgres-worker-group-setup",
        }).service;
        await setup.createGroup(scope, {
          groupId: groupRef.groupId,
          displayName: "Worker membership race",
          kind: "room",
          joinMode: "open",
          maxMembers: 4,
          createdByPrincipalId: "alice",
          actorPrincipalId: "alice",
          actorSessionId: "alice-session",
          requestId: "worker-group-create",
        });
        await setup.upsertMember(scope, groupRef.groupId, "carol", {
          status: "active",
          actorPrincipalId: "carol",
          actorSessionId: "carol-session",
          requestId: "worker-group-add-carol",
        });
        handles.push(...inputs.map((input) => spawnWorker(databaseUrl, input)));
        await Promise.all(inputs.map((input, index) =>
          waitForWorkerBarrier(input.barrier.readyFilePath, handles[index]!)
        ));
        await writeFile(releaseFilePath, "release", "utf8");

        const outputs = await Promise.all(handles.map((handle) => handle.done));
        outputs.forEach(expectCompactWorkerOutput);
        expect(outputs.every((output) => output.domainStatus === "applied")).toBe(true);
        expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
        expect(outputs.map((output) => output.domainStatus)).toEqual(["applied", "applied"]);
        const traces = await Promise.all(inputs.map((input) => readTrace(input.traceFilePath)));
        assertOneWorkerRebased(outputs, traces);
        expect(traces.every((trace) =>
          trace.sleeps.every((sleep) => !sleep.inTransaction)
        )).toBe(true);

        const repository = createGroupStateRepository(setupSql);
        const snapshot = await repository.readSnapshot(groupRef);
        expect(snapshot?.members.find((member) => member.principalId === "bob"))
          .toMatchObject({ status: "active" });
        expect(snapshot?.members.find((member) => member.principalId === "carol"))
          .toMatchObject({ status: "banned" });
        await expectPendingWorkerOutboxes(
          toRuntimeRepository(setupSql),
          outputs,
          "group",
          ["group-state-sync", "group-presence-summary"],
        );
      } finally {
        await Promise.allSettled(handles.map((handle) => handle.done));
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await setupSql.end();
        await rm(tmpDirPath, { recursive: true, force: true });
      }
    },
    60_000,
  );

  postgresIt(
    "runs group presence connect heartbeat and disconnect through independent barrier workers",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const setupSql = await createSql(databaseUrl);
      const scope = uniqueScope("group-worker-presence-lifecycle");
      const groupRef: GroupRef = { ...scope, groupId: "room-1" };
      const atEpochMs = Date.now();
      const tmpDirPath = await mkdtemp(path.join(tmpdir(), "rallar-group-presence-worker-"));
      const principals = ["bob", "carol"] as const;
      const sessions = ["bob-session", "carol-session"] as const;

      try {
        const setup = createTestGroupStateRuntime({
          runtimeRepository: toRuntimeRepository(setupSql),
          createGroupStateEventStore: createGroupStateEventRepository,
          syncPublisher: createPublisher(),
          now: () => atEpochMs,
          sleep: () => Promise.resolve(),
          serviceId: "postgres-worker-presence-setup",
        }).service;
        await setup.createGroup(scope, {
          groupId: groupRef.groupId,
          displayName: "Worker presence lifecycle",
          kind: "room",
          joinMode: "open",
          maxMembers: 4,
          createdByPrincipalId: "alice",
          actorPrincipalId: "alice",
          actorSessionId: "alice-session",
          requestId: "worker-presence-create",
        });
        for (const principalId of principals) {
          await setup.upsertMember(scope, groupRef.groupId, principalId, {
            status: "active",
            actorPrincipalId: principalId,
            actorSessionId: `${principalId}-session`,
            requestId: `worker-presence-member-${principalId}`,
          });
        }

        const connectInputs: readonly WorkerInput[] = principals.map((principalId, index) => ({
          command: "group-presence-connect",
          scope,
          groupId: groupRef.groupId,
          sessionId: sessions[index],
          atEpochMs: atEpochMs + 1_000,
          traceFilePath: path.join(tmpDirPath, `connect-${index}-trace.json`),
          barrier: workerBarrier(tmpDirPath, `connect-${index}`),
          request: {
            principalId,
            generationId: `generation-${index}`,
            connectedAtEpochMs: atEpochMs + 1_000,
            lastHeartbeatAtEpochMs: atEpochMs + 1_000,
            expiresAtEpochMs: atEpochMs + 61_000,
            actorPrincipalId: principalId,
            actorSessionId: sessions[index],
            requestId: `worker-presence-connect-${index}`,
          },
        }));
        const connected = await runBarrierWorkerPair(databaseUrl, connectInputs);
        connected.outputs.forEach(expectCompactWorkerOutput);
        assertIndependentBarrierWorkers(connected.traces);
        await expectPendingWorkerOutboxes(
          toRuntimeRepository(setupSql), connected.outputs, "group",
          ["group-state-sync", "group-presence-summary"],
        );

        const heartbeatInputs: readonly WorkerInput[] = principals.map((principalId, index) => ({
          command: "group-presence-heartbeat",
          scope,
          groupId: groupRef.groupId,
          sessionId: sessions[index],
          atEpochMs: atEpochMs + 2_000,
          traceFilePath: path.join(tmpDirPath, `heartbeat-${index}-trace.json`),
          barrier: workerBarrier(tmpDirPath, `heartbeat-${index}`),
          request: {
            principalId,
            generationId: `generation-${index}`,
            lastHeartbeatAtEpochMs: atEpochMs + 2_000,
            expiresAtEpochMs: atEpochMs + 62_000,
            actorPrincipalId: principalId,
            actorSessionId: sessions[index],
            requestId: `worker-presence-heartbeat-${index}`,
          },
        }));
        const heartbeats = await runBarrierWorkerPair(databaseUrl, heartbeatInputs);
        heartbeats.outputs.forEach(expectCompactWorkerOutput);
        assertIndependentBarrierWorkers(heartbeats.traces);
        await expectPendingWorkerOutboxes(
          toRuntimeRepository(setupSql), heartbeats.outputs, "group",
          ["group-state-sync", "group-presence-summary"],
        );

        const disconnectInputs: readonly WorkerInput[] = principals.map((principalId, index) => ({
          command: "group-presence-disconnect",
          scope,
          groupId: groupRef.groupId,
          sessionId: sessions[index],
          atEpochMs: atEpochMs + 3_000,
          traceFilePath: path.join(tmpDirPath, `disconnect-${index}-trace.json`),
          barrier: workerBarrier(tmpDirPath, `disconnect-${index}`),
          request: {
            principalId,
            generationId: `generation-${index}`,
            disconnectedAtEpochMs: atEpochMs + 3_000,
            actorPrincipalId: principalId,
            actorSessionId: sessions[index],
            requestId: `worker-presence-disconnect-${index}`,
          },
        }));
        const disconnected = await runBarrierWorkerPair(databaseUrl, disconnectInputs);
        disconnected.outputs.forEach(expectCompactWorkerOutput);
        assertIndependentBarrierWorkers(disconnected.traces);
        await expectPendingWorkerOutboxes(
          toRuntimeRepository(setupSql), disconnected.outputs, "group",
          ["group-state-sync", "group-presence-summary"],
        );

        const repository = createGroupStateRepository(setupSql);
        for (const [index, sessionId] of sessions.entries()) {
          expect(await repository.findPresenceEntry({ ...groupRef, sessionId }))
            .toMatchObject({
              value: {
                principalId: principals[index],
                generationId: `generation-${index}`,
                status: "disconnected",
                disconnectedAtEpochMs: atEpochMs + 3_000,
              },
            });
        }
      } finally {
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await setupSql.end();
        await rm(tmpDirPath, { recursive: true, force: true });
      }
    },
    90_000,
  );

  postgresIt(
    "admits exactly one independent contender for the last group member slot",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const setupSql = await createSql(databaseUrl);
      const leftSql = await createSql(databaseUrl);
      const rightSql = await createSql(databaseUrl);
      const scope = uniqueScope("group-last-slot-capacity");
      const groupRef: GroupRef = { ...scope, groupId: "room-1" };
      const atEpochMs = Date.now();
      const contenderRequestIds = ["postgres-join-bob", "postgres-join-carol"];

      try {
        await createPostgresGroupRuntime(
          setupSql,
          new GroupPresenceReadBarrier(1),
          atEpochMs,
        ).service.createGroup(scope, {
          groupId: groupRef.groupId,
          displayName: "Last slot",
          kind: "room",
          joinMode: "open",
          maxMembers: 2,
          createdByPrincipalId: "alice",
          requestId: "postgres-create-last-slot",
        });

        const barrier = new GroupPresenceReadBarrier(2);
        const left = createPostgresGroupRuntime(
          leftSql,
          barrier,
          atEpochMs + 1_000,
          "group-state:groups",
        ).service;
        const right = createPostgresGroupRuntime(
          rightSql,
          barrier,
          atEpochMs + 1_001,
          "group-state:groups",
        ).service;
        const results = await Promise.allSettled([
          left.joinGroup(scope, groupRef.groupId, {
            actorPrincipalId: "bob",
            requestId: contenderRequestIds[0],
          }),
          right.joinGroup(scope, groupRef.groupId, {
            actorPrincipalId: "carol",
            requestId: contenderRequestIds[1],
          }),
        ]);

        expect(results.filter((result) => result.status === "fulfilled"))
          .toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected"))
          .toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected");
        expect(rejected?.status === "rejected" ? rejected.reason : undefined)
          .toMatchObject({ message: expect.stringMatching(/capacity|full/i) });

        const repository = createGroupStateRepository(setupSql);
        const snapshot = await repository.readSnapshot(groupRef);
        expect(snapshot?.members.filter((member) => member.status === "active"))
          .toHaveLength(2);
        expect(snapshot?.members.filter((member) =>
          member.principalId === "bob" || member.principalId === "carol"
        )).toHaveLength(1);
        const terminalEvents = (await repository.listEvents(groupRef)).filter((event) =>
          event.eventType === "member-joined" &&
          contenderRequestIds.includes(event.requestId ?? "")
        );
        expect(terminalEvents).toHaveLength(1);
        const outbox = await findGroupOutboxRecords(
          setupSql,
          groupRef,
          contenderRequestIds,
        );
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({
          kind: "group",
          aggregateRef: groupRef,
          effects: ["group-state-sync", "group-presence-summary"],
          event: { kind: "group", event: { eventType: "member-joined" } },
        });
      } finally {
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await Promise.all([setupSql.end(), leftSql.end(), rightSql.end()]);
      }
    },
    60_000,
  );

  postgresIt(
    "advances 100 independent session heartbeats across two Postgres services without revising the group aggregate",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const setupSql = await createSql(databaseUrl);
      const leftSql = await createSql(databaseUrl);
      const rightSql = await createSql(databaseUrl);
      const scope = uniqueScope("group-heartbeat-100");
      const groupRef: GroupRef = { ...scope, groupId: "room-1" };
      const atEpochMs = Date.now();
      const sessionCount = 100;

      try {
        const setup = createPostgresGroupRuntime(
          setupSql,
          new GroupPresenceReadBarrier(1),
          atEpochMs,
        ).service;
        await setup.createGroup(scope, {
          groupId: groupRef.groupId,
          displayName: "Heartbeat 100",
          kind: "room",
          joinMode: "open",
          maxMembers: sessionCount + 1,
          createdByPrincipalId: "alice",
          requestId: "postgres-heartbeat-create",
        });
        for (let index = 0; index < sessionCount; index += 1) {
          const principalId = `member-${index}`;
          await setup.upsertMember(scope, groupRef.groupId, principalId, {
            status: "active",
            actorPrincipalId: principalId,
            requestId: `postgres-heartbeat-member-${index}`,
          });
          await setup.connectPresenceSession(
            scope,
            groupRef.groupId,
            `session-${index}`,
            {
              principalId,
              generationId: `generation-${index}`,
              connectedAtEpochMs: atEpochMs,
              lastHeartbeatAtEpochMs: atEpochMs,
              expiresAtEpochMs: atEpochMs + 60_000,
              actorPrincipalId: principalId,
              requestId: `postgres-heartbeat-connect-${index}`,
            },
          );
        }

        const repository = createGroupStateRepository(setupSql);
        const groupBefore = await repository.findGroupEntry(groupRef);
        if (!groupBefore) throw new Error("Expected seeded heartbeat group");
        const sessionRevisions = new Map<string, number>();
        for (let index = 0; index < sessionCount; index += 1) {
          const sessionId = `session-${index}`;
          const entry = await repository.findPresenceEntry({ ...groupRef, sessionId });
          if (!entry) throw new Error(`Expected seeded session ${sessionId}`);
          sessionRevisions.set(sessionId, entry.entry.revision);
        }

        const barrier = new GroupPresenceReadBarrier(sessionCount);
        const left = createPostgresGroupRuntime(
          leftSql,
          barrier,
          atEpochMs + 1_000,
        ).service;
        const right = createPostgresGroupRuntime(
          rightSql,
          barrier,
          atEpochMs + 1_000,
        ).service;
        const heartbeatRequestIds = Array.from(
          { length: sessionCount },
          (_, index) => `postgres-heartbeat-${index}`,
        );
        const heartbeats = await Promise.all(heartbeatRequestIds.map((requestId, index) =>
          (index % 2 === 0 ? left : right).heartbeatPresenceSessionReceipt(
            scope,
            groupRef.groupId,
            `session-${index}`,
            {
              generationId: `generation-${index}`,
              actorPrincipalId: `member-${index}`,
              lastHeartbeatAtEpochMs: atEpochMs + 1_000,
              expiresAtEpochMs: atEpochMs + 120_000,
              requestId,
            },
          )
        ));
        expect(heartbeats).toHaveLength(sessionCount);

        const groupAfter = await repository.findGroupEntry(groupRef);
        expect(groupAfter?.entry.revision).toBe(groupBefore.entry.revision);
        for (let index = 0; index < sessionCount; index += 1) {
          const sessionId = `session-${index}`;
          const entry = await repository.findPresenceEntry({ ...groupRef, sessionId });
          expect(entry?.entry.revision).toBe((sessionRevisions.get(sessionId) ?? -1) + 1);
          expect(entry?.value).toMatchObject({
            generationId: `generation-${index}`,
            lastHeartbeatAtEpochMs: atEpochMs + 1_000,
            expiresAtEpochMs: atEpochMs + 120_000,
          });
        }
        const terminalEvents = (await repository.listEvents(groupRef)).filter((event) =>
          event.eventType === "session-heartbeat" &&
          heartbeatRequestIds.includes(event.requestId ?? "")
        );
        expect(terminalEvents).toHaveLength(sessionCount);
        expect(new Set(terminalEvents.map((event) => event.requestId)).size)
          .toBe(sessionCount);

        const outbox = await findGroupOutboxRecords(
          setupSql,
          groupRef,
          heartbeatRequestIds,
        );
        expect(outbox).toHaveLength(sessionCount);
        expect(new Set(outbox.map((record) => record.commandId)).size)
          .toBe(sessionCount);
        for (const record of outbox) {
          expect(record).toMatchObject({
            kind: "group",
            aggregateRef: groupRef,
            effects: ["group-state-sync", "group-presence-summary"],
            event: { kind: "group", event: { eventType: "session-heartbeat" } },
          });
        }
      } finally {
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await Promise.all([setupSql.end(), leftSql.end(), rightSql.end()]);
      }
    },
    120_000,
  );

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
          createPostgresClientService(leftSql, expiryBarrier, atEpochMs, scope.applicationId)
            .expireExpiredSessions(atEpochMs),
          createPostgresClientService(rightSql, expiryBarrier, atEpochMs, scope.applicationId)
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
          createPostgresClientService(leftSql, reconnectBarrier, atEpochMs, scope.applicationId)
            .expireExpiredSessions(atEpochMs),
          createPostgresClientService(
            rightSql,
            reconnectBarrier,
            atEpochMs + 1,
            scope.applicationId,
          )
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
    "rebases two group expiry CAS workers and writes one durable disconnect event",
    async () => {
      const databaseUrl = requireDatabaseUrl();
      const setupSql = await createSql(databaseUrl);
      const leftSql = await createSql(databaseUrl);
      const rightSql = await createSql(databaseUrl);
      const scope = uniqueScope("group-expiry-concurrency");
      const atEpochMs = Date.now();
      const groupRef: GroupRef = {
        ...scope,
        groupId: "room-1",
      };
      const sessionId = "session-1";

      try {
        await seedExpiredGroupPresenceSession(
          setupSql,
          scope,
          groupRef,
          sessionId,
          atEpochMs,
        );
        const expiryBarrier = new GroupPresenceReadBarrier(2);
        const [leftResults, rightResults] = await Promise.all([
          createPostgresGroupRuntime(
            leftSql,
            expiryBarrier,
            atEpochMs,
            "group-state:sessions",
            scope.applicationId,
          )
            .maintenance.expireExpiredPresenceSessions(atEpochMs),
          createPostgresGroupRuntime(
            rightSql,
            expiryBarrier,
            atEpochMs,
            "group-state:sessions",
            scope.applicationId,
          )
            .maintenance.expireExpiredPresenceSessions(atEpochMs),
        ]);
        expect(leftResults.length + rightResults.length).toBe(1);

        const repository = createGroupStateRepository(setupSql);
        const session = await repository.findPresenceSession({
          ...groupRef,
          sessionId,
        });
        const events = await repository.listEvents(groupRef);

        expect(session).toBeUndefined();
        expect(
          events.filter(
            (event) =>
              event.eventType === "session-disconnected" &&
              event.reason === "expired",
          ),
        ).toHaveLength(1);
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
    "rolls back a real group expiry delete when its outbox insert collides",
    async () => {
      const sql = await createSql(requireDatabaseUrl());
      const scope = uniqueScope("group-expiry-rollback");
      const atEpochMs = Date.now();
      const groupRef: GroupRef = { ...scope, groupId: "room-1" };
      const sessionId = "session-1";
      let collisionKey: string | undefined;

      try {
        await seedExpiredGroupPresenceSession(sql, scope, groupRef, sessionId, atEpochMs);
        const repository = createGroupStateRepository(sql);
        const groupEntry = await repository.findGroupEntry(groupRef);
        const sessionEntry = await repository.findPresenceEntry({ ...groupRef, sessionId });
        const presenceSummary = await repository.findPresenceSummaryEntry(groupRef);
        if (!groupEntry || !sessionEntry) throw new Error("Expected seeded group presence");
        const semanticCommand = {
          operation: "disconnectPresence",
          aggregateRef: groupRef,
          sessionId,
          input: {
            principalId: sessionEntry.value.principalId,
            generationId: sessionEntry.value.generationId,
            generationVersion: sessionEntry.value.generationVersion,
            observedExpiresAtEpochMs: sessionEntry.value.expiresAtEpochMs,
            disconnectedAtEpochMs: atEpochMs,
            lastHeartbeatAtEpochMs: sessionEntry.value.lastHeartbeatAtEpochMs,
            expiresAtEpochMs: sessionEntry.value.expiresAtEpochMs,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: "expired",
            traceId: null,
          },
        } as const;
        const commandId = groupStateMaintenanceRequestId("expiry", semanticCommand);
        const groupRevision = groupEntry.entry.revision + 1;
        const presenceRevision =
          presenceSummary?.value.causalRevision.presenceRevision ?? 0;
        const outboxId = toStateMutationOutboxId({
          kind: "group",
          aggregateRef: groupRef,
          commandId,
          acceptedCausalRevision: {
            kind: "group",
            stateRevision: toGroupSnapshotStateRevision(
              groupRevision,
              presenceRevision,
            ),
            causalRevision: {
              groupRevision,
              presenceRevision,
            },
            snapshotVersion: groupEntry.value.snapshotVersion,
            metadataVersion: groupEntry.value.metadataVersion,
            rosterVersion: groupEntry.value.rosterVersion,
            presenceVersion: presenceRevision,
          },
        });
        collisionKey = `intent:${outboxId}`;
        await toRuntimeRepository(sql).insertIfAbsent(
          STATE_MUTATION_OUTBOX_NAMESPACE,
          collisionKey,
          "{}",
          NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(createPostgresGroupRuntime(
          sql,
          new GroupPresenceReadBarrier(1),
          atEpochMs,
          "group-state:sessions",
          scope.applicationId,
        ).maintenance.expireExpiredPresenceSessions(atEpochMs)).rejects.toMatchObject({
          code: "state-mutation-outbox-collision",
          status: 409,
        });

        expect(await repository.findPresenceSession({ ...groupRef, sessionId }))
          .toMatchObject({ generationId: sessionEntry.value.generationId });
        expect((await repository.listEvents(groupRef)).filter((event) =>
          event.eventType === "session-disconnected"
        )).toEqual([]);
        expect(await repository.findIdempotentGroupMutationReceipt(groupRef, commandId))
          .toBeUndefined();
      } finally {
        if (collisionKey) {
          await toRuntimeRepository(sql).deleteByKey(
            STATE_MUTATION_OUTBOX_NAMESPACE,
            collisionKey,
          );
        }
        await cleanupRuntimeState(sql, scope.applicationId);
        await sql.end();
      }
    },
    60_000,
  );

  postgresIt(
    "isolates absent and explicit sentinel workspaces at the live group repository and event boundaries",
    async () => {
      const sql = await createSql(requireDatabaseUrl());
      const applicationId = uniqueScope("group-scope-key-isolation")
        .applicationId;
      const absentGroup = groupFixture({
        applicationId,
        workspaceId: "workspace-default",
        groupId: "shared-group",
      }, "Absent workspace");
      const explicitSentinelGroup = groupFixture({
        applicationId,
        workspaceId: "_",
        groupId: "shared-group",
      }, "Explicit sentinel workspace");

      try {
        const repository = createGroupStateRepository(sql);
        await repository.putGroup(absentGroup);
        await repository.putGroup(explicitSentinelGroup);

        expect(await repository.findGroup(absentGroup)).toEqual(absentGroup);
        expect(await repository.findGroup(explicitSentinelGroup)).toEqual(
          explicitSentinelGroup,
        );
        expect(await repository.listGroups({
          applicationId,
          workspaceId: "workspace-default",
        })).toEqual([
          absentGroup,
        ]);
        expect(await repository.listGroups({
          applicationId,
          workspaceId: "_",
        })).toEqual([explicitSentinelGroup]);

        const eventStore = createGroupStateEventRepository(sql);
        const eventFor = (
          ref: GroupRef,
          reason: string,
          snapshotVersion: number,
        ): GroupEvent => ({
          applicationId: ref.applicationId,
          workspaceId: ref.workspaceId,
          groupId: ref.groupId,
          eventId: "shared-event",
          eventType: "group-updated",
          snapshotVersion,
          causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: 0,
          },
          occurredAtEpochMs: Date.now() + snapshotVersion,
          actor: {
            kind: "service",
            serviceId: "postgres-group-event-key-test",
          },
          reason,
          traceId: null,
          requestId: null,
          payload: {},
        });
        const absentEvent = eventFor(absentGroup, "absent", 1);
        const explicitSentinelEvent = eventFor(
          explicitSentinelGroup,
          "explicit-sentinel",
          2,
        );
        await eventStore.appendGroupEvent(absentEvent);
        await eventStore.appendGroupEvent(explicitSentinelEvent);
        expect(await eventStore.listGroupEvents(absentGroup)).toEqual([
          absentEvent,
        ]);
        expect(await eventStore.listRecentGroupEvents?.(absentGroup, {}))
          .toEqual([absentEvent]);
        expect((await eventStore.listGroupEventPage(absentGroup, {
          limit: 10,
        })).events).toEqual([absentEvent]);
        expect(await eventStore.listGroupEvents(explicitSentinelGroup)).toEqual([
          explicitSentinelEvent,
        ]);
        expect(await eventStore.listRecentGroupEvents?.(
          explicitSentinelGroup,
          {},
        )).toEqual([explicitSentinelEvent]);
        expect((await eventStore.listGroupEventPage(explicitSentinelGroup, {
          limit: 10,
        })).events).toEqual([explicitSentinelEvent]);
      } finally {
        await cleanupRuntimeState(sql, applicationId);
        await sql.end();
      }
    },
    60_000,
  );
});

function groupFixture(ref: GroupRef, displayName: string): Group {
  const audit: AuditStamp = {
    atEpochMs: Date.now(),
    actor: { kind: "service", serviceId: "postgres-group-key-test" },
    reason: null,
    traceId: null,
    requestId: null,
  };
  return {
    ...ref,
    slug: null,
    displayName,
    description: null,
    kind: "room",
    status: "active",
    archived: null,
    deleted: null,
    joinMode: "open",
    maxMembers: null,
    maxSessionsPerMember: null,
    metadata: {},
    activeMemberCount: 1,
    ownerPrincipalId: "alice",
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    expiresAtEpochMs: null,
    emptySinceEpochMs: null,
    purgeAfterEpochMs: null,
    created: audit,
    updated: audit,
  };
}

async function seedExpiredClientSession(
  sql: PostgresSql,
  scope: StateScope,
  sessionRef: ClientSessionRef,
  atEpochMs: number,
): Promise<void> {
  await createPostgresClientPhaseDriver(
    sql,
    toRuntimeRepository(sql),
    atEpochMs - 10_000,
    "postgres-expiry-test-setup",
  ).connectSession(
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
  const service = createTestGroupStateRuntime({
    runtimeRepository: toRuntimeRepository(sql),
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => atEpochMs - 10_000,
    serviceId: "postgres-expiry-test-setup",
  }).service;

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
    generationId: "generation-1",
    principalId: "alice",
    connectedAtEpochMs: atEpochMs - 20_000,
    lastHeartbeatAtEpochMs: atEpochMs - 10_000,
    expiresAtEpochMs: atEpochMs - 1_000,
    actorPrincipalId: "alice",
    actorSessionId: sessionId,
    requestId: "seed-group-presence-session",
  });
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
  await sql`
        delete from runtime_state_store
        where store_namespace = ${STATE_MUTATION_OUTBOX_NAMESPACE}
          and store_value::jsonb -> 'aggregateRef' ->> 'applicationId' = ${applicationId}
    `;
}

async function findGroupOutboxRecords(
  sql: PostgresSql,
  ref: GroupRef,
  commandIds: readonly string[],
): Promise<readonly StateMutationOutboxRecord[]> {
  const commandIdSet = new Set(commandIds);
  return (await toRuntimeRepository(sql).findAllEntries(
    STATE_MUTATION_OUTBOX_NAMESPACE,
  ))
    .map((entry) => JSON.parse(entry.value) as StateMutationOutboxRecord)
    .filter((record) =>
      record.kind === "group" &&
      record.aggregateRef.applicationId === ref.applicationId &&
      record.aggregateRef.workspaceId === ref.workspaceId &&
      record.aggregateRef.groupId === ref.groupId &&
      commandIdSet.has(record.commandId)
    );
}

function createSql(databaseUrl: string): PostgresSql {
  const postgres = createRequire(import.meta.url)("postgres") as PostgresFactory;

  return postgres(databaseUrl, { max: 1, idle_timeout: 1 });
}

function toRuntimeRepository(sql: PostgresSql): PSqlRuntimeStateRepository {
  return new PSqlRuntimeStateRepository(sql as unknown as PSqlSql);
}

function createPostgresClientPhaseDriver(
  sql: PostgresSql,
  runtimeRepository: PSqlRuntimeStateRepository,
  atEpochMs: number,
  serviceId: string,
) {
  const service = createClientStateService({
    runtimeRepository,
    createClientStateEventStore: createClientStateEventRepository,
    serviceId,
  });
  const execute = async (
    commandInput: ClientMutationCommandInput,
    authority: IssuedAuthSession | null,
  ): Promise<ClientMutationComputed> => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const command = await toClientMutationCommand(
        commandInput,
        {
          nowEpochMs: atEpochMs,
          serviceId,
          eventId: `postgres-client-event:${commandInput.commandId}`,
          attemptCount: attempt,
          expireAtEpochMs: atEpochMs + 24 * 60 * 60 * 1_000,
        },
        commandInput.operation === "expireSession"
          ? toClientMutationSystemAuthority(serviceId)
          : authority
          ? toClientMutationIssuedSessionAuthority(
            authority,
            commandInput.aggregateRef,
            commandInput.operation,
          )
          : missingPostgresClientAuthority(),
      );
      const read = await service.read(command);
      const computed = service.compute(command, read);
      service.validate(command, read, computed);
      try {
        if (requiresClientWrite(computed)) {
          await sql.begin(async (transaction) => await service.write(transaction, computed));
        }
        return computed;
      } catch (error) {
        if (!(error instanceof RuntimeStateWriteConflictError) || attempt === 8) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(16, 2 ** (attempt - 1))));
      }
    }
    throw new Error("Postgres client AppInbox-equivalent attempts exhausted");
  };

  return {
    connectSession: async (
      scope: StateScope,
      principalId: string,
      clientInstanceId: string,
      sessionId: string,
      request: ConnectClientSessionRequest,
    ) => {
      const authority: IssuedAuthSession = {
        clientId: principalId,
        accessToken: `${sessionId}-postgres-test-token`,
        username: principalId,
        sessionId,
        issuedAtEpochMs: Math.max(0, atEpochMs - 1),
        expiresAtEpochMs: atEpochMs + 24 * 60 * 60 * 1_000,
      };
      await new AuthSessionRepository(runtimeRepository).putSession(authority);
      return await execute(
        toConnectCommandInput(
          "connectSession",
          scope,
          principalId,
          clientInstanceId,
          sessionId,
          request,
          request.requestId ?? `postgres-connect:${sessionId}`,
          {},
        ),
        authority,
      );
    },
    expireExpiredSessions: async (expiryAtEpochMs: number) => {
      const written: ClientMutationComputed[] = [];
      for (const candidate of await service.listExpiredSessionCandidates(expiryAtEpochMs)) {
        const computed = await execute(toExpiryCommandInput(candidate), null);
        if (computed.outcome === "write") written.push(computed);
      }
      return written;
    },
  };
}

function missingPostgresClientAuthority(): never {
  throw new Error("Issued client authority is required");
}

function createPostgresClientService(
  sql: PostgresSql,
  barrier: PrincipalReadBarrier,
  atEpochMs: number,
  applicationId?: string,
) {
  const runtimeRepository = new BarrierPSqlRuntimeStateRepository(
    sql as unknown as PSqlSql,
    barrier,
    applicationId,
  );
  return createPostgresClientPhaseDriver(
    sql,
    runtimeRepository,
    atEpochMs,
    "postgres-client-cas-worker",
  );
}

function createPostgresGroupRuntime(
  sql: PostgresSql,
  barrier: GroupPresenceReadBarrier,
  atEpochMs: number,
  barrierNamespace = "group-state:sessions",
  applicationId?: string,
) {
  return createTestGroupStateRuntime({
    runtimeRepository: new BarrierGroupPSqlRuntimeStateRepository(
      sql as unknown as PSqlSql,
      barrier,
      barrierNamespace,
      applicationId,
    ),
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => atEpochMs,
    sleep: () => Promise.resolve(),
    serviceId: "postgres-group-cas-worker",
  });
}

class BarrierPSqlRuntimeStateRepository extends PSqlRuntimeStateRepository {
  constructor(
    sql: PSqlSql,
    private readonly barrier: PrincipalReadBarrier,
    private readonly applicationId?: string,
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

  override async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
    const entries = await super.findAllEntries(namespace);
    return this.applicationId === undefined
      ? entries
      : entries.filter((entry) => entry.key.startsWith(
        `app=${encodeURIComponent(this.applicationId!)}:`,
      ));
  }
}

class BarrierGroupPSqlRuntimeStateRepository
  extends PSqlRuntimeStateRepository {
  constructor(
    sql: PSqlSql,
    private readonly barrier: GroupPresenceReadBarrier,
    private readonly barrierNamespace = "group-state:sessions",
    private readonly applicationId?: string,
  ) {
    super(sql);
  }

  override async findEntry(
    namespace: string,
    key: string,
  ): Promise<RuntimeStateEntry | undefined> {
    const entry = await super.findEntry(namespace, key);
    if (namespace === this.barrierNamespace) {
      await this.barrier.arrive();
    }
    return entry;
  }

  override async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
    const entries = await super.findAllEntries(namespace);
    return this.applicationId === undefined
      ? entries
      : entries.filter((entry) => entry.key.startsWith(
        `app=${encodeURIComponent(this.applicationId!)}:`,
      ));
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

class GroupPresenceReadBarrier extends PrincipalReadBarrier {}

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

async function seedConnectedClientSession(
  sql: PostgresSql,
  scope: StateScope,
  sessionRef: ClientSessionRef,
  atEpochMs: number,
): Promise<void> {
  await createPostgresClientPhaseDriver(
    sql,
    toRuntimeRepository(sql),
    atEpochMs,
    "postgres-worker-client-setup",
  ).connectSession(scope, sessionRef.principalId, sessionRef.clientInstanceId, sessionRef.sessionId, {
    generationId: "generation-1",
    connectionId: "connection-1",
    connectedAtEpochMs: atEpochMs,
    lastHeartbeatAtEpochMs: atEpochMs,
    expiresAtEpochMs: atEpochMs + 60_000,
    actorPrincipalId: sessionRef.principalId,
    actorSessionId: sessionRef.sessionId,
    requestId: "worker-client-seed",
  });
}

function spawnWorker(databaseUrl: string, input: WorkerInput): WorkerHandle {
  const child = spawn(process.env.DENO_BIN ?? "deno", [
    "run", "-A", "--unstable-temporal", "--node-modules-dir=none", "--no-lock",
    "--config", ROOT_DENO_CONFIG_PATH, STATE_MUTATION_WORKER_PATH,
  ], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      RALLAR_EXPIRY_WORKER_INPUT: JSON.stringify(input),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  return {
    done: new Promise<WorkerOutput>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new Error(`State mutation worker failed (${code})\n${stdout}\n${stderr}`));
          return;
        }
        const lastLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
        if (!lastLine) {
          reject(new Error(`State mutation worker produced no JSON\n${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(lastLine) as WorkerOutput);
        } catch (error) {
          reject(new Error(`State mutation worker produced invalid JSON: ${lastLine}`, {
            cause: error,
          }));
        }
      });
    }),
  };
}

function workerBarrier(
  tmpDirPath: string,
  name: string,
): WorkerInput["barrier"] {
  return {
    readyFilePath: path.join(tmpDirPath, `${name}-ready.json`),
    releaseFilePath: path.join(tmpDirPath, `${name}-release`),
  };
}

async function runBarrierWorkerPair(
  databaseUrl: string,
  inputs: readonly WorkerInput[],
): Promise<Readonly<{
  outputs: readonly WorkerOutput[];
  traces: readonly WorkerTrace[];
}>> {
  expect(inputs).toHaveLength(2);
  const handles = inputs.map((input) => spawnWorker(databaseUrl, input));
  try {
    await Promise.all(inputs.map((input, index) =>
      waitForWorkerBarrier(input.barrier.readyFilePath, handles[index]!)
    ));
    await Promise.all(inputs.map((input) =>
      writeFile(input.barrier.releaseFilePath, "release", "utf8")
    ));
    return {
      outputs: await Promise.all(handles.map((handle) => handle.done)),
      traces: await Promise.all(inputs.map((input) => readTrace(input.traceFilePath))),
    };
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.done));
  }
}

function assertIndependentBarrierWorkers(traces: readonly WorkerTrace[]): void {
  expect(traces).toHaveLength(2);
  expect(traces.every((trace) => trace.barrierWaitCount === 1)).toBe(true);
  expect(new Set(traces.map((trace) => trace.backendPid)).size).toBe(2);
  expect(traces.every((trace) =>
    trace.sleeps.every((sleep) => !sleep.inTransaction)
  )).toBe(true);
}

async function waitForWorkerBarrier(readyFilePath: string, handle: WorkerHandle): Promise<void> {
  const waitForFile = async (): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await readFile(readyFilePath, "utf8");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`Timed out waiting for worker barrier: ${readyFilePath}`);
  };
  await Promise.race([
    waitForFile(),
    handle.done.then(() => {
      throw new Error(`Worker exited before reaching barrier: ${readyFilePath}`);
    }),
  ]);
}

async function readTrace(traceFilePath: string): Promise<WorkerTrace> {
  return JSON.parse(await readFile(traceFilePath, "utf8")) as WorkerTrace;
}

function expectCompactWorkerOutput(output: WorkerOutput): void {
  expect(Object.keys(output).sort()).toEqual([
    "acceptedCausalRevision", "acceptedStorageRevision", "acceptedVersion",
    "attemptCount", "commandHash", "domainStatus", "operation", "outboxIds", "requestId",
  ]);
  expect(output.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(output.requestId).toMatch(/\S/u);
  expect(output.attemptCount).toBeGreaterThanOrEqual(1);
  expect(output.attemptCount).toBeLessThanOrEqual(3);
  if (output.domainStatus === "applied") {
    expect(output.outboxIds).toHaveLength(1);
    expect(output.outboxIds[0]).toMatch(/\S/u);
  }
}

async function expectPendingWorkerOutboxes(
  runtimeRepository: PSqlRuntimeStateRepository,
  outputs: readonly WorkerOutput[],
  kind: "client" | "group",
  effects: readonly string[],
): Promise<void> {
  outputs.forEach((output) => {
    expect(output.domainStatus).toBe("applied");
    expect(output.outboxIds).toHaveLength(1);
    expect(output.outboxIds[0]).toMatch(/\S/u);
  });
  const outboxIds = outputs.map((output) => output.outboxIds[0]!);
  expect(new Set(outboxIds).size).toBe(outboxIds.length);
  const records = await listAllPendingOutboxes(
    new StateMutationOutboxRepository(runtimeRepository),
  );
  const recordsById = new Map(records.map((stored) => [stored.record.outboxId, stored]));
  expect(outboxIds.every((outboxId) => recordsById.has(outboxId))).toBe(true);
  for (const outboxId of outboxIds) {
    const stored = recordsById.get(outboxId);
    expect(stored?.record).toMatchObject({
      outboxId,
      kind,
      effects,
      delivery: { status: "pending" },
      attempts: { last: { status: "never-attempted" } },
    });
  }
}

async function listAllPendingOutboxes(
  repository: StateMutationOutboxRepository,
): Promise<readonly StoredStateMutationOutboxRecord[]> {
  const records: StoredStateMutationOutboxRecord[] = [];
  let afterKey: string | undefined;
  do {
    const page = await repository.listPendingPage({ afterKey, limit: 100 });
    records.push(...page.records);
    afterKey = page.nextAfterKey ?? undefined;
  } while (afterKey !== undefined);
  return records;
}

function assertOneWorkerRebased(outputs: readonly WorkerOutput[], traces: readonly WorkerTrace[]) {
  expect(traces.every((trace) => trace.barrierWaitCount === 1)).toBe(true);
  expect(new Set(traces.map((trace) => trace.backendPid)).size).toBe(2);
  const loserIndex = outputs.findIndex((output) => output.attemptCount === 2);
  expect(loserIndex).toBeGreaterThanOrEqual(0);
  const loser = traces[loserIndex]!;
  for (const phase of ["mutation.read", "mutation.compute", "mutation.validate"]) {
    expect(loser.phases.filter((event) => event.operation === phase)
      .map((event) => event.attempt)).toEqual([0, 1]);
  }
  expect(loser.phases.filter((event) => event.operation === "mutation.conflict"))
    .toHaveLength(1);
  expect(loser.sleeps).toContainEqual({ delayMs: 2, inTransaction: false });
  expect(traces.flatMap((trace) => trace.phases)
    .filter((event) => event.operation === "mutation.conflict")).toHaveLength(1);
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1",
    );
  }

  return databaseUrl;
}
