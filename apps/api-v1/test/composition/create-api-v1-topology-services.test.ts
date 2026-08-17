import assert from 'node:assert/strict';

import type { GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type {
  RuntimeStateEntry,
  RuntimeStateRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import type {
  RtcRttAppInboxDependencies,
} from '@shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts';

import {
  createApiV1TopologyServices,
  type CreateApiV1TopologyServicesInput,
} from '../../src/composition/create-api-v1-topology-services.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

const NOW_EPOCH_MS = 4_000_000_000_000;

Deno.test('topology composition installs canonical owners and RTT policy inputs', async () => {
  const runtimeStateRepository = new MemoryRuntimeStateRepository();
  let installedTopology: GroupTopologyManagementService | undefined;
  let installedRtt: RtcRttAppInboxDependencies | undefined;
  const snapshot = createGroupSnapshot();
  const formationEvents: unknown[] = [];
  const input: CreateApiV1TopologyServicesInput = {
    runtimeStateRepository,
    groupStateService: {
      readSnapshotAtLeast: () => Promise.resolve(snapshot),
    },
    groupInbox: {
      setTopologyManagementService: (service) => {
        installedTopology = service;
      },
      setRtcRttAppInboxDependencies: (dependencies) => {
        installedRtt = dependencies;
      },
    },
    groupFormationRttMutation: (event) => formationEvents.push(event),
    webSocketServer: new JsonWebSocketServer(),
    topologyReplayMetrics: {
      readMetrics: () => ({ replayWakeCount: 2 }),
      resetMetrics: () => {},
    },
    serviceId: 'api-test',
    adminClientIds: ['admin'],
    rtcTopologyOptions: { rttReportingDegreeLimit: 7 },
    rttRefinementGateConfig: {
      minIntervalMs: 30_000,
      vivaldiDeltaThresholdMs: 5,
    },
    nowEpochMs: () => NOW_EPOCH_MS,
    timing: () => {},
  };

  const services = createApiV1TopologyServices(input);

  assert.ok(services.rtcTopologyService instanceof RallarRtcTopologyService);
  assert.ok(services.topologyManagement instanceof GroupTopologyManagementService);
  assert.ok(services.topologyConfigRepository instanceof GroupTopologyConfigRepository);
  assert.ok(services.groupStateRepository instanceof GroupStateRepository);
  assert.ok(services.topologySnapshotRepository instanceof RtcTopologySnapshotRepository);
  assert.ok(services.rttRepository instanceof RtcRttRepository);
  assert.equal(installedTopology, services.topologyManagement);
  assert.equal(installedRtt?.repository, services.rttRepository);
  assert.equal(installedRtt?.formationMetrics, input.groupFormationRttMutation);
  assert.deepEqual(services.adminClientIds, ['admin']);
  assert.equal(services.topologyManagement.isPlatformAdmin('admin'), true);
  assert.equal(services.topologyManagement.isPlatformAdmin('user'), false);
  assert.deepEqual(services.readRtcTopologyMetrics(), {
    ...services.rtcTopologyService.readMetrics(),
    replay: { replayWakeCount: 2 },
  });

  await services.groupStateRepository.putPresenceSession(
    createPresenceSession('session-from', 'alice'),
  );
  await services.groupStateRepository.putPresenceSession(
    createPresenceSession('session-to', 'bob'),
  );
  assert.equal((await services.groupStateRepository.listAllPresenceSessions()).length, 2);
  const policy = await installedRtt?.readPolicyInputs({
    actor: { principalId: 'alice', sessionId: 'session-from' },
    requestId: 'request-1',
    commandHash: `sha256:${'1'.repeat(64)}`,
    mutationCommandHash: `sha256:${'2'.repeat(64)}`,
    capturedAtEpochMs: NOW_EPOCH_MS,
    rtt: {
      sessionIdFrom: 'session-from',
      sessionIdTo: 'session-to',
      rttMs: 12,
      createdAtEpochMs: NOW_EPOCH_MS,
      version: 1,
    },
  });

  assert.deepEqual(policy?.candidateGroups, [snapshot]);
  assert.equal(policy?.overlaySnapshotsByGroupKey.size, 0);
  assert.equal(policy?.degreeLimit, 7);
  assert.deepEqual(formationEvents, []);
});

Deno.test('topology composition propagates group AppInbox installation failure', () => {
  const failure = new Error('topology installation failed');
  const input = createMinimalInput();
  input.groupInbox.setTopologyManagementService = () => {
    throw failure;
  };

  assert.throws(() => createApiV1TopologyServices(input), (error) => error === failure);
});

function createMinimalInput(): CreateApiV1TopologyServicesInput {
  return {
    runtimeStateRepository: new MemoryRuntimeStateRepository(),
    groupStateService: { readSnapshotAtLeast: () => Promise.resolve(undefined) },
    groupInbox: {
      setTopologyManagementService: () => {},
      setRtcRttAppInboxDependencies: () => {},
    },
    groupFormationRttMutation: () => {},
    webSocketServer: new JsonWebSocketServer(),
    topologyReplayMetrics: {
      readMetrics: () => ({}),
      resetMetrics: () => {},
    },
    serviceId: 'api-test',
    adminClientIds: [],
    rtcTopologyOptions: {},
    rttRefinementGateConfig: {
      minIntervalMs: 30_000,
      vivaldiDeltaThresholdMs: 5,
    },
    nowEpochMs: () => NOW_EPOCH_MS,
    timing: () => {},
  };
}

function createPresenceSession(
  sessionId: string,
  principalId: string,
): GroupPresenceSession {
  return {
    applicationId: 'app',
    workspaceId: 'workspace',
    groupId: 'group',
    sessionId,
    principalId,
    generationId: `generation-${sessionId}`,
    generationVersion: 1,
    connectedAtEpochMs: 1,
    lastHeartbeatAtEpochMs: 2,
    expiresAtEpochMs: NOW_EPOCH_MS + 1_000,
    status: 'active',
    disconnectedAtEpochMs: null,
    disconnectReason: null,
  };
}

function createGroupSnapshot(): GroupSnapshot {
  const audit = {
    atEpochMs: 1,
    actor: { kind: 'session' as const, principalId: 'owner', sessionId: 'owner-session' },
    reason: null,
    traceId: null,
    requestId: 'create-group',
  };
  return {
    stateRevision: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 1 },
    group: createTestGroup({
      applicationId: 'app',
      workspaceId: 'workspace',
      groupId: 'group',
      displayName: 'Group',
      activeMemberCount: 0,
      ownerPrincipalId: 'owner',
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 1,
      created: audit,
      updated: audit,
    }),
    members: [],
    activeSessions: [],
    memberCount: 0,
    onlineMemberCount: 0,
  };
}

class MemoryRuntimeStateRepository implements RuntimeStateRepositoryLike {
  private readonly entries = new Map<string, RuntimeStateEntry>();

  findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
    return Promise.resolve(this.entries.get(`${namespace}:${key}`));
  }

  findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
    return Promise.resolve(
      [...this.entries.entries()]
        .filter(([key]) => key.startsWith(`${namespace}:`))
        .map(([, entry]) => entry),
    );
  }

  upsert(
    namespace: string,
    key: string,
    value: string,
    expireAtTimestamp: number,
  ): Promise<void> {
    const identity = `${namespace}:${key}`;
    const current = this.entries.get(identity);
    this.entries.set(identity, {
      key,
      value,
      expireAtTimestamp,
      updatedTimestamp: new Date(0).toISOString(),
      revision: current ? current.revision + 1 : 0,
    });
    return Promise.resolve();
  }

  deleteByKey(namespace: string, key: string): Promise<void> {
    this.entries.delete(`${namespace}:${key}`);
    return Promise.resolve();
  }

  deleteExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}
