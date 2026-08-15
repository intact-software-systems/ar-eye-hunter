import { describe, expect, it, vi } from 'vitest';
import {
  AppTopics,
  ConnectionContext,
  InMemoryQueueBox,
  JsonWebSocketServer,
  newALBroadcastMessage,
  newALEventRoute,
  WsQueueBoxServerService,
  type ALMessage,
} from '@shared/mod.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { latestRttById } from '@shared/repository/rtt-repository.ts';
import {
  initRallarSystemWsTopics,
  type InitRallarSystemWsTopicsOptions,
} from '@shared-server/rallar-system/ws-system-topics.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import * as vivaldiService from '@shared-graph/vivaldi-service.ts';
import { configureTestCacheRepositories } from '../../../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';

describe('RTC RTT websocket topic', () => {
  it('rejects RTT measurements from a mismatched AL sender', async () => {
    configureTestCacheRepositories();
    const { sockets } = createRttHarness(['session-a', 'session-b']);
    const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
    groupStateSnapshotsRepository.setGroupStateSnapshot(group);

    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-b',
        sessionIdTo: 'session-a',
        rttMs: 12,
        createdAtEpochMs: 1,
        version: 1,
      },
      group,
    );

    expect(latestRttById().read('session-a::session-b')).toBeUndefined();
  });

  it('rejects RTT measurements for self pairs', async () => {
    configureTestCacheRepositories();
    const { sockets } = createRttHarness(['session-a']);
    const group = createGroupSnapshot('room-1', ['session-a']);
    groupStateSnapshotsRepository.setGroupStateSnapshot(group);

    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-a',
        rttMs: 12,
        createdAtEpochMs: 1,
        version: 1,
      },
      group,
    );

    expect(latestRttById().read('session-a::session-a')).toBeUndefined();
  });

  it('rejects invalid RTT measurements', async () => {
    configureTestCacheRepositories();
    const { sockets } = createRttHarness(['session-a', 'session-b']);
    const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
    groupStateSnapshotsRepository.setGroupStateSnapshot(group);

    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 0,
        createdAtEpochMs: 1,
        version: 1,
      },
      group,
    );

    expect(latestRttById().read('session-a::session-b')).toBeUndefined();
  });

  it('rejects RTT measurements without a shared active group', async () => {
    configureTestCacheRepositories();
    const { sockets } = createRttHarness(['session-a', 'session-b', 'session-c']);
    const group = createGroupSnapshot('room-1', ['session-a', 'session-c']);
    groupStateSnapshotsRepository.setGroupStateSnapshot(group);

    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 12,
        createdAtEpochMs: 1,
        version: 1,
      },
      group,
    );

    expect(latestRttById().read('session-a::session-b')).toBeUndefined();
  });

  it('rejects RTT measurements outside the reporting edge policy', async () => {
    configureTestCacheRepositories();
    const { sockets, topologyService } = createRttHarness(
      ['session-a', 'session-b', 'session-c', 'session-d'],
      {
        rtcTopologyOptions: {
          rttReportingDegreeLimit: 1,
        },
      },
    );
    const group = createGroupSnapshot('room-1', [
      'session-a',
      'session-b',
      'session-c',
      'session-d',
    ]);
    groupStateSnapshotsRepository.setGroupStateSnapshot(group);
    topologyService.updateGroupTopology(group);

    await dispatchRtt(
      sockets.get('session-c')!,
      'session-c',
      {
        sessionIdFrom: 'session-c',
        sessionIdTo: 'session-d',
        rttMs: 12,
        createdAtEpochMs: 1,
        version: 1,
      },
      group,
    );

    expect(latestRttById().read('session-c::session-d')).toBeUndefined();
  });

  it('ignores stale RTT measurements before Vivaldi or topology work', async () => {
    configureTestCacheRepositories();
    const { sockets, topologyService } = createRttHarness(['session-a', 'session-b'], {
      rtcTopologyOptions: {
        rttRebuildDebounceMs: 0,
      },
    });
    const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
    groupStateSnapshotsRepository.setGroupStateSnapshot(group);
    const observeRtt = vi.spyOn(vivaldiService, 'observeRtt');
    const queueRttTopologyUpdate = vi.spyOn(topologyService, 'queueRttTopologyUpdate');

    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 12,
        createdAtEpochMs: 2,
        version: 2,
      },
      group,
    );

    observeRtt.mockClear();
    queueRttTopologyUpdate.mockClear();

    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 4,
        createdAtEpochMs: 1,
        version: 1,
      },
      group,
    );

    expect(latestRttById().read('session-a::session-b')?.rttMs).toBe(12);
    expect(observeRtt).not.toHaveBeenCalled();
    expect(queueRttTopologyUpdate).not.toHaveBeenCalled();
  });

  it('rejects RTT measurements that would exceed the reporting degree', async () => {
    configureTestCacheRepositories();
    const { sockets } = createRttHarness(['session-a', 'session-b', 'session-c'], {
      rtcTopologyOptions: {
        rttReportingDegreeLimit: 1,
      },
    });
    const group = createGroupSnapshot('room-1', ['session-a', 'session-b', 'session-c']);
    groupStateSnapshotsRepository.setGroupStateSnapshot(group);

    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 12,
        createdAtEpochMs: 1,
        version: 1,
      },
      group,
    );
    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-c',
        rttMs: 13,
        createdAtEpochMs: 2,
        version: 2,
      },
      group,
    );

    expect(latestRttById().read('session-a::session-b')).toBeDefined();
    expect(latestRttById().read('session-a::session-c')).toBeUndefined();
  });

  it('rejects over-degree RTT measurements across active groups', async () => {
    configureTestCacheRepositories();
    const { sockets } = createRttHarness(['session-a', 'session-b', 'session-c'], {
      rtcTopologyOptions: {
        rttReportingDegreeLimit: 1,
      },
    });
    const groupOne = createGroupSnapshot('room-1', ['session-a', 'session-b']);
    const groupTwo = createGroupSnapshot('room-2', ['session-a', 'session-c']);
    groupStateSnapshotsRepository.setGroupStateSnapshot(groupOne);
    groupStateSnapshotsRepository.setGroupStateSnapshot(groupTwo);

    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 12,
        createdAtEpochMs: 1,
        version: 1,
      },
      groupOne,
    );
    await dispatchRtt(
      sockets.get('session-a')!,
      'session-a',
      {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-c',
        rttMs: 13,
        createdAtEpochMs: 2,
        version: 2,
      },
      groupTwo,
    );

    expect(latestRttById().read('session-a::session-b')).toBeDefined();
    expect(latestRttById().read('session-a::session-c')).toBeUndefined();
  });

  it('does not schedule process-local topology work after RTT messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    try {
      configureTestCacheRepositories();

      const server = new JsonWebSocketServer();
      const sockets = createSockets([
        'session-a',
        'session-b',
        'session-c',
        'session-d',
        'session-e',
      ]);

      for (const [sessionId, socket] of sockets) {
        server.addConnection(new ConnectionContext(sessionId, socket as never));
      }

      const service = new WsQueueBoxServerService(
        new InMemoryQueueBox(new Map()),
        new InMemoryQueueBox(new Map()),
        server,
        'server-1',
      );
      initRallarSystemWsTopics(service, {
        rtcTopologyOptions: {
          rttRebuildDebounceMs: 100,
        },
      });

      const group = createGroupSnapshot('room-1', [...sockets.keys()]);
      clientStateSnapshotsRepository.setClientStateSnapshots(
        [...sockets.keys()].map(createClientSnapshot),
      );
      const senderSocket = sockets.get('session-a')!;

      await senderSocket.dispatchMessage(
        newALBroadcastMessage(
          'session-a',
          newALEventRoute(AppTopics.groupStateSnapshot, group.group.groupId, 'group-snapshot-1'),
          'room',
          AppTopics.groupStateSnapshot,
          group,
          {
            groupRef: group.group,
          },
        ),
      );

      for (const socket of sockets.values()) {
        socket.sent.length = 0;
      }

      const fullSnapshotScan = vi.spyOn(groupStateSnapshotsRepository, 'getAllGroupStateSnapshots');

      for (const rtt of createCentralRttMeasurements([...sockets.keys()], 'session-a')) {
        await senderSocket.dispatchMessage(
          newALBroadcastMessage(
            'session-a',
            newALEventRoute(AppTopics.rtt, group.group.groupId, `rtt-${rtt.version}`),
            'room',
            AppTopics.rtt,
            rtt,
            {
              groupRef: group.group,
            },
          ),
        );
      }

      expect(fullSnapshotScan).not.toHaveBeenCalled();
      fullSnapshotScan.mockRestore();
      expect(countSentTopologyMessages(sockets)).toBe(0);

      await vi.advanceTimersByTimeAsync(99);
      expect(countSentTopologyMessages(sockets)).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(countSentTopologyMessages(sockets)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes RTT-triggered topology recomputes through app outbox ownership', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    try {
      configureTestCacheRepositories();

      const server = new JsonWebSocketServer();
      const sockets = createSockets([
        'session-a',
        'session-b',
        'session-c',
        'session-d',
        'session-e',
      ]);

      for (const [sessionId, socket] of sockets) {
        server.addConnection(new ConnectionContext(sessionId, socket as never));
      }

      const appOutboxQueue = new InMemoryQueueBox(new Map());
      const runtimeRepository = new FakeRuntimeStateRepository();
      const outboxQueueReader = new OutboxQueueReader(appOutboxQueue);
      const wake = vi.fn();
      const service = new WsQueueBoxServerService(
        new InMemoryQueueBox(new Map()),
        new InMemoryQueueBox(new Map()),
        server,
        'server-1',
      );
      const group = createGroupSnapshot('room-1', [...sockets.keys()]);
      const findGroupSnapshotByRef = vi.fn(() => Promise.resolve(group));
      initRallarSystemWsTopics(service, {
        rtcTopologyOptions: {
          rttRebuildDebounceMs: 100,
        },
        rtcTopologyManagement: createTopologyManagement(undefined, findGroupSnapshotByRef),
        rtcTopologyAppOutbox: {
          outboxQueueReader,
          ...createTopologyExecutionDependencies(runtimeRepository),
          wake,
          findGroupSnapshotByRef,
        },
      });

      clientStateSnapshotsRepository.setClientStateSnapshots(
        [...sockets.keys()].map(createClientSnapshot),
      );
      const senderSocket = sockets.get('session-a')!;

      await senderSocket.dispatchMessage(
        newALBroadcastMessage(
          'session-a',
          newALEventRoute(AppTopics.groupStateSnapshot, group.group.groupId, 'group-snapshot-1'),
          'room',
          AppTopics.groupStateSnapshot,
          group,
          {
            groupRef: group.group,
          },
        ),
      );
      expect(await appOutboxQueue.getAllKeys()).toEqual([]);
      groupStateSnapshotsRepository.removeGroupStateSnapshotByRef(group.group);

      const fullSnapshotScan = vi.spyOn(groupStateSnapshotsRepository, 'getAllGroupStateSnapshots');

      const rtt = {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 12,
        createdAtEpochMs: 1_000,
        version: 1,
      };
      await senderSocket.dispatchMessage(
        newALBroadcastMessage(
          'session-a',
          newALEventRoute(AppTopics.rtt, group.group.groupId, `rtt-${rtt.version}`),
          'room',
          AppTopics.rtt,
          rtt,
          { groupRef: group.group },
        ),
      );
      groupStateSnapshotsRepository.setGroupStateSnapshot(group);

      expect(fullSnapshotScan).not.toHaveBeenCalled();
      fullSnapshotScan.mockRestore();
      expect(wake).toHaveBeenCalled();
      expect(findGroupSnapshotByRef).toHaveBeenCalledWith({
        applicationId: group.group.applicationId,
        workspaceId: group.group.workspaceId,
        groupId: group.group.groupId,
      });
      expect(countSentTopologyMessages(sockets)).toBe(0);
      const [key] = await appOutboxQueue.getAllKeys();
      expect(key).toMatchObject({
        topicId: 'app-outbox.rtc-topology',
        resourceId: expect.stringContaining('room-1'),
      });
      const entry = await appOutboxQueue.getItem(key!);
      const message = JSON.parse(entry!.resource) as ALMessage;
      const envelope = JSON.parse(message.payload.resource) as {
        resourceId: string;
        contextId: string;
        data: {
          kind: string;
          groupSnapshot: GroupSnapshot;
          requestedRttVersion: number;
          requestOptions: object;
          publish: boolean;
        };
      };
      expect(message.route).toEqual(key);
      expect(envelope).toMatchObject({
        resourceId: expect.any(String),
        contextId: expect.stringContaining('group=room-1'),
        data: {
          kind: 'rtt-refresh',
          groupSnapshot: group,
          requestedRttVersion: rtt.version,
          requestOptions: {},
          publish: true,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeSocket {
  readonly readyState = WebSocket.OPEN;
  readonly sent: ALMessage[] = [];
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ALMessage);
  }

  async dispatchMessage(message: ALMessage): Promise<void> {
    const event = {
      data: JSON.stringify(message),
    } as MessageEvent;

    for (const listener of this.listeners.get('message') ?? []) {
      await listener(event);
    }
  }
}

function createSockets(sessionIds: readonly string[]): Map<string, FakeSocket> {
  return new Map(sessionIds.map((sessionId) => [sessionId, new FakeSocket()]));
}

function createRttHarness(
  sessionIds: readonly string[],
  options: Readonly<{
    rtcTopologyOptions?: ConstructorParameters<typeof RallarRtcTopologyService>[0];
    runtimeRepository?: FakeRuntimeStateRepository;
    enqueueRtcRttMutation?: InitRallarSystemWsTopicsOptions['enqueueRtcRttMutation'];
  }> = {},
): {
  readonly sockets: Map<string, FakeSocket>;
  readonly topologyService: RallarRtcTopologyService;
} {
  const server = new JsonWebSocketServer();
  const sockets = createSockets(sessionIds);
  for (const [sessionId, socket] of sockets) {
    server.addConnection(new ConnectionContext(sessionId, socket as never));
  }

  const service = new WsQueueBoxServerService(
    new InMemoryQueueBox(new Map()),
    new InMemoryQueueBox(new Map()),
    server,
    'server-1',
  );
  const topologyService = new RallarRtcTopologyService(options.rtcTopologyOptions);
  initRallarSystemWsTopics(service, {
    rtcTopologyService: topologyService,
    ...(options.runtimeRepository
      ? { rtcTopologyRuntimeState: { repository: options.runtimeRepository } }
      : {}),
    enqueueRtcRttMutation: options.enqueueRtcRttMutation,
  });

  return { sockets, topologyService };
}

async function dispatchRtt(
  socket: FakeSocket,
  senderId: string,
  rtt: Readonly<{
    sessionIdFrom: string;
    sessionIdTo: string;
    rttMs: number;
    createdAtEpochMs: number;
    version: number;
  }>,
  group?: GroupSnapshot,
): Promise<void> {
  await socket.dispatchMessage(
    newALBroadcastMessage(
      senderId,
      newALEventRoute(AppTopics.rtt, group?.group.groupId ?? 'room-1', `rtt-${rtt.version}`),
      'room',
      AppTopics.rtt,
      rtt,
      group ? { groupRef: group.group } : undefined,
    ),
  );
}

function countSentTopologyMessages(sockets: ReadonlyMap<string, FakeSocket>): number {
  return [...sockets.values()]
    .flatMap((socket) => socket.sent)
    .filter((sent) => sent.payload.typeId === AppTopics.overlayTopology).length;
}

function createTopologyExecutionDependencies(runtimeRepository: FakeRuntimeStateRepository) {
  return {
    database: createUnusedDatabase(),
    executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
  };
}

function createTopologyManagement(
  topologyService = new RallarRtcTopologyService(),
  findGroupSnapshotByRef: (
    ref: GroupSnapshot['group'],
  ) => GroupSnapshot | undefined | Promise<GroupSnapshot | undefined> = () => undefined,
): GroupTopologyManagementService {
  return new GroupTopologyManagementService({
    findGroupSnapshotByRef,
    topologyService,
  });
}

function createUnusedDatabase(): PSqlSql {
  const database = (() =>
    Promise.reject(new Error('Unexpected SQL execution in WS routing unit test'))) as PSqlSql;
  database.begin = () =>
    Promise.reject(new Error('Unexpected transaction in WS routing unit test'));
  return database;
}

function createCentralRttMeasurements(
  sessionIds: readonly string[],
  centralSessionId: string,
): readonly {
  readonly sessionIdFrom: string;
  readonly sessionIdTo: string;
  readonly rttMs: number;
  readonly createdAtEpochMs: number;
  readonly version: number;
}[] {
  const measurements = [];
  let version = 1;

  for (let i = 0; i < sessionIds.length; i++) {
    for (let j = i + 1; j < sessionIds.length; j++) {
      const from = sessionIds[i];
      const to = sessionIds[j];
      measurements.push({
        sessionIdFrom: from,
        sessionIdTo: to,
        rttMs: from === centralSessionId || to === centralSessionId ? 1 : 100,
        createdAtEpochMs: version,
        version: version++,
      });
    }
  }

  return measurements;
}

function audit(atEpochMs: number): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'principal', principalId: 'owner' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}

function createClientSnapshot(sessionId: string): ClientSnapshot {
  return {
    stateRevision: 1,
    principal: {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      principalId: sessionId,
      username: sessionId,
      displayName: null,
      avatarUrl: null,
      authProvider: null,
      externalSubjectId: null,
      status: 'active',
      disabled: null,
      deleted: null,
      roles: [],
      metadata: {},
      created: audit(1),
      updated: audit(1),
      lastSeenAtEpochMs: 1,
      profileVersion: 1,
      presenceVersion: 1,
      snapshotVersion: 1,
    },
    activeSessions: [
      {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: sessionId,
        sessionId,
        clientInstanceId: `${sessionId}-instance`,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        transport: 'ws',
        presenceState: 'online',
        connectionId: null,
        connectedAtEpochMs: 1,
        authenticatedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: Date.now() + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
      },
    ],
    instances: [],
    activeSessionCount: 1,
    isOnline: true,
    lastSeenAtEpochMs: 1,
  };
}

function createGroupSnapshot(groupId: string, memberSessionIds: readonly string[]): GroupSnapshot {
  const applicationId = 'app-1';
  const workspaceId = 'workspace-1';

  return {
    stateRevision: 1,
    causalRevision: {
      groupRevision: 1,
      presenceRevision: 0,
    },
    group: {
      applicationId,
      workspaceId,
      groupId,
      slug: null,
      displayName: groupId,
      description: null,
      kind: 'room',
      status: 'active',
      archived: null,
      deleted: null,
      joinMode: 'open',
      maxMembers: null,
      maxSessionsPerMember: null,
      metadata: {},
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 0,
      activeMemberCount: memberSessionIds.length,
      ownerPrincipalId: memberSessionIds[0]!,
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
      created: audit(1),
      updated: audit(1),
    },
    members: memberSessionIds.map((sessionId, index) => ({
      applicationId,
      workspaceId,
      groupId,
      principalId: sessionId,
      role: index === 0 ? 'owner' : 'member',
      status: 'active',
      invitedByPrincipalId: null,
      invitationExpiresAtEpochMs: null,
      left: null,
      removed: null,
      banned: null,
      joined: audit(1),
      updated: audit(1),
    })),
    activeSessions: memberSessionIds.map((sessionId) => ({
      applicationId,
      workspaceId,
      groupId,
      sessionId,
      principalId: sessionId,
      generationId: `generation-${sessionId}`,
      generationVersion: 1,
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: Date.now() + 60_000,
      status: 'active',
      disconnectedAtEpochMs: null,
      disconnectReason: null,
    })),
    memberCount: memberSessionIds.length,
    onlineMemberCount: memberSessionIds.length,
  };
}
