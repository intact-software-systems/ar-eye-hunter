import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { GroupTopologyConfigQueryService } from '../config/group-topology-config-query-service.ts';
import type { GroupTopologyServerOptions } from '../config/group-topology-config.ts';
import type { GroupTopologyConfigRepository } from '../config/persistence/group-topology-config-repository.ts';
import type { RtcTopologySnapshotRepository } from '../persistence/rtc-topology-snapshot-repository.ts';
import type {
    GroupTopologyGroupSnapshotReader,
    GroupTopologyPublisher
} from '../planning/group-topology-planning-contracts.ts';
import {
    GroupTopologyPlanningService,
    type GroupTopologyPlanningServiceDependencies
} from '../planning/group-topology-planning-service.ts';
import type { RallarRtcTopologyService } from './rallar-rtc-topology-service.ts';

export interface CreateGroupTopologyRuntimeOwnersInput {
    readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    readonly readCurrentGroupSnapshot: (
        groupRef: GroupRef,
        knownGroup: GroupSnapshot | undefined
    ) => Promise<GroupSnapshot | undefined>;
    readonly readRttMeasurements: (
        group: GroupSnapshot
    ) => readonly RttMeasurementInfo[] | Promise<readonly RttMeasurementInfo[]>;
    readonly configRepository?: GroupTopologyConfigRepository;
    readonly topologyService: RallarRtcTopologyService;
    readonly topologySnapshotRepository?: RtcTopologySnapshotRepository;
    readonly publisher?: GroupTopologyPublisher;
    readonly serverDefaults?: GroupTopologyServerOptions;
}

export interface GroupTopologyRuntimeOwners {
    readonly query: GroupTopologyConfigQueryService;
    readonly planning: GroupTopologyPlanningService;
}

export function createGroupTopologyRuntimeOwners(
    input: CreateGroupTopologyRuntimeOwnersInput
): GroupTopologyRuntimeOwners {
    const topologySnapshotRepository = input.topologySnapshotRepository;
    const query = new GroupTopologyConfigQueryService({
        findGroupSnapshotByRef: input.findGroupSnapshotByRef,
        readLocalTopologySnapshot: (group) => input.topologyService.readSnapshot(group),
        readPersistedTopologySnapshot: topologySnapshotRepository
            ? async (groupRef) => await topologySnapshotRepository.findSnapshot(groupRef)
            : undefined,
        configRepository: input.configRepository,
        serverDefaults: input.serverDefaults
    });
    const planningDependencies: GroupTopologyPlanningServiceDependencies = {
        findGroupSnapshotByRef: input.findGroupSnapshotByRef,
        queryService: query,
        topologyService: input.topologyService,
        readCurrentGroupSnapshot: input.readCurrentGroupSnapshot,
        readRttMeasurements: input.readRttMeasurements,
        topologyMode: topologySnapshotRepository ? 'persistent' : 'local',
        publisher: input.publisher,
        serverDefaults: input.serverDefaults
    };
    return {
        query,
        planning: new GroupTopologyPlanningService(planningDependencies)
    };
}
