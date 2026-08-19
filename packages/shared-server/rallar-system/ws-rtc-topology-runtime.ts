import type { GroupStateRepository } from './group-state/persistence/group-state-repository.ts';
import type { GroupTopologyConfigRepository } from './topology/config/persistence/group-topology-config-repository.ts';
import type { RtcRttRepository } from './rtc-topology/persistence/rtc-rtt-repository.ts';
import type { RtcTopologySnapshotRepository } from './repositories/RtcTopologySnapshotRepository.ts';

export type RtcTopologyRuntimeState = Readonly<{
  topologyConfig: GroupTopologyConfigRepository;
  groupState: GroupStateRepository;
  topologySnapshots: RtcTopologySnapshotRepository;
  rtts: RtcRttRepository;
}>;
