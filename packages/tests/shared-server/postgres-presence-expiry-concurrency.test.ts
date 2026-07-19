import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { ClientSessionRef } from "@shared/api/client-types.ts";
import type { Group, GroupEvent, GroupRef } from "@shared/api/group-types.ts";
import { toGroupSnapshotStateRevision } from "@shared/api/group-client-views.ts";
import type { StateScope } from "@shared/api/state-types.ts";
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
import { createClientStateService } from "@shared-server/rallar-system/services/client-state-service.ts";
import { createTestGroupStateRuntime } from "./group-state-test-runtime.ts";
import type { StateSyncPublisher } from "@shared-server/rallar-system/state-sync-publisher.ts";
import { groupStateMaintenanceRequestId } from "@shared-server/rallar-system/services/group-state-service.ts";
import {
  STATE_MUTATION_OUTBOX_NAMESPACE,
  type StateMutationOutboxRecord,
  toStateMutationOutboxId,
} from "@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts";

const POSTGRES_INTEGRATION_ENABLED =
  Deno.env.get("RALLAR_POSTGRES_INTEGRATION") === "1";

type PostgresSql =
  & PSqlSql
  & Readonly<{
    end(): Promise<void>;
  }>;
type PostgresFactory = (
  databaseUrl: string,
  options: Readonly<{ max: number; idle_timeout: number }>,
) => PostgresSql;

const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;

describe("Postgres presence expiry concurrency", () => {
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
        expect(await repository.listGroups({ applicationId })).toEqual([
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
          ...ref,
          eventId: "shared-event",
          eventType: "group-updated",
          snapshotVersion,
          occurredAtEpochMs: Date.now() + snapshotVersion,
          actor: { serviceId: "postgres-group-event-key-test" },
          reason,
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
  const audit = {
    atEpochMs: Date.now(),
    byServiceId: "postgres-group-key-test",
  } as const;
  return {
    ...ref,
    displayName,
    kind: "room",
    status: "active",
    joinMode: "open",
    metadata: {},
    activeMemberCount: 1,
    ownerPrincipalId: "alice",
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
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
  return createClientStateService({
    runtimeRepository,
    createClientStateEventStore: createClientStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => atEpochMs,
    sleep: () => Promise.resolve(),
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

function requireDatabaseUrl(): string {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1",
    );
  }

  return databaseUrl;
}
