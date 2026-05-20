import { beforeEach, describe, expect, it, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { AppTopics } from "@shared/api/api-config.ts";
import type { StateScope } from "@shared/api/state-types.ts";
import type { ALMessage } from "@shared/al-contracts/al-contract.ts";
import { InMemoryQueueBox } from "@shared/queuebox/InMemoryQueueBox.ts";
import { ResilienceDto } from "@shared/queuebox/DequeueResourceEntryController.ts";
import {
  EntityStatus,
  isExpiredResourceEntry,
  type Key,
  type ResourceEntry,
  toKeyAsString,
} from "@shared/queuebox/ResourceEntry.ts";
import { CircuitBreakerPolicy } from "@shared/resilience/Resilience.ts";
import { InboxQueueReader } from "@shared/services/InboxQueueReader.ts";
import { findClientStateSnapshotByPrincipalId } from "@shared/repository/client-state-snapshots-repository.ts";
import { findGroupStateSnapshotByRef } from "@shared/repository/group-state-snapshots-repository.ts";
import type { WsQueueBoxServerService } from "@shared/services/WsQueueBoxServerService.ts";
import { ClientStateRepository } from "@shared-server/rallar-system/repositories/ClientStateRepository.ts";
import { GroupStateRepository } from "@shared-server/rallar-system/repositories/GroupStateRepository.ts";
import { createClientStateService } from "@shared-server/rallar-system/services/client-state-service.ts";
import {
  AppInboxService,
  AppInboxType,
  type GroupCreateAppInboxPayload,
} from "@shared-server/rallar-system/services/AppInboxService.ts";
import {
  createGroupStateService,
  type GroupStateWritten,
} from "@shared-server/rallar-system/services/group-state-service.ts";
import { createWsStateSyncPublisher } from "@shared-server/rallar-system/state-sync-publisher.ts";
import { configureTestCacheRepositories } from "../cache-repository-config.ts";
import { FakeRuntimeStateRepository } from "./fake-runtime-state-repository.ts";

const SCOPE: StateScope = {
  applicationId: "app-1",
  workspaceId: "workspace-1",
};

describe("state sync publish failure characterization", () => {
  beforeEach(() => {
    configureTestCacheRepositories();
  });

  it("app inbox commits group state and updates process cache before returning snapshot enqueue failure", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const enqueueOutboxIfAbsent = vi.fn(async () => {
      throw new Error("snapshot enqueue unavailable");
    });
    const { appInbox, reader } = createGroupAppInbox(
      runtimeRepository,
      createPublisher(enqueueOutboxIfAbsent),
      1_000,
    );
    const groupRef = {
      ...SCOPE,
      groupId: "room-1",
    };

    const result = await processCreateGroup(appInbox, reader, groupRef.groupId);

    expect(result.left).toBe("snapshot enqueue unavailable");

    const durableRepository = new GroupStateRepository(runtimeRepository);
    const durableSnapshot = await durableRepository.readSnapshot(groupRef);
    expect(durableSnapshot?.group).toMatchObject({
      ...groupRef,
      snapshotVersion: 1,
    });
    expect(await durableRepository.listEvents(groupRef)).toHaveLength(1);
    expect(findGroupStateSnapshotByRef(groupRef)?.group.snapshotVersion).toBe(
      1,
    );
    expect(enqueueOutboxIfAbsent).toHaveBeenCalledTimes(1);
    expect(enqueueOutboxIfAbsent.mock.calls[0]?.[0].payload.typeId).toBe(
      AppTopics.groupStateSnapshot,
    );
  });

  it("commits client state and updates process cache before surfacing snapshot enqueue failure", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const enqueueOutboxIfAbsent = vi.fn(async () => {
      throw new Error("client snapshot enqueue unavailable");
    });
    const service = createClientStateService({
      runtimeRepository,
      syncPublisher: createPublisher(enqueueOutboxIfAbsent),
      now: () => 2_000,
      serviceId: "state-service",
    });

    await expect(
      service.upsertPrincipal(SCOPE, "alice", {
        username: "alice",
        displayName: "Alice",
        actorPrincipalId: "alice",
      }),
    ).rejects.toThrow("client snapshot enqueue unavailable");

    const principalRef = {
      ...SCOPE,
      principalId: "alice",
    };
    const durableRepository = new ClientStateRepository(runtimeRepository);
    const durableSnapshot = await durableRepository.readSnapshot(principalRef);
    expect(durableSnapshot?.principal).toMatchObject({
      ...principalRef,
      snapshotVersion: 1,
    });
    expect(await durableRepository.listEvents(principalRef)).toHaveLength(1);
    expect(
      findClientStateSnapshotByPrincipalId("alice")?.principal.snapshotVersion,
    ).toBe(1);
    expect(enqueueOutboxIfAbsent).toHaveBeenCalledTimes(1);
    expect(enqueueOutboxIfAbsent.mock.calls[0]?.[0].payload.typeId).toBe(
      AppTopics.clientStateSnapshot,
    );
  });

  it("app inbox can enqueue a group snapshot before returning a later group event enqueue failure", async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const enqueuedMessages: ALMessage[] = [];
    const enqueueOutboxIfAbsent = vi.fn(async (message: ALMessage) => {
      enqueuedMessages.push(message);
      if (enqueuedMessages.length === 2) {
        throw new Error("event enqueue unavailable");
      }
      return {
        status: "enqueued",
        message,
        entries: [],
      };
    });
    const { appInbox, reader } = createGroupAppInbox(
      runtimeRepository,
      createPublisher(enqueueOutboxIfAbsent),
      3_000,
    );
    const groupRef = {
      ...SCOPE,
      groupId: "room-2",
    };

    const result = await processCreateGroup(appInbox, reader, groupRef.groupId);

    expect(result.left).toBe("event enqueue unavailable");

    expect(enqueuedMessages.map((message) => message.payload.typeId)).toEqual([
      AppTopics.groupStateSnapshot,
      AppTopics.groupStateEvent,
    ]);
    expect(
      await new GroupStateRepository(runtimeRepository).readSnapshot(groupRef),
    ).toBeDefined();
    expect(findGroupStateSnapshotByRef(groupRef)).toBeDefined();
  });
});

class TestResourceInbox extends InMemoryQueueBox {
  async isEntryWithStatus(
    key: Key,
    statuses: EntityStatus[],
  ): Promise<boolean> {
    const entry = await this.getItem(key);
    return entry !== undefined && statuses.includes(entry.status);
  }
}

class TestResourceInboxResults {
  private readonly data = new Map<string, ResourceEntry>();

  async writeIfAbsentOrReplaceExpired(
    entry: ResourceEntry,
  ): Promise<ResourceEntry> {
    const key = toKeyAsString(entry.key);
    const existing = this.data.get(key);
    if (existing !== undefined && !isExpiredResourceEntry(existing)) {
      return existing;
    }

    this.data.set(key, entry);
    return entry;
  }

  async findByKey(key: Key): Promise<ResourceEntry | undefined> {
    const entry = this.data.get(toKeyAsString(key));
    return entry === undefined || isExpiredResourceEntry(entry)
      ? undefined
      : entry;
  }
}

function createGroupAppInbox(
  runtimeRepository: FakeRuntimeStateRepository,
  publisher: ReturnType<typeof createPublisher>,
  now: number,
): Readonly<{
  appInbox: AppInboxService;
  reader: InboxQueueReader;
}> {
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const appInbox = new AppInboxService(
    reader,
    queue as never,
    new TestResourceInboxResults() as never,
    createGroupStateService({
      runtimeRepository,
      syncPublisher: publisher,
      now: () => now,
      serviceId: "state-service",
    }),
    publisher,
    "state-service",
  );

  return {
    appInbox,
    reader,
  };
}

async function processCreateGroup(
  appInbox: AppInboxService,
  reader: InboxQueueReader,
  groupId: string,
) {
  const requestId = `create-${groupId}`;
  const resultPromise = appInbox.processEntryUntilCompletion<
    GroupCreateAppInboxPayload,
    GroupStateWritten
  >({
    type: AppInboxType.GROUP_CREATE,
    resourceId: requestId,
    contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
    senderId: "alice",
    data: {
      scope: SCOPE,
      request: {
        groupId,
        displayName: groupId === "room-1" ? "Room 1" : "Room 2",
        kind: "room",
        joinMode: "open",
        createdByPrincipalId: "alice",
        requestId,
      },
    },
  });

  await reader.dequeueInbox(
    InboxQueueReader.INBOX_DEQUEUE_TYPES,
    createResilience(),
  );

  return await resultPromise;
}

function createResilience(): ResilienceDto {
  const duration = Temporal.Duration.from({ seconds: 10 });
  return ResilienceDto.toResilienceDto(
    new CircuitBreakerPolicy(10, duration, duration, duration),
    1,
    10,
    1,
    1,
  );
}

function createPublisher(
  enqueueOutboxIfAbsent: (message: ALMessage) => Promise<unknown>,
) {
  return createWsStateSyncPublisher(
    { enqueueOutboxIfAbsent } as unknown as WsQueueBoxServerService,
    {
      serverId: "test-server",
    },
  );
}
