import { describe, expect, it, vi } from "vitest";
import type { GroupRef } from "@shared/api/group-types.ts";
import type { StateScope } from "@shared/api/state-types.ts";
import { GroupStateRepository } from "@shared-server/rallar-system/repositories/GroupStateRepository.ts";
import { STATE_MUTATION_OUTBOX_NAMESPACE } from "@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts";
import {
  createTestGroupStateRuntime,
  createTestGroupStateService as createGroupStateService,
} from "./group-state-test-runtime.ts";
import type { RallarTimingEvent } from "@shared-server/rallar-system/services/timing.ts";
import type { StateSyncPublisher } from "@shared-server/rallar-system/state-sync-publisher.ts";
import { FakeRuntimeStateRepository } from "./fake-runtime-state-repository.ts";

const SCOPE: StateScope = {
  applicationId: "app-1",
  workspaceId: "workspace-1",
};

describe("GroupStateService command idempotency", () => {
  it("records timing for group state service methods when a timing sink is supplied", async () => {
    const timingEvents: RallarTimingEvent[] = [];
    const service = createGroupStateService({
      runtimeRepository: new FakeRuntimeStateRepository(),
      syncPublisher: createPublisher(),
      now: () => 1_000,
      serviceId: "group-service",
      timing: (event) => timingEvents.push(event),
    });

    await service.createGroup(SCOPE, {
      groupId: "timed-room",
      displayName: "Timed Room",
      kind: "room",
      joinMode: "open",
      createdByPrincipalId: "alice",
      requestId: "create-timed-room",
    });

    expect(timingEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "group-state-service",
          operation: "createGroup",
          status: "ok",
          serviceId: "group-service",
          requestId: "create-timed-room",
          applicationId: SCOPE.applicationId,
          workspaceId: SCOPE.workspaceId,
          groupId: "timed-room",
          principalId: "alice",
        }),
      ]),
    );
    expect(typeof timingEvents[0]?.durationMs).toBe("number");
  });

  it("retries createGroup with the same requestId without creating duplicate state or events", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const publisher = createPublisher();
    const service = createGroupStateService({
      runtimeRepository,
      syncPublisher: publisher,
      now: () => 1_000,
      serviceId: "group-service",
    });
    const groupRef = toGroupRef("room-1");
    const request = {
      groupId: groupRef.groupId,
      displayName: "Room 1",
      kind: "room" as const,
      joinMode: "open" as const,
      createdByPrincipalId: "alice",
      requestId: "create-room-1",
    };

    await expect(service.createGroup(SCOPE, request)).resolves.toMatchObject({
      status: "created",
      result: {
        right: {
          snapshot: {
            group: {
              ...groupRef,
              snapshotVersion: 1,
            },
          },
        },
      },
    });
    await expect(service.createGroup(SCOPE, request)).resolves.toMatchObject({
      status: "created",
      result: {
        right: {
          snapshot: {
            group: {
              ...groupRef,
              snapshotVersion: 1,
            },
          },
        },
      },
    });

    const repository = new GroupStateRepository(runtimeRepository);
    expect(
      (await repository.listEvents(groupRef)).map((event) => event.eventType),
    ).toEqual(["group-created"]);
    expect(
      (await repository.readSnapshot(groupRef))?.group.snapshotVersion,
    ).toBe(1);
    expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
  });

  it("returns a group-exists result when createGroup uses a different requestId for an existing group", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const runtime = createTestGroupStateRuntime({
      runtimeRepository,
      syncPublisher: createPublisher(),
      now: () => 1_000,
      serviceId: "group-service",
    });
    const service = runtime.service;
    const groupRef = toGroupRef("room-6");

    await service.createGroup(SCOPE, {
      groupId: groupRef.groupId,
      displayName: "Room 6",
      kind: "room",
      joinMode: "open",
      createdByPrincipalId: "alice",
      requestId: "create-room-6-a",
    });

    await expect(
      service.createGroup(SCOPE, {
        groupId: groupRef.groupId,
        displayName: "Room 6",
        kind: "room",
        joinMode: "open",
        createdByPrincipalId: "alice",
        requestId: "create-room-6-b",
      }),
    ).resolves.toMatchObject({
      status: "error",
      result: {
        left: "Group already exists: room-6",
      },
    });

    const repository = new GroupStateRepository(runtimeRepository);
    expect(
      (await repository.listEvents(groupRef)).map((event) => event.eventType),
    ).toEqual(["group-created"]);
  });

  it("returns the stored revisioned createGroup snapshot", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const service = createGroupStateService({
      runtimeRepository,
      syncPublisher: createPublisher(),
      now: () => 1_000,
      serviceId: "group-service",
    });

    await expect(
      service.createGroup(SCOPE, {
        groupId: "room-no-readback",
        displayName: "Room no readback",
        kind: "room",
        joinMode: "open",
        createdByPrincipalId: "alice",
        requestId: "create-room-no-readback",
      }),
    ).resolves.toMatchObject({
      status: "created",
      result: {
        right: {
          snapshot: {
            stateRevision: 1,
            members: [
              {
                principalId: "alice",
                role: "owner",
                status: "active",
              },
            ],
            activeSessions: [],
            memberCount: 1,
            onlineMemberCount: 0,
          },
        },
      },
    });
  });

  it("rejects createGroup reuse with the same requestId and different semantic content", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const service = createGroupStateService({
      runtimeRepository,
      syncPublisher: createPublisher(),
      now: () => 1_000,
      serviceId: "group-service",
    });

    await service.createGroup(SCOPE, {
      groupId: "room-3",
      displayName: "Room 3",
      kind: "room",
      joinMode: "open",
      createdByPrincipalId: "alice",
      requestId: "create-room-3",
    });

    await expect(
      service.createGroup(SCOPE, {
        groupId: "room-3",
        displayName: "Room 3 with different payload",
        kind: "room",
        joinMode: "open",
        createdByPrincipalId: "alice",
        requestId: "create-room-3",
      }),
    ).rejects.toMatchObject({
      code: "group-mutation-idempotency-conflict",
      status: 409,
    });

    const repository = new GroupStateRepository(runtimeRepository);
    expect(
      (await repository.readSnapshot(toGroupRef("room-3")))?.group,
    ).toMatchObject({
      displayName: "Room 3",
      snapshotVersion: 1,
    });
  });

  it("replays updateGroup with the same requestId without bumping versions twice", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-2");

    const publisher = createPublisher();
    const service = createGroupStateService({
      runtimeRepository,
      syncPublisher: publisher,
      now: () => 2_000,
      serviceId: "group-service",
    });
    const groupRef = toGroupRef("room-2");
    const request = {
      displayName: "Room 2 renamed",
      actorPrincipalId: "alice",
      requestId: "rename-room-2",
    };

    const first = await service.updateGroup(SCOPE, groupRef.groupId, request);
    const second = await service.updateGroup(SCOPE, groupRef.groupId, request);

    expect(second).toMatchObject({
      status: "ok",
      result: {
        right: {
          snapshot: {
            group: {
              displayName: "Room 2 renamed",
              snapshotVersion: 2,
            },
          },
        },
      },
    });
    expect(first.result.right?.event?.eventType).toBe("group-updated");
    expect(second.result.right?.event).toEqual(first.result.right?.event);

    const repository = new GroupStateRepository(runtimeRepository);
    expect(
      (await repository.readSnapshot(groupRef))?.group.snapshotVersion,
    ).toBe(2);
    expect(
      (await repository.listEvents(groupRef)).map((event) => event.eventType),
    ).toEqual(["group-created", "group-updated"]);
    expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
  });

  it("replays upsertMember with the same requestId without adding duplicate roster events", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-5");

    const publisher = createPublisher();
    const service = createGroupStateService({
      runtimeRepository,
      syncPublisher: publisher,
      now: () => 3_000,
      serviceId: "group-service",
    });
    const groupRef = toGroupRef("room-5");
    const request = {
      role: "member" as const,
      status: "active" as const,
      actorPrincipalId: "alice",
      requestId: "join-bob-room-5",
    };

    const first = await service.upsertMember(
      SCOPE,
      groupRef.groupId,
      "bob",
      request,
    );
    const second = await service.upsertMember(
      SCOPE,
      groupRef.groupId,
      "bob",
      request,
    );

    expect(second).toMatchObject({
      status: "ok",
      result: {
        right: {
          snapshot: {
            group: {
              snapshotVersion: 2,
              rosterVersion: 2,
            },
            memberCount: 2,
          },
        },
      },
    });
    expect(first.result.right?.event?.eventType).toBe("member-joined");
    expect(second.result.right?.event).toEqual(first.result.right?.event);

    const repository = new GroupStateRepository(runtimeRepository);
    expect(
      (await repository.listEvents(groupRef)).map((event) => event.eventType),
    ).toEqual(["group-created", "member-joined"]);
    expect(
      (await repository.readSnapshot(groupRef))?.members
        .map((member) => member.principalId)
        .sort(),
    ).toEqual(["alice", "bob"]);
    expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
  });

  it("replays disconnectPresenceSession with generated timestamps without duplicating disconnect events", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-4");
    await seedPresenceSession(runtimeRepository, "room-4");

    let now = 4_000;
    const publisher = createPublisher();
    const service = createGroupStateService({
      runtimeRepository,
      syncPublisher: publisher,
      now: () => now,
      serviceId: "group-service",
    });
    const groupRef = toGroupRef("room-4");
    const request = {
      principalId: "alice",
      generationId: "generation-session-1",
      reason: "closed",
      actorPrincipalId: "alice",
      requestId: "disconnect-session-1",
    };

    const first = await service.disconnectPresenceSession(
      SCOPE,
      groupRef.groupId,
      "session-1",
      request,
    );
    now = 9_000;
    const second = await service.disconnectPresenceSession(
      SCOPE,
      groupRef.groupId,
      "session-1",
      request,
    );

    expect(second).toMatchObject({
      status: "ok",
      result: {
        right: {
          snapshot: {
            group: {
              ...groupRef,
              snapshotVersion: 1,
              presenceVersion: 0,
            },
            activeSessions: [],
          },
        },
      },
    });
    expect(first.result.right?.event?.eventType).toBe("session-disconnected");
    expect(second.result.right?.event).toEqual(first.result.right?.event);

    const repository = new GroupStateRepository(runtimeRepository);
    expect(
      (
        await repository.findPresenceSession({
          ...groupRef,
          sessionId: "session-1",
        })
      )?.disconnectedAtEpochMs,
    ).toBe(4_000);
    expect(
      (await repository.listEvents(groupRef)).map((event) => event.eventType),
    ).toEqual(["group-created", "session-connected", "session-disconnected"]);
    expect(
      (await repository.readSnapshot(groupRef))?.group.snapshotVersion,
    ).toBe(1);
    expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
  });

  it("returns disconnects triggered by websocket session cleanup without publishing directly", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-7");
    await seedPresenceSession(runtimeRepository, "room-7");

    const publisher = createPublisher();
    const runtime = createTestGroupStateRuntime({
      runtimeRepository,
      syncPublisher: publisher,
      now: () => 5_000,
      serviceId: "group-service",
    });

    const snapshots = await runtime.maintenance
      .disconnectPresenceSessionsBySessionId("session-1", 5_000);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].activeSessions).toHaveLength(0);
    expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
  });

  it("returns written disconnect results for websocket session cleanup", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-8");
    await seedPresenceSession(runtimeRepository, "room-8");

    const publisher = createPublisher();
    const runtime = createTestGroupStateRuntime({
      runtimeRepository,
      syncPublisher: publisher,
      now: () => 5_000,
      serviceId: "group-service",
    });

    await expect(
      runtime.maintenance.disconnectPresenceSessionsBySessionIdWritten(
        "session-1",
        5_000,
      ),
    ).resolves.toMatchObject([
      {
        result: {
          right: {
            event: {
              eventType: "session-disconnected",
            },
          },
        },
      },
    ]);

    expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
  });

  it("eventually expires a session after missed websocket cleanup exactly once with receipt and outbox", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-9");
    const expiresAtEpochMs = Date.now() - 1_000;
    await seedPresenceSession(runtimeRepository, "room-9", {
      lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
      expiresAtEpochMs,
    });

    const publisher = createPublisher();
    const now = expiresAtEpochMs + 1;
    const runtime = createTestGroupStateRuntime({
      runtimeRepository,
      syncPublisher: publisher,
      now: () => now,
      serviceId: "group-service",
    });
    const groupRef = toGroupRef("room-9");

    const first = await runtime.maintenance.expireExpiredPresenceSessions(now);
    const second = await runtime.maintenance.expireExpiredPresenceSessions(now);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(first[0].result.right?.event).toMatchObject({
      eventType: "session-disconnected",
      reason: "expired",
    });
    expect(first[0].result.right?.snapshot).toMatchObject({
      group: {
        ...groupRef,
          snapshotVersion: 1,
          presenceVersion: 0,
      },
      activeSessions: [],
      onlineMemberCount: 0,
    });

    const repository = new GroupStateRepository(runtimeRepository);
    const expiryRequestId = [
      "expire-group-presence",
      SCOPE.applicationId,
      SCOPE.workspaceId,
      groupRef.groupId,
      "session-1",
      "generation-session-1",
      2_000,
      expiresAtEpochMs,
    ].join(":");
    expect(
      await repository.findIdempotentGroupMutationReceipt(
        groupRef,
        expiryRequestId,
      ),
    ).toMatchObject({ receipt: { outcome: "applied" } });
    const expiryOutbox = (
      await runtimeRepository.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE)
    ).map((entry) => JSON.parse(entry.value) as Record<string, unknown>)
      .filter((record) => record.commandId === expiryRequestId);
    expect(expiryOutbox).toHaveLength(1);
    expect(expiryOutbox[0]).toMatchObject({
      effects: ["group-state-sync", "group-presence-summary"],
      delivery: { status: "pending" },
    });
    expect(
      await repository.findPresenceSession({
        ...groupRef,
        sessionId: "session-1",
      }),
    ).toMatchObject({
      disconnectReason: "expired",
      disconnectedAtEpochMs: now,
    });
    expect(
      (await repository.listEvents(groupRef)).map((event) => event.eventType),
    ).toEqual(["group-created", "session-connected", "session-disconnected"]);
    expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
  });

  it("does not rewrite expired presence when late websocket cleanup arrives", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-10");
    const expiresAtEpochMs = Date.now() - 1_000;
    await seedPresenceSession(runtimeRepository, "room-10", {
      lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
      expiresAtEpochMs,
    });
    runtimeRepository.locks.splice(0);

    const now = expiresAtEpochMs + 1;
    const runtime = createTestGroupStateRuntime({
      runtimeRepository,
      syncPublisher: createPublisher(),
      now: () => now,
      serviceId: "group-service",
    });
    const service = runtime.service;
    const groupRef = toGroupRef("room-10");

    await runtime.maintenance.expireExpiredPresenceSessions(now);
    const lateDisconnect = await service.disconnectPresenceSession(
      SCOPE,
      groupRef.groupId,
      "session-1",
      {
        principalId: "alice",
        generationId: "generation-session-1",
        reason: "socket-closed",
        actorPrincipalId: "alice",
        actorSessionId: "session-1",
        requestId: "late-disconnect-after-expiry",
      },
    );

    expect(lateDisconnect.result.right?.event).toBeUndefined();
    const repository = new GroupStateRepository(runtimeRepository);
    expect(
      await repository.findPresenceSession({
        ...groupRef,
        sessionId: "session-1",
      }),
    ).toMatchObject({
      disconnectReason: "expired",
      disconnectedAtEpochMs: now,
    });
    expect(
      (await repository.listEvents(groupRef)).map((event) => event.eventType),
    ).toEqual(["group-created", "session-connected", "session-disconnected"]);
    expect(runtimeRepository.locks).toEqual([]);
  });

  it("does not let a late heartbeat revive a terminal generation", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-11");
    const expiresAtEpochMs = Date.now() - 1_000;
    await seedPresenceSession(runtimeRepository, "room-11", {
      lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
      expiresAtEpochMs,
    });

    const now = expiresAtEpochMs + 1;
    const runtime = createTestGroupStateRuntime({
      runtimeRepository,
      syncPublisher: createPublisher(),
      now: () => now,
      serviceId: "group-service",
    });
    const service = runtime.service;
    const groupRef = toGroupRef("room-11");

    await runtime.maintenance.expireExpiredPresenceSessions(now);
    const lateHeartbeat = await service.heartbeatPresenceSession(
      SCOPE,
      groupRef.groupId,
      "session-1",
      {
        principalId: "alice",
        generationId: "generation-session-1",
        actorPrincipalId: "alice",
        actorSessionId: "session-1",
        lastHeartbeatAtEpochMs: now + 1,
        expiresAtEpochMs: now + 60_000,
        requestId: "late-heartbeat-after-expiry",
      },
    );

    expect(lateHeartbeat.result.right?.event).toBeUndefined();

    const repository = new GroupStateRepository(runtimeRepository);
    const session = await repository.findPresenceSession({
      ...groupRef,
      sessionId: "session-1",
    });
    expect(session).toMatchObject({
      lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
      expiresAtEpochMs,
      disconnectedAtEpochMs: now,
      disconnectReason: "expired",
    });
    expect(
      (await repository.listEvents(groupRef)).map((event) => event.eventType),
    ).toEqual([
      "group-created",
      "session-connected",
      "session-disconnected",
    ]);
  });

  it("advances causal state revision for a heartbeat-only snapshot change", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-heartbeat-revision");
    await seedPresenceSession(runtimeRepository, "room-heartbeat-revision");
    const repository = new GroupStateRepository(runtimeRepository);
    const groupRef = toGroupRef("room-heartbeat-revision");
    const before = await repository.readSnapshot(groupRef);
    const service = createGroupStateService({
      runtimeRepository,
      syncPublisher: createPublisher(),
      now: () => 2_000,
      serviceId: "group-service",
    });

    const written = await service.heartbeatPresenceSession(
      SCOPE,
      groupRef.groupId,
      "session-1",
      {
        principalId: "alice",
        generationId: "generation-session-1",
        lastHeartbeatAtEpochMs: 2_000,
        expiresAtEpochMs: Date.now() + 120_000,
        requestId: "heartbeat-causal-revision",
        actorPrincipalId: "alice",
      },
    );

    expect(written.result.right?.event?.eventType).toBe("session-heartbeat");
    expect(written.result.right?.snapshot.group.snapshotVersion).toBe(
      before?.group.snapshotVersion,
    );
    expect(written.result.right?.snapshot.stateRevision).toBe(
      before?.stateRevision,
    );
  });

  it("rejects a heartbeat that would advance past expiry without extending expiry", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const storedHeartbeatAtEpochMs = Date.now() + 60_000;
    const storedExpiresAtEpochMs = storedHeartbeatAtEpochMs + 1_000;
    const lateHeartbeatAtEpochMs = storedExpiresAtEpochMs + 1_000;
    await seedGroup(runtimeRepository, "room-heartbeat-expiry-invariant");
    await seedPresenceSession(runtimeRepository, "room-heartbeat-expiry-invariant", {
      lastHeartbeatAtEpochMs: storedHeartbeatAtEpochMs,
      expiresAtEpochMs: storedExpiresAtEpochMs,
    });
    const service = createGroupStateService({
      runtimeRepository,
      now: () => lateHeartbeatAtEpochMs,
      serviceId: "group-service",
    });

    await expect(service.heartbeatPresenceSession(
      SCOPE,
      "room-heartbeat-expiry-invariant",
      "session-1",
      {
        principalId: "alice",
        generationId: "generation-session-1",
        actorPrincipalId: "alice",
        actorSessionId: "session-1",
        lastHeartbeatAtEpochMs: lateHeartbeatAtEpochMs,
        requestId: "heartbeat-without-expiry-extension",
      },
    )).rejects.toThrow(/expiry|expires/i);

    const repository = new GroupStateRepository(runtimeRepository);
    expect(await repository.findPresenceSession({
      ...SCOPE,
      groupId: "room-heartbeat-expiry-invariant",
      sessionId: "session-1",
    })).toMatchObject({
      lastHeartbeatAtEpochMs: storedHeartbeatAtEpochMs,
      expiresAtEpochMs: storedExpiresAtEpochMs,
    });
    expect(await repository.listEvents({
      ...SCOPE,
      groupId: "room-heartbeat-expiry-invariant",
    })).toHaveLength(2);
  });

  it("rejects reassigning an existing presence session to another principal", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-session-principal-invariant");
    await seedPresenceSession(runtimeRepository, "room-session-principal-invariant");
    const service = createGroupStateService({
      runtimeRepository,
      now: () => 3_000,
      serviceId: "group-service",
    });
    await service.upsertMember(SCOPE, "room-session-principal-invariant", "bob", {
      status: "active",
      actorPrincipalId: "bob",
      requestId: "activate-bob-for-session-reassignment",
    });

    await expect(service.connectPresenceSession(
      SCOPE,
      "room-session-principal-invariant",
      "session-1",
      {
        principalId: "bob",
        generationId: "bob-generation",
        connectedAtEpochMs: 3_000,
        lastHeartbeatAtEpochMs: 3_000,
        expiresAtEpochMs: 60_000,
        actorPrincipalId: "bob",
        actorSessionId: "session-1",
        requestId: "reassign-session-to-bob",
      },
    )).rejects.toThrow(/principal|session/i);

    const repository = new GroupStateRepository(runtimeRepository);
    expect(await repository.findPresenceSession({
      ...SCOPE,
      groupId: "room-session-principal-invariant",
      sessionId: "session-1",
    })).toMatchObject({
      principalId: "alice",
      generationId: "generation-session-1",
    });
    expect((await repository.findPresenceAdmissionEntry({
      ...SCOPE,
      groupId: "room-session-principal-invariant",
      principalId: "bob",
    }))?.value.admittedSessions ?? []).toHaveLength(0);
  });
});

async function seedGroup(
  runtimeRepository: FakeRuntimeStateRepository,
  groupId: string,
): Promise<void> {
  await createGroupStateService({
    runtimeRepository,
    syncPublisher: createPublisher(),
    now: () => 1_000,
    serviceId: "group-service",
  }).createGroup(SCOPE, {
    groupId,
    displayName: groupId,
    kind: "room",
    joinMode: "open",
    createdByPrincipalId: "alice",
    requestId: `seed-${groupId}`,
  });
}

async function seedPresenceSession(
  runtimeRepository: FakeRuntimeStateRepository,
  groupId: string,
  overrides: Partial<{
    lastHeartbeatAtEpochMs: number;
    expiresAtEpochMs: number;
  }> = {},
): Promise<void> {
  await createGroupStateService({
    runtimeRepository,
    syncPublisher: createPublisher(),
    now: () => 2_000,
    serviceId: "group-service",
  }).connectPresenceSession(SCOPE, groupId, "session-1", {
    principalId: "alice",
    generationId: "generation-session-1",
    actorPrincipalId: "alice",
    connectedAtEpochMs: 2_000,
    lastHeartbeatAtEpochMs: overrides.lastHeartbeatAtEpochMs ?? 2_000,
    expiresAtEpochMs: overrides.expiresAtEpochMs ?? Date.now() + 60_000,
    requestId: `seed-session-${groupId}`,
  });
}

function toGroupRef(groupId: string): GroupRef {
  return {
    ...SCOPE,
    groupId,
  };
}

function createPublisher(
  options: Readonly<{
    failGroupSnapshotCalls?: number;
    failGroupEventCalls?: number;
  }> = {},
): StateSyncPublisher {
  let groupSnapshotCalls = 0;
  let groupEventCalls = 0;

  return {
    publishClientSnapshot: vi.fn(async () => undefined),
    publishClientEvent: vi.fn(async () => undefined),
    publishGroupSnapshot: vi.fn(async () => {
      groupSnapshotCalls += 1;
      if (groupSnapshotCalls <= (options.failGroupSnapshotCalls ?? 0)) {
        throw new Error("group snapshot publish unavailable");
      }
    }),
    publishGroupEvent: vi.fn(async () => {
      groupEventCalls += 1;
      if (groupEventCalls <= (options.failGroupEventCalls ?? 0)) {
        throw new Error("group event publish unavailable");
      }
    }),
  };
}
