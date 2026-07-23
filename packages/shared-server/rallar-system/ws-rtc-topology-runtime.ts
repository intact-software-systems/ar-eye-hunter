import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { RuntimeStateRepositoryLike } from '../runtime-state/RuntimeStateRepository.ts';
import { GroupStateRepository } from './repositories/GroupStateRepository.ts';
import { GroupTopologyConfigRepository } from './repositories/GroupTopologyConfigRepository.ts';
import { RtcRttRepository, type RtcRttRepositoryOptions } from './repositories/RtcRttRepository.ts';
import { RtcTopologySnapshotRepository } from './repositories/RtcTopologySnapshotRepository.ts';
import { GroupTopologyManagementService } from './services/group-topology-management-service.ts';
import { sendStateSyncMessage } from './state-sync-routing.ts';

export type RtcTopologyRuntimeState = Readonly<{
  topologyConfig: GroupTopologyConfigRepository;
  groupState: GroupStateRepository;
  topologySnapshots: RtcTopologySnapshotRepository;
  rtts: RtcRttRepository;
}>;

export type ProcessLocalRtcTopology = Readonly<{
  publish(group: GroupSnapshot, server: JsonWebSocketServer): Promise<void>;
  flushDue(group: GroupSnapshot, server: JsonWebSocketServer): Promise<boolean>;
  remove(group: GroupSnapshot): Promise<void>;
}>;

export function createRtcTopologyRuntimeState(
  repository: RuntimeStateRepositoryLike,
  rttOptions: RtcRttRepositoryOptions,
): RtcTopologyRuntimeState {
  return {
    topologyConfig: new GroupTopologyConfigRepository(repository),
    groupState: new GroupStateRepository(repository),
    topologySnapshots: new RtcTopologySnapshotRepository(repository),
    rtts: new RtcRttRepository(repository, rttOptions),
  };
}

export function createRtcTopologyManagement(
  options: ConstructorParameters<typeof GroupTopologyManagementService>[0],
): GroupTopologyManagementService {
  return new GroupTopologyManagementService(options);
}

export function createProcessLocalRtcTopology(
  topologyManagement: GroupTopologyManagementService,
): ProcessLocalRtcTopology {
  return {
    publish: async (group, server) => {
      await topologyManagement.reconfigureGroupTopology({
        groupRef: group.group,
        groupSnapshot: group,
        publisher: (message) => {
          sendStateSyncMessage(server, message);
        },
      });
    },
    flushDue: async (group, server) => {
      const result = await topologyManagement.flushDueGroupTopology({
        groupRef: group.group,
        groupSnapshot: group,
        publisher: (message) => {
          sendStateSyncMessage(server, message);
        },
      });
      return result?.changed ?? false;
    },
    remove: async (group) => {
      await topologyManagement.removeGroupTopology(group);
    },
  };
}
