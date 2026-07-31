import { describe, expect, it } from 'vitest';

import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
  ApplyingGuardedBatchRepository,
  OrderedGroupEventStore,
} from './group-mutation-test-runtime.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';

const SCOPE = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
} as const;
const BASE_EPOCH_MS = 1_900_000_000_000;

describe('GroupStateService guarded batch fallback equivalence', () => {
  it('keeps capable and sequential logical rows and events equivalent', async () => {
    const guardedRuntime = new ApplyingGuardedBatchRepository();
    const guardedEvents = new OrderedGroupEventStore(guardedRuntime);
    const fallbackRuntime = new FakeRuntimeStateRepository();
    const fallbackEvents = new InMemoryGroupStateEventStore();

    const guardedResults = await runScenario(guardedRuntime, guardedEvents);
    const fallbackResults = await runScenario(fallbackRuntime, fallbackEvents);

    expect(guardedResults).toEqual(fallbackResults);
    expect(logicalRuntimeStateRows(guardedRuntime)).toEqual(
      logicalRuntimeStateRows(fallbackRuntime),
    );
    expect(guardedEvents.events).toEqual(fallbackEvents.events);
    expect(guardedRuntime.batches).toHaveLength(5);
  });
});

async function runScenario(
  runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
  eventStore: InMemoryGroupStateEventStore,
) {
  let nowEpochMs = BASE_EPOCH_MS;
  let generatedId = 0;
  const service = createTestGroupStateService({
    runtimeRepository: runtime,
    createGroupStateEventStore: () => eventStore,
    now: () => nowEpochMs,
    randomId: () => `equivalence-id-${++generatedId}`,
    serviceId: 'equivalence-service',
  });
  const groupId = 'guarded-fallback-equivalence';
  const created = await service.createGroup(SCOPE, {
    groupId,
    displayName: 'Equivalence',
    kind: 'room',
    joinMode: 'open',
    createdByPrincipalId: 'alice',
    requestId: 'equivalence-create',
  });
  nowEpochMs += 1_000;
  const updated = await service.updateGroup(SCOPE, groupId, {
    displayName: 'Equivalent update',
    actorPrincipalId: 'alice',
  });
  nowEpochMs += 1_000;
  const connected = await service.connectPresenceSessionReceipt(
    SCOPE,
    groupId,
    'equivalence-session',
    {
      principalId: 'alice',
      generationId: 'equivalence-generation',
      expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
      requestId: 'equivalence-connect',
    },
  );
  nowEpochMs += 1_000;
  const heartbeat = await service.heartbeatPresenceSessionReceipt(
    SCOPE,
    groupId,
    'equivalence-session',
    {
      generationId: 'equivalence-generation',
      lastHeartbeatAtEpochMs: nowEpochMs,
      expiresAtEpochMs: BASE_EPOCH_MS + 70_000,
      requestId: 'equivalence-heartbeat',
    },
  );
  nowEpochMs += 1_000;
  const disconnected = await service.disconnectPresenceSessionReceipt(
    SCOPE,
    groupId,
    'equivalence-session',
    {
      generationId: 'equivalence-generation',
      disconnectedAtEpochMs: nowEpochMs,
      requestId: 'equivalence-disconnect',
    },
  );
  return { created, updated, connected, heartbeat, disconnected };
}

function logicalRuntimeStateRows(repository: FakeRuntimeStateRepository): readonly Readonly<{
  identity: string;
  key: string;
  value: string;
  expireAtTimestamp: number;
  revision: number;
}>[] {
  return [...repository.data.entries()]
    .map(([identity, entry]) => ({
      identity,
      key: entry.key,
      value: entry.value,
      expireAtTimestamp: entry.expireAtTimestamp,
      revision: entry.revision,
    }))
    .sort((left, right) => left.identity.localeCompare(right.identity));
}
