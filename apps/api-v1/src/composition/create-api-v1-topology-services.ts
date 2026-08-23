import * as vivaldiService from '@shared-graph/vivaldi-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type {
    CachedGroupStateService
} from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import type { GroupFormationRttMutationSink } from '@shared-server/rallar-system/observability/formation-metrics.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { RtcRttAppInboxDependencies } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-app-inbox-contracts.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import {
    RtcRttRefinementGate,
    type RtcRttRefinementGateConfig
} from '@shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-gate.ts';
import { RtcRttRefinementService } from '@shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import { sendStateSyncMessage } from '@shared-server/rallar-system/state-sync/state-sync-websocket-publication.ts';
import type { GroupTopologyConfigMutationService } from '@shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts';
import type { GroupTopologyConfigQueryService } from '@shared-server/rallar-system/topology/config/group-topology-config-query-service.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import type { TopologyAppInboxMutationOwners } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import type { GroupTopologyPlanningService } from '@shared-server/rallar-system/topology/planning/group-topology-planning-service.ts';
import type { GroupTopologyReconfigureMutation } from '@shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-mutation.ts';
import {
    createGroupTopologyOwners
} from '@shared-server/rallar-system/topology/runtime/create-group-topology-owners.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyServiceOptions
} from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import { createApiRtcTopologyAdminMetrics } from '../runtime/rtc-topology/create-api-rtc-topology-admin-metrics.ts';

export interface ApiV1TopologyReplayMetrics {
    readMetrics(): object;
    resetMetrics(): void;
}

export interface CreateApiV1TopologyServicesInput {
    readonly runtimeStateRepository: RuntimeStateRepositoryLike;
    readonly groupStateService: Pick<CachedGroupStateService, 'readSnapshotAtLeast'>;
    readonly groupFormationRttMutation: GroupFormationRttMutationSink;
    readonly webSocketServer: JsonWebSocketServer;
    readonly topologyReplayMetrics: ApiV1TopologyReplayMetrics;
    readonly serviceId: string;
    readonly adminClientIds: readonly string[];
    readonly rtcTopologyOptions: RallarRtcTopologyServiceOptions;
    readonly rttRefinementGateConfig: RtcRttRefinementGateConfig;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
}

export interface ApiV1TopologyServices {
    readonly rtcTopologyService: RallarRtcTopologyService;
    readonly rtcTopologyOptions: RallarRtcTopologyServiceOptions;
    readonly topologyQuery: GroupTopologyConfigQueryService;
    readonly topologyPlanning: GroupTopologyPlanningService;
    readonly topologyConfigMutation: GroupTopologyConfigMutationService;
    readonly topologyReconfigureMutation: GroupTopologyReconfigureMutation;
    readonly topologyMutationOwners: TopologyAppInboxMutationOwners;
    readonly rtcRttMutationDependencies: RtcRttAppInboxDependencies;
    readonly topologyConfigRepository: GroupTopologyConfigRepository;
    readonly groupStateRepository: GroupStateRepository;
    readonly topologySnapshotRepository: RtcTopologySnapshotRepository;
    readonly rttRepository: RtcRttRepository;
    readonly rttRefinementGate: RtcRttRefinementGate;
    readonly rttRefinementService: RtcRttRefinementService;
    readonly adminClientIds: readonly string[];
    readonly readRtcTopologyMetrics: () => object;
    readonly resetRtcTopologyMetrics: () => void;
}

export function createApiV1TopologyServices(
    input: CreateApiV1TopologyServicesInput
): ApiV1TopologyServices {
    const nowEpochMs = input.rtcTopologyOptions.now ?? input.nowEpochMs;
    const rtcTopologyOptions = {
        ...input.rtcTopologyOptions,
        now: nowEpochMs
    };
    const rtcTopologyService = new RallarRtcTopologyService(rtcTopologyOptions);
    const rttRefinementGate = new RtcRttRefinementGate(input.rttRefinementGateConfig);
    const rttRefinementService = new RtcRttRefinementService({
        gate: rttRefinementGate,
        nowEpochMs,
        observeRtt: vivaldiService.observeRtt,
        readPredictedNodeData: vivaldiService.readablePredictedNodeData
    });
    const topologyConfigRepository = new GroupTopologyConfigRepository(
        input.runtimeStateRepository
    );
    const groupStateRepository = new GroupStateRepository(input.runtimeStateRepository);
    const topologySnapshotRepository = new RtcTopologySnapshotRepository(
        input.runtimeStateRepository
    );
    const rttRepository = new RtcRttRepository(input.runtimeStateRepository, {
        now: nowEpochMs
    });
    const topologyOwners = createGroupTopologyOwners({
        findGroupSnapshotByRef: (ref, cacheOptions) =>
            input.groupStateService.readSnapshotAtLeast(ref, cacheOptions ?? {}),
        groupStateRepository,
        configRepository: topologyConfigRepository,
        topologyService: rtcTopologyService,
        topologySnapshotRepository,
        rttRepository,
        publisher: (message) => {
            sendStateSyncMessage(input.webSocketServer, message);
        },
        serverDefaults: {
            ...rtcTopologyOptions,
            topologyKind: rtcTopologyOptions.topologyKind ?? 'auto'
        },
        now: nowEpochMs,
        timing: input.timing,
        serviceId: input.serviceId,
        adminPrincipalIds: new Set(input.adminClientIds)
    });

    const topologyConfigMutation = requireOwner(
        topologyOwners.configMutation,
        'Topology config mutation'
    );
    const topologyReconfigureMutation = requireOwner(
        topologyOwners.reconfigureMutation,
        'Topology reconfigure mutation'
    );
    const rtcRttMutationDependencies: RtcRttAppInboxDependencies = {
        repository: rttRepository,
        formationMetrics: input.groupFormationRttMutation,
        readPolicyInputs: async (command) => {
            const sessionsByGroupKey = await readActiveSessionsByGroup(
                groupStateRepository,
                nowEpochMs()
            );
            const groupRefs = [...sessionsByGroupKey.values()]
                .filter(({ sessionIds }) =>
                    sessionIds.has(command.rtt.sessionIdFrom) &&
                    sessionIds.has(command.rtt.sessionIdTo)
                )
                .map(({ ref }) => ref);
            const candidateGroups = (
                await Promise.all(
                    groupRefs.map((ref) => input.groupStateService.readSnapshotAtLeast(ref, {}))
                )
            ).filter((snapshot) => snapshot !== undefined);
            const overlaySnapshotsByGroupKey = new Map<string, RallarOverlayTopologySnapshot>();
            for (const group of candidateGroups) {
                const snapshot = await topologySnapshotRepository.findSnapshot(group.group);
                if (snapshot) {
                    overlaySnapshotsByGroupKey.set(toWebRtcGroupKey(group.group), snapshot);
                }
            }
            // Acceptance must resolve the limit exactly as the read-side planning
            // filter does (per-group effective config under the server reporting
            // default), or evidence a raised per-group limit plans for is never
            // stored and readiness can never cover the plan.
            const groupDegreeLimits = await Promise.all(
                candidateGroups.map(async (group) => {
                    const config = await topologyOwners.query.readConfig(group.group);
                    return rtcTopologyService.readRttReportingDegreeLimit({
                        ...config.effective,
                        rttReportingDegreeLimit: rtcTopologyOptions.rttReportingDegreeLimit
                    });
                })
            );
            return {
                candidateGroups,
                overlaySnapshotsByGroupKey,
                degreeLimit: groupDegreeLimits.length > 0
                    ? Math.max(...groupDegreeLimits)
                    : rtcTopologyService.readRttReportingDegreeLimit()
            };
        }
    };

    const adminMetrics = createApiRtcTopologyAdminMetrics({
        planning: rtcTopologyService,
        replay: input.topologyReplayMetrics
    });
    return {
        rtcTopologyService,
        rtcTopologyOptions,
        topologyQuery: topologyOwners.query,
        topologyPlanning: topologyOwners.planning,
        topologyConfigMutation,
        topologyReconfigureMutation,
        topologyMutationOwners: {
            configMutationService: topologyConfigMutation,
            reconfigureMutation: topologyReconfigureMutation
        },
        rtcRttMutationDependencies,
        topologyConfigRepository,
        groupStateRepository,
        topologySnapshotRepository,
        rttRepository,
        rttRefinementGate,
        rttRefinementService,
        adminClientIds: input.adminClientIds,
        readRtcTopologyMetrics: adminMetrics.read,
        resetRtcTopologyMetrics: adminMetrics.reset
    };
}

function requireOwner<T>(owner: T | undefined, label: string): T {
    if (!owner) {
        throw new TypeError(`${label} owner is required`);
    }
    return owner;
}

async function readActiveSessionsByGroup(
    repository: GroupStateRepository,
    nowEpochMs: number
): Promise<ReadonlyMap<string, Readonly<{ ref: GroupRef; sessionIds: Set<string>; }>>> {
    const sessionsByGroupKey = new Map<string, Readonly<{ ref: GroupRef; sessionIds: Set<string>; }>>();
    for (const session of await repository.listAllPresenceSessions()) {
        if (session.status !== 'active' || session.expiresAtEpochMs <= nowEpochMs) {
            continue;
        }
        const key = toWebRtcGroupKey(session);
        const current = sessionsByGroupKey.get(key) ?? {
            ref: {
                applicationId: session.applicationId,
                workspaceId: session.workspaceId,
                groupId: session.groupId
            },
            sessionIds: new Set<string>()
        };
        current.sessionIds.add(session.sessionId);
        sessionsByGroupKey.set(key, current);
    }
    return sessionsByGroupKey;
}
