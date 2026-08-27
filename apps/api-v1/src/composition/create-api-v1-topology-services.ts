import * as vivaldiService from '@shared-graph/vivaldi-service.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type {
    CachedGroupStateService
} from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import type { GroupFormationRttMutationSink } from '@shared-server/rallar-system/observability/formation-metrics.ts';
import type { RtcRttAppInboxDependencies } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-app-inbox-contracts.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import {
    RtcRttRefinementGate,
    type RtcRttRefinementGateConfig
} from '@shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-gate.ts';
import { RtcRttRefinementService } from '@shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import type { GroupTopologyConfigMutationService } from '@shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts';
import type { GroupTopologyConfigQueryService } from '@shared-server/rallar-system/topology/config/group-topology-config-query-service.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import type { TopologyAppInboxMutationOwners } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import {
    createGroupTopologyMutationOwners
} from '@shared-server/rallar-system/topology/mutation/create-group-topology-mutation-owners.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import type { GroupTopologyPlanningService } from '@shared-server/rallar-system/topology/planning/group-topology-planning-service.ts';
import type { GroupTopologyReconfigureMutation } from '@shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-mutation.ts';
import {
    readPendingTopologyReplan
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import {
    createGroupTopologyRuntimeOwners
} from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyServiceOptions
} from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { createApiRtcTopologyAdminMetrics } from '../runtime/rtc-topology/create-api-rtc-topology-admin-metrics.ts';

export interface ApiV1TopologyReplayMetrics {
    readMetrics(): object;
    resetMetrics(): void;
}

export interface CreateApiV1TopologyServicesInput {
    readonly database: PSqlSql;
    readonly runtimeStateRepository: RuntimeStateRepositoryLike;
    readonly groupStateRepository: GroupStateRepository;
    readonly groupStateService: Pick<CachedGroupStateService, 'readSnapshotAtLeast'>;
    readonly groupFormationRttMutation: GroupFormationRttMutationSink;
    readonly topologyOutboxWritten: () => void;
    readonly topologyReplayMetrics: ApiV1TopologyReplayMetrics;
    readonly adminClientIds: readonly string[];
    readonly rtcTopologyOptions: RallarRtcTopologyServiceOptions;
    readonly rttRefinementGateConfig: RtcRttRefinementGateConfig;
    readonly nowEpochMs: () => number;
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
    const groupStateRepository = input.groupStateRepository;
    const topologySnapshotRepository = new RtcTopologySnapshotRepository(
        input.runtimeStateRepository
    );
    const acceptedTopologySnapshotRepository = new RtcTopologySnapshotRepository(
        input.runtimeStateRepository,
        RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE
    );
    const pendingReplanReader = new PSqlResourceInboxEntryRepository(input.database);
    const rttRepository = new RtcRttRepository(input.runtimeStateRepository, {
        now: nowEpochMs
    });
    const outboxWriter = new RtcTopologyOutboxWriter({
        recordWrite: input.topologyOutboxWritten
    });
    const topologyRuntimeOwners = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: (ref, cacheOptions) =>
            input.groupStateService.readSnapshotAtLeast(ref, cacheOptions ?? {}),
        readCurrentGroupSnapshot: async (ref) => await groupStateRepository.readSnapshot(ref),
        readRttMeasurements: async (group) =>
            await rttRepository.listMeasurementsForSessionIds(
                group.activeSessions.map((session) => session.sessionId)
            ),
        configRepository: topologyConfigRepository,
        topologyService: rtcTopologyService,
        topologySnapshotRepository,
        acceptedTopologySnapshotRepository,
        readPendingTopologyReplan: async (groupRef) => await readPendingTopologyReplan(pendingReplanReader, groupRef),
        readTopologyReplanningMode: async (group) => {
            const read = await groupStateRepository.readLifecyclePolicy(group.group);
            if (read.status === 'corrupt') {
                return 'corrupt';
            }
            return read.status === 'present'
                ? read.policy.topology.replanning
                : createDefaultGroupLifecyclePolicy().topology.replanning;
        },
        serverDefaults: {
            ...rtcTopologyOptions,
            topologyKind: rtcTopologyOptions.topologyKind ?? 'auto'
        }
    });
    const topologyMutationOwners = createGroupTopologyMutationOwners({
        groupStateRepository,
        configRepository: topologyConfigRepository,
        planning: topologyRuntimeOwners.planning,
        serverDefaults: {
            ...rtcTopologyOptions,
            topologyKind: rtcTopologyOptions.topologyKind ?? 'auto'
        },
        nowEpochMs,
        isPlatformAdmin: (principalId) => input.adminClientIds.includes(principalId),
        outboxWriter
    });
    const topologyConfigMutation = topologyMutationOwners.configMutation;
    const topologyReconfigureMutation = topologyMutationOwners.reconfigureMutation;
    const rtcRttMutationDependencies: RtcRttAppInboxDependencies = {
        repository: rttRepository,
        outboxWriter,
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
            // Acceptance judges pair liveness durably: AppInbox executes RTT
            // submits on any cluster server, and a server-local cache can lag
            // the joins it is judging, permanently rejecting valid evidence.
            const candidateGroups = (
                await Promise.all(
                    groupRefs.map((ref) => groupStateRepository.readSnapshot(ref))
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
                    const config = await topologyRuntimeOwners.query.readConfig(group.group);
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
        topologyQuery: topologyRuntimeOwners.query,
        topologyPlanning: topologyRuntimeOwners.planning,
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
