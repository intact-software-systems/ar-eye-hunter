import { describe, expect, it, vi } from 'vitest';

import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { createTestAuthSession, createTestGroupStateService } from './group-state-test-runtime.ts';
import {
  ApplyingGuardedBatchRepository,
  OrderedGroupEventStore,
} from './group-state-guarded-batch-test-runtime.ts';

const SCOPE = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
} as const;

describe('GroupStateService guarded batch write boundary', () => {
  it('omits the optional receipt and keeps replay/no-op outside transactions', async () => {
    const runtime = new ApplyingGuardedBatchRepository();
    const eventStore = new OrderedGroupEventStore(runtime);
    let generatedId = 0;
    const service = createTestGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: () => eventStore,
      now: () => 1_000,
      randomId: () => `write-boundary-id-${++generatedId}`,
      serviceId: 'write-boundary-service',
    });
    const createRequest = {
      groupId: 'write-boundary',
      displayName: 'Write boundary',
      kind: 'room' as const,
      joinMode: 'open' as const,
      createdByPrincipalId: 'alice',
      requestId: 'write-boundary-create',
    };
    await service.createGroup(SCOPE, createRequest);
    runtime.resetObservations();

    const updated = await service.updateGroup(SCOPE, createRequest.groupId, {
      displayName: 'Updated without receipt',
      actorPrincipalId: 'alice',
    });

    const acceptedUpdate = updated.result.right;
    if (!acceptedUpdate) {
      throw new Error(updated.result.left ?? 'Expected accepted group update');
    }
    expect(acceptedUpdate.event).not.toBeNull();
    expect(runtime.beginCount).toBe(1);
    expect(runtime.batches).toHaveLength(1);
    expect(runtime.batches[0]?.guard).toEqual({
      operation: 'update',
      namespace: 'group-state:groups',
      key: groupStateGroupStorageKey(acceptedUpdate.snapshot.group),
      expectedRevision: 0,
      value: JSON.stringify(acceptedUpdate.snapshot.group),
      expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
    });
    expect(runtime.batches[0]?.effects.map(({ effectId }) => effectId)).toEqual(['outbox']);
    expect(runtime.transactionOrder).toEqual(['batch', 'event', 'commit']);
    const eventCountAfterWrite = eventStore.events.length;

    runtime.resetObservations();
    const replayed = await service.createGroup(SCOPE, createRequest);

    expect(replayed.result.right?.event?.eventId).toBe(eventStore.events[0]?.eventId);
    expect(runtime.beginCount).toBe(0);
    expect(runtime.batches).toEqual([]);
    expect(eventStore.events).toHaveLength(eventCountAfterWrite);

    runtime.resetObservations();
    const noOp = await service.updateGroup(SCOPE, createRequest.groupId, {
      displayName: 'Updated without receipt',
      actorPrincipalId: 'alice',
      requestId: 'write-boundary-no-op',
    });

    expect(noOp.result.right?.event).toBeNull();
    expect(runtime.beginCount).toBe(0);
    expect(runtime.batches).toEqual([]);
    expect(eventStore.events).toHaveLength(eventCountAfterWrite);
  });

  it('re-verifies auth and reruns every phase outside the retried transaction', async () => {
    const runtime = new ApplyingGuardedBatchRepository();
    const eventStore = new OrderedGroupEventStore(runtime);
    const authority = createTestAuthSession('alice');
    const authSessionRepository = {
      findBySessionId: vi.fn(async (sessionId: string) =>
        sessionId === authority.sessionId ? authority : undefined,
      ),
    };
    const timing: RallarTimingEvent[] = [];
    const sleep = vi.fn(async () => {
      expect(runtime.activeTransactionDepth).toBe(0);
    });
    let generatedId = 0;
    const service = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: () => eventStore,
      authSessionRepository,
      now: () => 1_000,
      randomId: () => `retry-boundary-id-${++generatedId}`,
      sleep,
      timing: (event) => timing.push(event),
      serviceId: 'retry-boundary-service',
    });
    const groupId = 'retry-boundary';
    await service.createGroup(
      SCOPE,
      {
        groupId,
        displayName: 'Retry boundary',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: 'retry-boundary-seed',
      },
      authority,
    );
    runtime.resetObservations();
    authSessionRepository.findBySessionId.mockClear();
    timing.length = 0;
    runtime.forceNextConflict('guard');

    await service.updateGroup(
      SCOPE,
      groupId,
      {
        displayName: 'Retried after fresh verification',
        actorPrincipalId: 'alice',
        requestId: 'retry-boundary-update',
      },
      authority,
    );

    expect(authSessionRepository.findBySessionId).toHaveBeenCalledTimes(3);
    for (const operation of ['mutation.read', 'mutation.compute', 'mutation.validate']) {
      expect(
        timing
          .filter(
            (event) => event.requestId === 'retry-boundary-update' && event.operation === operation,
          )
          .map((event) => event.details?.attempt),
      ).toEqual([0, 1]);
    }
    expect(runtime.beginCount).toBe(2);
    expect(runtime.batches).toHaveLength(2);
    expect(runtime.insideTransactionReadCount).toBe(0);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(2);
  });
});
