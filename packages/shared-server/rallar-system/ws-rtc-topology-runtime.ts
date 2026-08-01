import type { GroupStateRepository } from './group-state/persistence/group-state-repository.ts';
import type { GroupTopologyConfigRepository } from './repositories/GroupTopologyConfigRepository.ts';
import type { RtcRttRepository } from './repositories/RtcRttRepository.ts';
import type { RtcTopologySnapshotRepository } from './repositories/RtcTopologySnapshotRepository.ts';

export type RtcTopologyRuntimeState = Readonly<{
  topologyConfig: GroupTopologyConfigRepository;
  groupState: GroupStateRepository;
  topologySnapshots: RtcTopologySnapshotRepository;
  rtts: RtcRttRepository;
}>;
