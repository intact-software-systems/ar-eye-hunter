import * as processRttRepository from '@shared/repository/rtt-repository.ts';

import { GroupTopologyConfigMutationService } from '../config/group-topology-config-mutation-service.ts';
import { GroupTopologyConfigQueryService } from '../config/group-topology-config-query-service.ts';
import type { GroupTopologyOwnersOptions } from '../group-topology-management-contracts.ts';
import {
    GroupTopologyPlanningService,
    type GroupTopologyPlanningServiceDependencies
} from '../planning/group-topology-planning-service.ts';
import { GroupTopologyReconfigureMutation } from '../reconfigure/group-topology-reconfigure-mutation.ts';

export interface GroupTopologyOwners {
    readonly query: GroupTopologyConfigQueryService;
    readonly planning: GroupTopologyPlanningService;
    readonly configMutation: GroupTopologyConfigMutationService | undefined;
    readonly reconfigureMutation: GroupTopologyReconfigureMutation | undefined;
}

export function createGroupTopologyOwners(
    options: GroupTopologyOwnersOptions
): GroupTopologyOwners {
    const query = new GroupTopologyConfigQueryService({
        findGroupSnapshotByRef: options.findGroupSnapshotByRef,
        readLocalTopologySnapshot: (group) => options.topologyService.readSnapshot(group),
        readPersistedTopologySnapshot: options.topologySnapshotRepository
            ? async (groupRef) => await options.topologySnapshotRepository?.findSnapshot(groupRef)
            : undefined,
        configRepository: options.configRepository,
        serverDefaults: options.serverDefaults
    });
    const isPlatformAdmin = (principalId: string): boolean => options.adminPrincipalIds?.has(principalId) ?? false;
    const planning = new GroupTopologyPlanningService({
        findGroupSnapshotByRef: options.findGroupSnapshotByRef,
        queryService: query,
        topologyService: options.topologyService,
        readCurrentGroupSnapshot: createTopologyPlanningSnapshotReader(options, query),
        readRttMeasurements: createTopologyPlanningRttReader(options),
        topologyMode: options.topologySnapshotRepository ? 'persistent' : 'local',
        publisher: options.publisher,
        serverDefaults: options.serverDefaults
    });
    return {
        query,
        planning,
        configMutation: options.configRepository && options.groupStateRepository
            ? new GroupTopologyConfigMutationService({
                configRepository: options.configRepository,
                groupStateRepository: options.groupStateRepository,
                serverDefaults: options.serverDefaults,
                nowEpochMs: options.now ?? (() => Date.now()),
                isPlatformAdmin
            })
            : undefined,
        reconfigureMutation: options.groupStateRepository
            ? new GroupTopologyReconfigureMutation({
                groupStateRepository: options.groupStateRepository,
                readPlanningAuthority: async (input) => await planning.readTopologyPlanningAuthority(input),
                isPlatformAdmin
            })
            : undefined
    };
}

function createTopologyPlanningSnapshotReader(
    options: GroupTopologyOwnersOptions,
    query: GroupTopologyConfigQueryService
): GroupTopologyPlanningServiceDependencies['readCurrentGroupSnapshot'] {
    const groupStateRepository = options.groupStateRepository;
    return async (groupRef, knownGroup) => {
        if (!knownGroup) {
            return await query.findCurrentGroupSnapshot(groupRef);
        }
        if (groupStateRepository) {
            return await groupStateRepository.readSnapshot(groupRef);
        }
        return (
            (await options.findGroupSnapshotByRef(groupRef, {
                minCausalRevision: knownGroup.causalRevision
            })) ?? (await options.findGroupSnapshotByRef(groupRef))
        );
    };
}

function createTopologyPlanningRttReader(
    options: GroupTopologyOwnersOptions
): GroupTopologyPlanningServiceDependencies['readRttMeasurements'] {
    const rttRepository = options.rttRepository;
    if (rttRepository) {
        return async (group) =>
            await rttRepository.listMeasurementsForSessionIds(
                group.activeSessions.map((session) => session.sessionId)
            );
    }
    return () => options.processRttReader?.() ?? processRttRepository.getAllRtt();
}
