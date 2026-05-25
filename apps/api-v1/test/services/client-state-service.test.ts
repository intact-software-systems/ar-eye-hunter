import assert from 'node:assert/strict';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type {
  ClientMutationWritten,
  ClientStateWritten,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import type {
  RuntimeStateEntry,
  RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { createClientStateService } from '../../src/services/client-state-service.ts';
import type { StateSyncPublisher } from '../../src/services/state-sync-service.ts';

const TEST_SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};
const INITIAL_EXPIRES_AT_EPOCH_MS = 4_102_444_821_000;
const REFRESHED_EXPIRES_AT_EPOCH_MS = 4_102_444_822_000;

const NO_OP_SYNC_PUBLISHER: StateSyncPublisher = {
  publishClientSnapshot: async () => {
  },
  publishClientEvent: async () => {
  },
  publishGroupSnapshot: async () => {
  },
  publishGroupEvent: async () => {
  },
};

Deno.test('heartbeatSession refreshes TTL without publishing unchanged snapshots', async () => {
  const syncPublisher = createRecordingStateSyncPublisher();
  const service = createTestClientStateService(syncPublisher);

  await service.connectSession(
    TEST_SCOPE,
    'client-1',
    'instance-1',
    'session-1',
    {
      presenceState: 'online',
      actorPrincipalId: 'client-1',
      actorSessionId: 'session-1',
      lastHeartbeatAtEpochMs: 1_000,
      expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
    },
  );
  syncPublisher.reset();

  const before = await readSnapshot(service);
  const refreshed = requireClientStateWrittenSnapshot(
    await service.heartbeatSession(
      TEST_SCOPE,
      'client-1',
      'instance-1',
      'session-1',
      {
        presenceState: 'online',
        actorPrincipalId: 'client-1',
        actorSessionId: 'session-1',
        lastHeartbeatAtEpochMs: 2_000,
        expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
      },
    ),
  );

  assert.equal(
    refreshed.principal.presenceVersion,
    before.principal.presenceVersion,
  );
  assert.equal(refreshed.principal.snapshotVersion, before.principal.snapshotVersion);
  assert.equal(refreshed.activeSessions[0].lastHeartbeatAtEpochMs, 2_000);
  assert.equal(
    refreshed.activeSessions[0].expiresAtEpochMs,
    REFRESHED_EXPIRES_AT_EPOCH_MS,
  );
  assert.equal(syncPublisher.clientSnapshots.length, 0);
  assert.equal(syncPublisher.clientEvents.length, 0);
});

Deno.test('heartbeatSession returns an event when presence state changes without publishing directly', async () => {
  const syncPublisher = createRecordingStateSyncPublisher();
  const service = createTestClientStateService(syncPublisher);

  await service.connectSession(
    TEST_SCOPE,
    'client-1',
    'instance-1',
    'session-1',
    {
      presenceState: 'online',
      actorPrincipalId: 'client-1',
      actorSessionId: 'session-1',
      lastHeartbeatAtEpochMs: 1_000,
      expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
    },
  );
  syncPublisher.reset();

  const before = await readSnapshot(service);
  const refreshedWritten = await service.heartbeatSession(
    TEST_SCOPE,
    'client-1',
    'instance-1',
    'session-1',
    {
      presenceState: 'away',
      actorPrincipalId: 'client-1',
      actorSessionId: 'session-1',
      lastHeartbeatAtEpochMs: 2_000,
      expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
    },
  );
  const refreshed = requireClientStateWrittenSnapshot(refreshedWritten);
  const event = requireClientStateWrittenEvent(refreshedWritten);

  assert.equal(
    refreshed.principal.presenceVersion,
    before.principal.presenceVersion + 1,
  );
  assert.equal(refreshed.principal.snapshotVersion, before.principal.snapshotVersion + 1);
  assert.equal(refreshed.activeSessions[0].presenceState, 'away');
  assert.equal(syncPublisher.clientSnapshots.length, 0);
  assert.equal(syncPublisher.clientEvents.length, 0);
  assert.equal(event.eventType, 'session-heartbeat');
});

Deno.test('upsertPrincipal ignores unchanged profile state', async () => {
  const syncPublisher = createRecordingStateSyncPublisher();
  const service = createTestClientStateService(syncPublisher);

  const created = requireClientStateWrittenSnapshot(
    await service.upsertPrincipal(TEST_SCOPE, 'client-1', {
      username: 'client-1',
      displayName: 'Client One',
      roles: ['member'],
      metadata: { score: 1 },
      actorPrincipalId: 'client-1',
    }),
  );
  syncPublisher.reset();

  const unchanged = requireClientStateWrittenSnapshot(
    await service.upsertPrincipal(TEST_SCOPE, 'client-1', {
      username: 'client-1',
      displayName: 'Client One',
      roles: ['member'],
      metadata: { score: 1 },
      actorPrincipalId: 'client-1',
    }),
  );

  assert.equal(unchanged.principal.profileVersion, created.principal.profileVersion);
  assert.equal(unchanged.principal.snapshotVersion, created.principal.snapshotVersion);
  assert.equal(syncPublisher.clientSnapshots.length, 0);
  assert.equal(syncPublisher.clientEvents.length, 0);
});

Deno.test('upsertInstance bumps profile version only for semantic instance changes', async () => {
  const syncPublisher = createRecordingStateSyncPublisher();
  const service = createTestClientStateService(syncPublisher);

  await service.upsertPrincipal(TEST_SCOPE, 'client-1', {
    username: 'client-1',
    actorPrincipalId: 'client-1',
  });
  syncPublisher.reset();

  const registered = requireClientStateWrittenSnapshot(
    await service.upsertInstance(
      TEST_SCOPE,
      'client-1',
      'instance-1',
      {
        platform: 'web',
        capabilities: ['rtc'],
        actorPrincipalId: 'client-1',
      },
    ),
  );
  syncPublisher.reset();

  const unchanged = requireClientStateWrittenSnapshot(
    await service.upsertInstance(
      TEST_SCOPE,
      'client-1',
      'instance-1',
      {
        platform: 'web',
        capabilities: ['rtc'],
        actorPrincipalId: 'client-1',
      },
    ),
  );
  const updatedWritten = await service.upsertInstance(
    TEST_SCOPE,
    'client-1',
    'instance-1',
    {
      platform: 'web',
      capabilities: ['rtc', 'ws'],
      actorPrincipalId: 'client-1',
    },
  );
  const updated = requireClientStateWrittenSnapshot(updatedWritten);
  const updatedEvent = requireClientStateWrittenEvent(updatedWritten);

  assert.equal(unchanged.principal.profileVersion, registered.principal.profileVersion);
  assert.equal(unchanged.principal.snapshotVersion, registered.principal.snapshotVersion);
  assert.equal(updated.principal.profileVersion, registered.principal.profileVersion + 1);
  assert.equal(updated.principal.snapshotVersion, registered.principal.snapshotVersion + 1);
  assert.equal(syncPublisher.clientSnapshots.length, 0);
  assert.equal(syncPublisher.clientEvents.length, 0);
  assert.equal(updatedEvent.eventType, 'instance-updated');
});

Deno.test('semantic client mutations advance snapshotVersion', async () => {
  const service = createTestClientStateService();

  const createdWritten = await service.upsertPrincipal(TEST_SCOPE, 'client-1', {
    username: 'client-1',
    displayName: 'Client One',
    actorPrincipalId: 'client-1',
  });
  const created = requireClientStateWrittenSnapshot(createdWritten);
  assert.equal(created.principal.snapshotVersion, 1);
  assert.equal(requireClientStateWrittenEvent(createdWritten).snapshotVersion, 1);

  const unchanged = requireClientStateWrittenSnapshot(
    await service.upsertPrincipal(TEST_SCOPE, 'client-1', {
      username: 'client-1',
      displayName: 'Client One',
      actorPrincipalId: 'client-1',
    }),
  );
  assert.equal(unchanged.principal.snapshotVersion, 1);

  const profileUpdatedWritten = await service.upsertPrincipal(TEST_SCOPE, 'client-1', {
    username: 'client-1',
    displayName: 'Client 1',
    actorPrincipalId: 'client-1',
  });
  const profileUpdated = requireClientStateWrittenSnapshot(profileUpdatedWritten);
  assert.equal(profileUpdated.principal.snapshotVersion, 2);
  assert.equal(
    requireClientStateWrittenEvent(profileUpdatedWritten).snapshotVersion,
    2,
  );

  const instanceRegisteredWritten = await service.upsertInstance(
    TEST_SCOPE,
    'client-1',
    'instance-1',
    {
      platform: 'web',
      actorPrincipalId: 'client-1',
    },
  );
  const instanceRegistered = requireClientStateWrittenSnapshot(
    instanceRegisteredWritten,
  );
  assert.equal(instanceRegistered.principal.snapshotVersion, 3);
  assert.equal(
    requireClientStateWrittenEvent(instanceRegisteredWritten).snapshotVersion,
    3,
  );

  const sessionConnectedWritten = await service.connectSession(
    TEST_SCOPE,
    'client-1',
    'instance-1',
    'session-1',
    {
      presenceState: 'online',
      actorPrincipalId: 'client-1',
      actorSessionId: 'session-1',
      lastHeartbeatAtEpochMs: 2_000,
      expiresAtEpochMs: INITIAL_EXPIRES_AT_EPOCH_MS,
    },
  );
  const sessionConnected = requireClientStateWrittenSnapshot(sessionConnectedWritten);
  assert.equal(sessionConnected.principal.snapshotVersion, 4);
  assert.equal(
    requireClientStateWrittenEvent(sessionConnectedWritten).snapshotVersion,
    4,
  );

  const heartbeatOnly = requireClientStateWrittenSnapshot(
    await service.heartbeatSession(
      TEST_SCOPE,
      'client-1',
      'instance-1',
      'session-1',
      {
        presenceState: 'online',
        actorPrincipalId: 'client-1',
        actorSessionId: 'session-1',
        lastHeartbeatAtEpochMs: 3_000,
        expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
      },
    ),
  );
  assert.equal(heartbeatOnly.principal.snapshotVersion, 4);

  const presenceUpdatedWritten = await service.heartbeatSession(
    TEST_SCOPE,
    'client-1',
    'instance-1',
    'session-1',
    {
      presenceState: 'away',
      actorPrincipalId: 'client-1',
      actorSessionId: 'session-1',
      lastHeartbeatAtEpochMs: 4_000,
      expiresAtEpochMs: REFRESHED_EXPIRES_AT_EPOCH_MS,
    },
  );
  const presenceUpdated = requireClientStateWrittenSnapshot(presenceUpdatedWritten);
  assert.equal(presenceUpdated.principal.snapshotVersion, 5);
  assert.equal(
    requireClientStateWrittenEvent(presenceUpdatedWritten).snapshotVersion,
    5,
  );

  const disconnectedWritten = await service.disconnectSession(
    TEST_SCOPE,
    'client-1',
    'instance-1',
    'session-1',
    {
      actorPrincipalId: 'client-1',
      actorSessionId: 'session-1',
      lastHeartbeatAtEpochMs: 5_000,
    },
  );
  const disconnected = requireClientStateWrittenSnapshot(disconnectedWritten);
  assert.equal(disconnected.principal.snapshotVersion, 6);
  assert.equal(
    requireClientStateWrittenEvent(disconnectedWritten).snapshotVersion,
    6,
  );
});

function createTestClientStateService(
  syncPublisher: StateSyncPublisher = NO_OP_SYNC_PUBLISHER,
) {
  return createClientStateService({
    runtimeRepository: new FakeRuntimeStateRepository(),
    syncPublisher,
    now: () => 1_000,
    serviceId: 'test-service',
  });
}

function createRecordingStateSyncPublisher() {
  const clientSnapshots: ClientSnapshot[] = [];
  const clientEvents: ClientEvent[] = [];

  return {
    clientSnapshots,
    clientEvents,
    reset() {
      clientSnapshots.length = 0;
      clientEvents.length = 0;
    },
    publishClientSnapshot: async (snapshot: ClientSnapshot) => {
      clientSnapshots.push(snapshot);
    },
    publishClientEvent: async (event: ClientEvent) => {
      clientEvents.push(event);
    },
    publishGroupSnapshot: async () => {
    },
    publishGroupEvent: async () => {
    },
  } satisfies StateSyncPublisher & {
    clientSnapshots: ClientSnapshot[];
    clientEvents: ClientEvent[];
    reset(): void;
  };
}

function requireClientStateWrittenSnapshot(
  written: ClientStateWritten,
): ClientSnapshot {
  return requireClientMutationWritten(written).snapshot;
}

function requireClientStateWrittenEvent(
  written: ClientStateWritten,
): ClientEvent {
  const event = requireClientMutationWritten(written).event;
  if (!event) {
    throw new Error('Expected client mutation event');
  }

  return event;
}

function requireClientMutationWritten(
  written: ClientStateWritten,
): ClientMutationWritten {
  const mutation = written.result.right;
  if (!mutation) {
    throw new Error(written.result.left ?? 'Client mutation failed');
  }

  return mutation;
}

async function readSnapshot(
  service: ReturnType<typeof createTestClientStateService>,
): Promise<ClientSnapshot> {
  const snapshot = await service.readSnapshot({
    ...TEST_SCOPE,
    principalId: 'client-1',
  });
  if (!snapshot) {
    throw new Error('Expected client snapshot to exist');
  }

  return snapshot;
}

class FakeRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
  readonly data = new Map<string, RuntimeStateEntry>();

  async begin<T>(
    fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
  ): Promise<T> {
    return await fn(this);
  }

  findEntry(
    namespace: string,
    key: string,
  ): Promise<RuntimeStateEntry | undefined> {
    const entry = this.data.get(this.toKey(namespace, key));
    return Promise.resolve(entry ? { ...entry } : undefined);
  }

  findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
    return Promise.resolve(
      [...this.data.entries()]
        .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
        .map(([, entry]) => ({ ...entry }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    );
  }

  findEntriesByPrefix(
    namespace: string,
    keyPrefix: string,
  ): Promise<readonly RuntimeStateEntry[]> {
    return Promise.resolve(
      [...this.data.entries()]
        .filter(
          ([compositeKey]) =>
            this.toNamespace(compositeKey) === namespace &&
            this.toStoreKey(compositeKey).startsWith(keyPrefix),
        )
        .map(([, entry]) => ({ ...entry }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    );
  }

  upsert(
    namespace: string,
    key: string,
    value: string,
    expireAtTimestamp: number,
  ): Promise<void> {
    const compositeKey = this.toKey(namespace, key);
    const current = this.data.get(compositeKey);
    this.data.set(compositeKey, {
      key,
      value,
      expireAtTimestamp,
      updatedTimestamp: new Date().toISOString(),
      revision: current ? current.revision + 1 : 0,
    });
    return Promise.resolve();
  }

  deleteByKey(namespace: string, key: string): Promise<void> {
    this.data.delete(this.toKey(namespace, key));
    return Promise.resolve();
  }

  deleteExpired(namespace: string): Promise<number> {
    let deleted = 0;

    for (const [compositeKey, entry] of this.data.entries()) {
      if (this.toNamespace(compositeKey) !== namespace) {
        continue;
      }

      if (entry.expireAtTimestamp > Date.now()) {
        continue;
      }

      this.data.delete(compositeKey);
      deleted += 1;
    }

    return Promise.resolve(deleted);
  }

  async lockKey(_namespace: string, _key: string): Promise<void> {
  }

  private toKey(namespace: string, key: string): string {
    return `${namespace}::${key}`;
  }

  private toNamespace(compositeKey: string): string {
    return compositeKey.split('::', 1)[0] ?? '';
  }

  private toStoreKey(compositeKey: string): string {
    return compositeKey.slice(this.toNamespace(compositeKey).length + 2);
  }
}
