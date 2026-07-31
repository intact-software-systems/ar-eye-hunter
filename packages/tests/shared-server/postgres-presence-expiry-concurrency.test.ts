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
  StateScope,
} from "@shared/api/state-types.ts";
import { NEVER_EXPIRE_AT_TIMESTAMP } from "@shared/persistence/PersistenceProvider.ts";
import type { PSqlSql } from "@shared-server/postgres/PostgresSqlClient.ts";
import type { RuntimeStateEntry } from "@shared-server/runtime-state/RuntimeStateRepository.ts";
import {
  createClientStateRepository,
  createGroupStateEventRepository,
  createGroupStateRepository,
} from "@shared-server/postgres/rallar-system/createStateRepositories.ts";
import { PSqlRuntimeStateRepository } from "@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts";
import { createTestGroupStateRuntime } from "./group-state/group-state-test-runtime.ts";
import type { StateSyncPublisher } from "@shared-server/rallar-system/state-sync-publisher.ts";
import { groupStateMaintenanceRequestId } from "@shared-server/rallar-system/services/group-state-service.ts";
import type { GroupMutationReceipt } from "@shared-server/rallar-system/services/group-state-mutations.ts";
import { AppInboxType } from "@shared-server/rallar-system/services/AppInboxService.ts";
import { createPostgresClientPhaseDriver } from "./postgres-client-phase-driver.ts";
import {
  createPostgresAppInboxTestAuthority as testAuthority,
  createPostgresAppInboxWorkerRuntime,
  createPostgresAppInboxWorkerTrace as appInboxTrace,
  findSingleRetriedAppInboxAttemptSequence,
  groupAppInboxStart as groupInboxStart,
  runGroupAppInbox as runGroupInbox,
  unwrapAppInboxResult as unwrapAppInbox,
  waitForPostgresAppInboxWorkerParticipants,
} from
  "./fixtures/postgres-app-inbox-worker-runtime.ts";
import { findDirectResourceOutboxEvidence } from "./direct-resource-outbox-evidence.ts";
import { readOwnedAppInboxResourceIds } from "./postgres-app-inbox-attempt-evidence.ts";
import {
  expectWorkerOutboxLifecycleEvidence,
  type WorkerOutboxEffect,
} from "./postgres-worker-outbox-evidence.ts";

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
  barrier: Readonly<{ readyDirectoryPath: string; releaseFilePath: string }>;
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
  attempts: readonly Readonly<{
    resourceId: string;
    attempt: number;
    classification: "accepted" | "retryable" | "non-retryable";
    status: string;
    retryDelayMs: number;
  }>[];
}>;
type WorkerHandle = Readonly<{ done: Promise<WorkerOutput> }>;
interface AssertOneWorkerRebasedInput {
  readonly sql: PSqlSql;
  readonly scope: StateScope;
  readonly outputs: readonly WorkerOutput[];
  readonly traces: readonly WorkerTrace[];
}

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
            readyDirectoryPath: path.join(tmpDirPath, "client-ready"),
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
            readyDirectoryPath: path.join(tmpDirPath, "group-ready"),
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

        await Promise.all(handles.map((handle) =>
          expect(handle.done).rejects.toThrow("requestId is required")
        ));
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
          readyDirectoryPath: path.join(tmpDirPath, "heartbeat-ready"),
          releaseFilePath: path.join(tmpDirPath, "heartbeat-release"),
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
        await waitForPostgresAppInboxWorkerParticipants(
          inputs[0]!.barrier.readyDirectoryPath, handles.length,
          handles.map((handle) => handle.done),
        );
        await writeFile(inputs[0]!.barrier.releaseFilePath, "release", "utf8");
        const outputs = await Promise.all(handles.map((handle) => handle.done));

        outputs.forEach(expectCompactWorkerOutput);
        expect(outputs.find((output) => output.requestId === "worker-client-heartbeat-1"))
          .toMatchObject({ domainStatus: "applied" });
        expect(outputs.find((output) => output.requestId === "worker-client-heartbeat-0")
          ?.domainStatus).toMatch(/^(applied|no-op)$/u);
        expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
        const traces = await Promise.all(inputs.map((input) => readTrace(input.traceFilePath)));
        await assertOneWorkerRebased({ sql: setupSql, scope, outputs, traces });
        expect(await createClientStateRepository(setupSql).findSession(sessionRef))
          .toMatchObject({
            generationId: "generation-1",
            lastHeartbeatAtEpochMs: atEpochMs + 1_001,
            expiresAtEpochMs: atEpochMs + 61_001,
          });
        await expectPendingWorkerOutboxes(
          setupSql,
          outputs.filter((output) => output.domainStatus === "applied"),
          "client",
          ["principal-state:snapshot", "principal-state:event"],
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
      const releaseFilePath = path.join(tmpDirPath, "client-race-release");
      const inputs: readonly WorkerInput[] = [
        {
          command: "client-disconnect",
          scope,
          atEpochMs: atEpochMs + 1_000,
          traceFilePath: path.join(tmpDirPath, "disconnect-trace.json"),
          barrier: {
            readyDirectoryPath: path.join(tmpDirPath, "client-race-ready"),
            releaseFilePath,
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
            readyDirectoryPath: path.join(tmpDirPath, "client-race-ready"),
            releaseFilePath,
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
        await waitForPostgresAppInboxWorkerParticipants(
          inputs[0]!.barrier.readyDirectoryPath, handles.length,
          handles.map((handle) => handle.done),
        );
        await writeFile(releaseFilePath, "release", "utf8");

        const outputs = await Promise.all(handles.map((handle) => handle.done));
        outputs.forEach(expectCompactWorkerOutput);
        expect(outputs.find((output) => output.operation === "client-reconnect"))
          .toMatchObject({ domainStatus: "applied" });
        expect(outputs.find((output) => output.operation === "client-disconnect")?.domainStatus)
          .toMatch(/^(applied|no-op)$/u);
        expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
        const traces = await Promise.all(inputs.map((input) => readTrace(input.traceFilePath)));
        await assertOneWorkerRebased({ sql: setupSql, scope, outputs, traces });

        const repository = createClientStateRepository(setupSql);
        expect(await repository.findSession(sessionRef)).toMatchObject({
          status: "active",
          generationId: "generation-2",
          generationVersion: 2,
          connectionId: "connection-2",
        });
        await expectPendingWorkerOutboxes(
          setupSql,
          outputs.filter((output) => output.domainStatus === "applied"),
          "client",
          ["principal-state:snapshot", "principal-state:event"],
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
            readyDirectoryPath: path.join(tmpDirPath, "membership-ready"),
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
            readyDirectoryPath: path.join(tmpDirPath, "membership-ready"),
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
        await waitForPostgresAppInboxWorkerParticipants(
          inputs[0]!.barrier.readyDirectoryPath, handles.length,
          handles.map((handle) => handle.done),
        );
        await writeFile(releaseFilePath, "release", "utf8");

        const outputs = await Promise.all(handles.map((handle) => handle.done));
        outputs.forEach(expectCompactWorkerOutput);
        expect(outputs.every((output) => output.domainStatus === "applied")).toBe(true);
        expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
        expect(outputs.map((output) => output.domainStatus)).toEqual(["applied", "applied"]);
        const traces = await Promise.all(inputs.map((input) => readTrace(input.traceFilePath)));
        await assertOneWorkerRebased({ sql: setupSql, scope, outputs, traces });
        const repository = createGroupStateRepository(setupSql);
        const snapshot = await repository.readSnapshot(groupRef);
        expect(snapshot?.members.find((member) => member.principalId === "bob"))
          .toMatchObject({ status: "active" });
        expect(snapshot?.members.find((member) => member.principalId === "carol"))
          .toMatchObject({ status: "banned" });
        await expectPendingWorkerOutboxes(
          setupSql,
          outputs,
          "group",
          ["group-presence-summary"],
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
          barrier: workerBarrier(tmpDirPath, "connect"),
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
          setupSql, connected.outputs, "group",
          ["group-presence-summary"],
        );

        const heartbeatInputs: readonly WorkerInput[] = principals.map((principalId, index) => ({
          command: "group-presence-heartbeat",
          scope,
          groupId: groupRef.groupId,
          sessionId: sessions[index],
          atEpochMs: atEpochMs + 2_000,
          traceFilePath: path.join(tmpDirPath, `heartbeat-${index}-trace.json`),
          barrier: workerBarrier(tmpDirPath, "heartbeat"),
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
          setupSql, heartbeats.outputs, "group",
          ["group-presence-summary"],
        );

        const disconnectInputs: readonly WorkerInput[] = principals.map((principalId, index) => ({
          command: "group-presence-disconnect",
          scope,
          groupId: groupRef.groupId,
          sessionId: sessions[index],
          atEpochMs: atEpochMs + 3_000,
          traceFilePath: path.join(tmpDirPath, `disconnect-${index}-trace.json`),
          barrier: workerBarrier(tmpDirPath, "disconnect"),
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
          setupSql, disconnected.outputs, "group",
          ["group-presence-summary"],
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
      const leftSql = await createSql(databaseUrl, 2);
      const rightSql = await createSql(databaseUrl, 2);
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
        const left = createPostgresAppInboxWorkerRuntime({
          sql: leftSql, serviceId: "last-slot-left", atEpochMs: atEpochMs + 1_000,
          beforeMutationTransaction: () => barrier.arrive(), trace: appInboxTrace(),
        });
        const right = createPostgresAppInboxWorkerRuntime({
          sql: rightSql, serviceId: "last-slot-right", atEpochMs: atEpochMs + 1_001,
          beforeMutationTransaction: () => barrier.arrive(), trace: appInboxTrace(),
        });
        const authorities = [
          testAuthority("bob", "bob-session"),
          testAuthority("carol", "carol-session"),
        ] as const;
        await Promise.all([
          left.authSessions.putSession(authorities[0]),
          right.authSessions.putSession(authorities[1]),
        ]);
        left.armBarrier();
        right.armBarrier();
        const results = await Promise.allSettled([
          runGroupInbox(left, authorities[0], AppInboxType.GROUP_JOIN, {
            scope, groupId: groupRef.groupId,
            request: { actorPrincipalId: "bob", actorSessionId: "bob-session",
              requestId: contenderRequestIds[0] },
          }),
          runGroupInbox(right, authorities[1], AppInboxType.GROUP_JOIN, {
            scope, groupId: groupRef.groupId,
            request: { actorPrincipalId: "carol", actorSessionId: "carol-session",
              requestId: contenderRequestIds[1] },
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
        const acceptedRequestId = terminalEvents[0]?.requestId;
        const receipt = acceptedRequestId
          ? (await repository.findIdempotentGroupMutationReceipt(
            groupRef, acceptedRequestId,
          ))?.receipt
          : undefined;
        if (!receipt) throw new Error("Expected accepted last-slot receipt");
        expectWorkerOutboxLifecycleEvidence(
          await findDirectResourceOutboxEvidence(setupSql, receipt.outboxIds),
          [{ outboxIds: receipt.outboxIds, domainStatus: "applied" }],
          "group", ["group-presence-summary"],
        );
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
      const leftSql = await createSql(databaseUrl, 2);
      const rightSql = await createSql(databaseUrl, 2);
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

        const left = createPostgresAppInboxWorkerRuntime({
          sql: leftSql, serviceId: "heartbeat-100-left",
          atEpochMs: atEpochMs + 1_000, trace: appInboxTrace(),
        });
        const right = createPostgresAppInboxWorkerRuntime({
          sql: rightSql, serviceId: "heartbeat-100-right",
          atEpochMs: atEpochMs + 1_000, trace: appInboxTrace(),
        });
        const heartbeatRequestIds = Array.from(
          { length: sessionCount },
          (_, index) => `postgres-heartbeat-${index}`,
        );
        const authorities = heartbeatRequestIds.map((_, index) =>
          testAuthority(`member-${index}`, `session-${index}`)
        );
        await Promise.all(authorities.map((authority, index) =>
          (index % 2 === 0 ? left : right).authSessions.putSession(authority)
        ));
        const starts = heartbeatRequestIds.map((requestId, index) =>
          groupInboxStart<GroupMutationReceipt>(
            index % 2 === 0 ? left : right,
            authorities[index]!,
            AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            {
              scope, groupId: groupRef.groupId, sessionId: `session-${index}`,
              request: {
              principalId: `member-${index}`,
              generationId: `generation-${index}`,
              actorPrincipalId: `member-${index}`,
              actorSessionId: `session-${index}`,
              lastHeartbeatAtEpochMs: atEpochMs + 1_000,
              expiresAtEpochMs: atEpochMs + 120_000,
              requestId,
              },
            },
          )
        );
        const [leftResults, rightResults] = await Promise.all([
          left.runUntilAllCompletion(starts.filter((_, index) => index % 2 === 0)),
          right.runUntilAllCompletion(starts.filter((_, index) => index % 2 === 1)),
        ]);
        const heartbeats = [...leftResults, ...rightResults].map(unwrapAppInbox);
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

        const outboxIds = heartbeats.flatMap((receipt) => receipt.outboxIds);
        expect(outboxIds).toHaveLength(sessionCount);
        expectWorkerOutboxLifecycleEvidence(
          await findDirectResourceOutboxEvidence(setupSql, outboxIds),
          heartbeats.map((receipt) => ({
            outboxIds: receipt.outboxIds, domainStatus: receipt.outcome,
          })),
          "group", ["group-presence-summary"],
        );
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
  await createPostgresClientPhaseDriver({
    sql,
    runtimeRepository: toRuntimeRepository(sql),
    atEpochMs: atEpochMs - 10_000,
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
}

function createSql(databaseUrl: string, maxConnections = 1): PostgresSql {
  const postgres = createRequire(import.meta.url)("postgres") as PostgresFactory;

  return postgres(databaseUrl, { max: maxConnections, idle_timeout: 1 });
}

function toRuntimeRepository(sql: PostgresSql): PSqlRuntimeStateRepository {
  return new PSqlRuntimeStateRepository(sql as unknown as PSqlSql);
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
  return createPostgresClientPhaseDriver({
    sql,
    runtimeRepository,
    atEpochMs,
    serviceId: "postgres-client-cas-worker",
  });
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
  await createPostgresClientPhaseDriver({
    sql,
    runtimeRepository: toRuntimeRepository(sql),
    atEpochMs,
    serviceId: "postgres-worker-client-setup",
  }).connectSession(scope, sessionRef.principalId, sessionRef.clientInstanceId, sessionRef.sessionId, {
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
    readyDirectoryPath: path.join(tmpDirPath, `${name}-ready`),
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
  expect(new Set(inputs.map((input) => input.barrier.readyDirectoryPath)).size).toBe(1);
  expect(new Set(inputs.map((input) => input.barrier.releaseFilePath)).size).toBe(1);
  const handles = inputs.map((input) => spawnWorker(databaseUrl, input));
  try {
    await waitForPostgresAppInboxWorkerParticipants(
      inputs[0]!.barrier.readyDirectoryPath,
      handles.length,
      handles.map((handle) => handle.done),
    );
    await writeFile(inputs[0]!.barrier.releaseFilePath, "release", "utf8");
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
    expect(output.outboxIds).toHaveLength(
      output.operation.startsWith("client-") ? 2 : 1,
    );
    output.outboxIds.forEach((outboxId) => expect(outboxId).toMatch(/\S/u));
  } else if (output.domainStatus === "no-op") {
    expect(output).toMatchObject({
      acceptedStorageRevision: null, acceptedCausalRevision: null,
      acceptedVersion: null, outboxIds: [],
    });
  }
}

async function expectPendingWorkerOutboxes(
  sql: PSqlSql,
  outputs: readonly WorkerOutput[],
  kind: "client" | "group",
  effects: readonly WorkerOutboxEffect[],
): Promise<void> {
  const outboxIds = outputs.flatMap((output) => output.outboxIds);
  expectWorkerOutboxLifecycleEvidence(
    await findDirectResourceOutboxEvidence(sql, outboxIds),
    outputs,
    kind,
    effects,
  );
}

async function assertOneWorkerRebased(input: AssertOneWorkerRebasedInput): Promise<void> {
  const { outputs, traces } = input;
  expect(traces.every((trace) => trace.barrierWaitCount === 1)).toBe(true);
  expect(new Set(traces.map((trace) => trace.backendPid)).size).toBe(2);
  const loserIndex = outputs.findIndex((output) => output.attemptCount === 2);
  expect(loserIndex).toBeGreaterThanOrEqual(0);
  expect(findSingleRetriedAppInboxAttemptSequence({
    traces,
    ownedResourceIds: await readOwnedAppInboxResourceIds({
      sql: input.sql,
      scope: input.scope,
      requestIds: outputs.map((output) => output.requestId),
    }),
  }).map((attempt) => ({
    attempt: attempt.attempt,
    classification: attempt.classification,
    retryDelayMs: attempt.retryDelayMs,
  }))).toEqual([
    { attempt: 1, classification: "retryable", retryDelayMs: 1 },
    { attempt: 2, classification: "accepted", retryDelayMs: 0 },
  ]);
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
