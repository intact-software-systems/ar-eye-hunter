import { describe, expect, it, vi } from 'vitest';

import type { GroupRef } from '@shared/api/group-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
// prettier-ignore
import {
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
// prettier-ignore
import {
  GroupTopologyConfigRepository,
} from
  '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
// prettier-ignore
import {
  GroupTopologyManagementService,
} from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
// prettier-ignore
import {
  RallarRtcTopologyService,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
// prettier-ignore
import {
  computeRtcTopologyEntry,
} from '@shared-server/rallar-system/services/rtc-topology-outbox-entry.ts';
import {
  type AppInboxMessageContext,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
// prettier-ignore
import {
  createAuthenticatedTopologyEnqueue,
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts';
import {
  toTopologyAppInboxCommand,
  toTopologyConfigMutationCommand,
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import {
  TopologyAppInboxHandler,
  type TopologyAppInboxMutationOwners,
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import {
  createAuthorityHarness,
  createResilience,
  createRoom,
  SCOPE,
  waitForQueueEntry,
  type AuthorityHarness,
} from './group-state/inbox/group-state-inbox-test-runtime.ts';

const GROUP_REF: GroupRef = {
  ...SCOPE,
  groupId: 'topology-room',
};

describe('topology AppInbox transaction and idempotency', () => {
  it('coalesces concurrent identical commands into one durable mutation and result', async () => {
    const wakeQueue = vi.fn();
    const harness = await createAuthorityHarness(['owner'], { wakeQueue });
    await createRoom(harness, GROUP_REF.groupId, 'Topology room');
    const repository = configureTopology(harness);
    wakeQueue.mockClear();
    const initialOutboxCount = harness.database.outboxEntries.size;
    const command = await topologyCommand('same-request', 4);
    const enqueue = topologyEnqueue(command);

    const first = harness.service.processAuthenticatedTopologyEntryUntilCompletion(
      enqueue,
      harness.sessions.owner,
    );
    await waitForQueueEntry(harness.queue);
    const second = harness.service.processAuthenticatedTopologyEntryUntilCompletion(
      structuredClone(enqueue),
      harness.sessions.owner,
    );
    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.right).toMatchObject({
      receipt: { requestId: command.requestId, outcome: 'applied' },
    });
    expect(await repository.findMutationRecord(GROUP_REF, command.requestId)).toMatchObject({
      requestId: command.requestId,
      commandHash: command.commandHash,
    });
    expect(harness.database.outboxEntries.size).toBe(initialOutboxCount + 1);
    expect(wakeQueue).toHaveBeenCalled();
  });

  it('rejects concurrent reuse of one queue identity with divergent command content', async () => {
    const harness = await createAuthorityHarness(['owner']);
    await createRoom(harness, GROUP_REF.groupId, 'Topology room');
    configureTopology(harness);
    const firstCommand = await topologyCommand('divergent-request', 4);
    const secondCommand = await topologyCommand('divergent-request', 7);
    const first = harness.service.processAuthenticatedTopologyEntryUntilCompletion(
      topologyEnqueue(firstCommand),
      harness.sessions.owner,
    );
    await waitForQueueEntry(harness.queue);

    await expect(
      harness.service.processAuthenticatedTopologyEntryUntilCompletion(
        topologyEnqueue(secondCommand),
        harness.sessions.owner,
      ),
    ).rejects.toMatchObject({ code: 'app-inbox-idempotency-conflict' });
    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    await expect(first).resolves.toMatchObject({ right: expect.any(Object) });
  });

  it('rolls back topology state when the RTC APP_OUTBOX write collides', async () => {
    const wakeQueue = vi.fn();
    const harness = await createAuthorityHarness(['owner'], { wakeQueue });
    await createRoom(harness, GROUP_REF.groupId, 'Topology room');
    const repository = new GroupTopologyConfigRepository(harness.runtimeRepository);
    const management = topologyManagement(harness, repository);
    wakeQueue.mockClear();
    const initialOutboxCount = harness.database.outboxEntries.size;
    const command = await topologyCommand('collision-request', 5);
    const mutationCommand = toTopologyConfigMutationCommand(command);
    const preparation = await management.prepareTopologyConfigMutation({
      command: mutationCommand,
      commandHash: command.commandHash,
      capturedAtEpochMs: command.capturedAtEpochMs,
    });
    const read = await management.readTopologyConfigMutation(mutationCommand);
    const computed = management.computeTopologyConfigMutation(preparation, read, 1);
    management.validateTopologyConfigMutation(preparation, read, 1, computed);
    expect(computed.outcome).toBe('write');
    if (computed.outcome !== 'write') throw new Error('Expected a topology config write');
    const expectedEntry = computeRtcTopologyEntry(computed.outbox);
    const collisionEntry = computeRtcTopologyEntry({
      ...computed.outbox,
      publish: !computed.outbox.publish,
    });
    expect(collisionEntry.key).toEqual(expectedEntry.key);
    expect(collisionEntry.resource).not.toBe(expectedEntry.resource);
    await harness.database.begin(async (transaction) => {
      await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(collisionEntry);
    });
    expect(harness.database.outboxEntries.size).toBe(initialOutboxCount + 1);
    const enqueue = await createAuthenticatedTopologyEnqueue({
      enqueue: topologyEnqueue(command),
      claimedAuthority: harness.sessions.owner,
      groupStateService: harness.groupStateService,
      nowEpochMs: () => harness.nowEpochMs,
    });
    const handler = new TopologyAppInboxHandler({
      groupStateService: harness.groupStateService,
      nowEpochMs: () => harness.nowEpochMs,
      wakeQueue,
      transactionWriter: {
        writeMutation: async (_context, write) => await harness.database.begin(write),
      },
    });

    await expect(
      handler.processMutation(
        {
          enqueue,
          entry: { dequeueAudit: { attempts: 1 } },
        } as AppInboxMessageContext,
        topologyMutationOwners(management),
      ),
    ).rejects.toMatchObject({ code: 'resource-inbox-invariant-corruption' });
    expect(await repository.findConfig(GROUP_REF)).toBeUndefined();
    expect(await repository.findMutationRecord(GROUP_REF, command.requestId)).toBeUndefined();
    expect(harness.database.outboxEntries.size).toBe(initialOutboxCount + 1);
    expect(
      [...harness.database.outboxEntries.values()].find(
        (entry) => entry.key.resourceId === collisionEntry.key.resourceId,
      ),
    ).toMatchObject({ key: collisionEntry.key, resource: collisionEntry.resource });
    expect(wakeQueue).not.toHaveBeenCalled();
  });
});

function configureTopology(harness: AuthorityHarness): GroupTopologyConfigRepository {
  const repository = new GroupTopologyConfigRepository(harness.runtimeRepository);
  harness.service.setTopologyManagementService(topologyManagement(harness, repository));
  return repository;
}

function topologyManagement(
  harness: AuthorityHarness,
  repository: GroupTopologyConfigRepository,
): GroupTopologyManagementService {
  return new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref) => harness.groupStateService.readSnapshot(ref),
    groupStateRepository: harness.repository,
    configRepository: repository,
    topologyService: new RallarRtcTopologyService(),
    now: () => harness.nowEpochMs,
    serviceId: 'server-12345678',
  });
}

function topologyMutationOwners(
  management: GroupTopologyManagementService,
): TopologyAppInboxMutationOwners {
  if (!management.configMutationService || !management.reconfigureMutation) {
    throw new TypeError('Expected complete topology mutation owners');
  }
  return {
    configMutationService: management.configMutationService,
    reconfigureMutation: management.reconfigureMutation,
  };
}

async function topologyCommand(requestId: string, degreeLimit: number) {
  return await toTopologyAppInboxCommand({
    actor: {
      principalId: 'owner',
      sessionId: 'owner-session',
    },
    groupRef: GROUP_REF,
    requestId,
    capturedAtEpochMs: 1_000,
    payload: {
      operation: 'putConfig',
      config: { topologyKind: 'tree', degreeLimit },
    },
  });
}

function topologyEnqueue(command: Awaited<ReturnType<typeof topologyCommand>>) {
  return {
    type: AppInboxType.TOPOLOGY_CONFIG_PUT,
    topicId: AppInboxType.TOPOLOGY_CONFIG_PUT,
    resourceId: command.requestId,
    contextId:
      `application=${GROUP_REF.applicationId}:workspace=${GROUP_REF.workspaceId}:` +
      `group=${GROUP_REF.groupId}:caller=${command.actor.principalId}`,
    senderId: command.actor.principalId,
    data: command,
  };
}
