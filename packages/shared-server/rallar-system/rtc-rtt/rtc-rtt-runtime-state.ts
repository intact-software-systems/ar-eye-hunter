import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import type { GroupTopologyConfigRepository } from '../topology/config/persistence/group-topology-config-repository.ts';
import type { RtcTopologySnapshotRepository } from '../topology/persistence/rtc-topology-snapshot-repository.ts';
import type { RtcRttRepository } from './persistence/rtc-rtt-repository.ts';

export type RtcRttRuntimeState = Readonly<{
    topologyConfig: GroupTopologyConfigRepository;
    groupState: GroupStateRepository;
    topologySnapshots: RtcTopologySnapshotRepository;
    rtts: RtcRttRepository;
}>;
