import type { GroupStateRepository } from './group-state/persistence/group-state-repository.ts';
// prettier-ignore
import type { GroupTopologyConfigRepository }
  from './topology/config/persistence/group-topology-config-repository.ts';
import type { RtcRttRepository } from './repositories/RtcRttRepository.ts';
import type { RtcTopologySnapshotRepository } from './repositories/RtcTopologySnapshotRepository.ts';

export type RtcTopologyRuntimeState = Readonly<{
  topologyConfig: GroupTopologyConfigRepository;
  groupState: GroupStateRepository;
  topologySnapshots: RtcTopologySnapshotRepository;
  rtts: RtcRttRepository;
}>;
