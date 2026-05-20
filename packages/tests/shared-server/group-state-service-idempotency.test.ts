import { describe, expect, it, vi } from "vitest";
import type { GroupRef } from "@shared/api/group-types.ts";
import type { StateScope } from "@shared/api/state-types.ts";
import { GroupStateRepository } from "@shared-server/rallar-system/repositories/GroupStateRepository.ts";
import { createGroupStateService } from "@shared-server/rallar-system/services/group-state-service.ts";
import type { StateSyncPublisher } from "@shared-server/rallar-system/state-sync-publisher.ts";
import { FakeRuntimeStateRepository } from "./fake-runtime-state-repository.ts";

const SCOPE: StateScope = {
  applicationId: "app-1",
  workspaceId: "workspace-1",
};

describe("GroupStateService command idempotency", () => {
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
    const service = createGroupStateService({
      runtimeRepository,
      syncPublisher: createPublisher(),
      now: () => 1_000,
      serviceId: "group-service",
    });
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

  it("replays createGroup with the same requestId without applying a different payload", async () => {
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
    ).resolves.toMatchObject({
      status: "created",
      result: {
        right: {
          snapshot: {
            group: {
              displayName: "Room 3",
            },
          },
        },
      },
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
              snapshotVersion: 3,
              presenceVersion: 2,
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
    ).toBe(3);
    expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
  });

  it("publishes disconnects triggered by websocket session cleanup", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedGroup(runtimeRepository, "room-7");
    await seedPresenceSession(runtimeRepository, "room-7");

    const publisher = createPublisher();
    const service = createGroupStateService({
      runtimeRepository,
      syncPublisher: publisher,
      now: () => 5_000,
      serviceId: "group-service",
    });

    await expect(
      service.disconnectPresenceSessionsBySessionId("session-1", {
        reason: "closed",
        actorPrincipalId: "alice",
        actorSessionId: "session-1",
      }),
    ).resolves.toHaveLength(1);

    expect(publisher.publishGroupSnapshot).toHaveBeenCalledTimes(1);
    expect(publisher.publishGroupEvent).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(publisher.publishGroupEvent).mock.calls[0]?.[0].eventType,
    ).toBe("session-disconnected");
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
): Promise<void> {
  await createGroupStateService({
    runtimeRepository,
    syncPublisher: createPublisher(),
    now: () => 2_000,
    serviceId: "group-service",
  }).connectPresenceSession(SCOPE, groupId, "session-1", {
    principalId: "alice",
    actorPrincipalId: "alice",
    connectedAtEpochMs: 2_000,
    lastHeartbeatAtEpochMs: 2_000,
    expiresAtEpochMs: Date.now() + 60_000,
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
