import { vi } from 'vitest';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { createTestGroupStateService as createGroupStateService } from '../group-state-test-runtime.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';

export const SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

export async function seedGroup(
  runtimeRepository: FakeRuntimeStateRepository,
  groupId: string,
): Promise<void> {
  await createGroupStateService({
    runtimeRepository,
    syncPublisher: createPublisher(),
    now: () => 1_000,
    serviceId: 'group-service',
  }).createGroup(SCOPE, {
    groupId,
    displayName: groupId,
    kind: 'room',
    joinMode: 'open',
    createdByPrincipalId: 'alice',
    requestId: `seed-${groupId}`,
  });
}

export async function seedPresenceSession(
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
    serviceId: 'group-service',
  }).connectPresenceSession(SCOPE, groupId, 'session-1', {
    principalId: 'alice',
    generationId: 'generation-session-1',
    actorPrincipalId: 'alice',
    connectedAtEpochMs: 2_000,
    lastHeartbeatAtEpochMs: overrides.lastHeartbeatAtEpochMs ?? 2_000,
    expiresAtEpochMs: overrides.expiresAtEpochMs ?? Date.now() + 60_000,
    requestId: `seed-session-${groupId}`,
  });
}

export function toGroupRef(groupId: string): GroupRef {
  return {
    ...SCOPE,
    groupId,
  };
}

export function createPublisher(
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
        throw new Error('group snapshot publish unavailable');
      }
    }),
    publishGroupEvent: vi.fn(async () => {
      groupEventCalls += 1;
      if (groupEventCalls <= (options.failGroupEventCalls ?? 0)) {
        throw new Error('group event publish unavailable');
      }
    }),
  };
}
