import { ReconfigAlgo } from '@shared-graph/algo-props.ts';
import type { WeightedGraph } from '@shared-graph/graph-props.ts';
import { createGroupMesh, type GlobalMeshArgs } from '@shared-graph/graphs-mesh-service.ts';
import { createGroupTree } from '@shared-graph/graphs-tree-service.ts';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { insertToMesh } from '@shared-graph/mesh/insert-mesh-algs.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupTopologyKindSetting } from '@shared/api/graph-topology-management-types.ts';
import { readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';
import { normalizeRttReportingDegreeLimit } from '@shared/rtc/rtt-reporting-policy.ts';

import type {
    RallarRtcTopologyServiceOptions,
    RallarRtcTopologyUpdateOptions,
    RallarRtcTopologyUpdateResult,
    RtcTopologyKindHysteresisWidths,
    RtcTopologyPlanningIntent
} from '../runtime/rallar-rtc-topology-service.ts';
import type { RtcTopologyMetrics } from '../runtime/rtc-topology-metrics.ts';
import { toCanonicalTopologySessionIds } from './canonical-topology-planning-input.ts';
import { computeNoRttTopologyNextHops } from './compute-no-rtt-topology-next-hops.ts';
import { createRtcRoomGraph, materializeSparseRtcRoomGraphFallback } from './create-rtc-room-graph.ts';
import { computeEvolvedTopologyNextHops } from './evolve-planned-topology.ts';
import { planRallarRtcTopologySnapshot } from './plan-rallar-rtc-topology-snapshot.ts';
import {
    DEFAULT_MESH_EXIT_WIDTH,
    DEFAULT_TREE_EXIT_WIDTH,
    resolveTopologyKindWithHysteresis
} from './topology-kind-hysteresis.ts';

const DEFAULT_DEGREE_LIMIT = 5;
const DEFAULT_TREE_MIN_SIZE = 5;
const DEFAULT_MESH_MIN_SIZE = 16;
const DEFAULT_MESH_PARAM_K = 2;

interface RtcTopologyPlanInput {
    readonly group: GroupSnapshot;
    readonly activeSessionIds: readonly string[];
    readonly relevantRttMeasurements: readonly RttMeasurementInfo[];
    readonly topology: RallarRtcTopologyKind;
    readonly previous: RallarOverlayTopologySnapshot | undefined;
    readonly topologyOptions: RallarRtcTopologyServiceOptions;
    readonly planningIntent: RtcTopologyPlanningIntent;
}

interface CreateWeightedTopologyNextHopsInput {
    readonly topology: RallarRtcTopologyKind;
    readonly group: GroupSnapshot;
    readonly activeSessionIds: readonly string[];
    readonly globalGraph: WeightedGraph;
    readonly options: RallarRtcTopologyServiceOptions;
}

interface CreateMeasuredRoomGraphInput {
    readonly group: GroupSnapshot;
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly topology: RallarRtcTopologyKind;
    readonly options: RallarRtcTopologyServiceOptions;
}

export namespace RtcTopologyPlanner {
    export interface Dependencies {
        readonly metrics: RtcTopologyMetrics;
        readonly durationNowMs: () => number;
    }

    export interface PlanInput {
        readonly group: GroupSnapshot;
        readonly rttMeasurements: readonly RttMeasurementInfo[];
        readonly previous: RallarOverlayTopologySnapshot | undefined;
        readonly updateOptions: RallarRtcTopologyUpdateOptions;
        readonly nowEpochMs: number;
    }

    export interface ActivePlanningInput {
        readonly activeSessionIds: readonly string[];
        readonly relevantRttMeasurements: readonly RttMeasurementInfo[];
    }

    export interface PreparedPlanInput extends ActivePlanningInput {
        readonly group: GroupSnapshot;
        readonly previous: RallarOverlayTopologySnapshot | undefined;
        readonly updateOptions: RallarRtcTopologyUpdateOptions;
        readonly nowEpochMs: number;
    }

    export interface PublicDispatch {
        selectTopology(
            group: GroupSnapshot,
            options: RallarRtcTopologyServiceOptions,
            previousKind?: RallarRtcTopologyKind
        ): RallarRtcTopologyKind;
        readRttReportingDegreeLimit(options: RallarRtcTopologyServiceOptions): number;
    }
}

export class RtcTopologyPlanner {
    private readonly serviceOptions: RallarRtcTopologyServiceOptions;
    private readonly dependencies: RtcTopologyPlanner.Dependencies;

    constructor(
        serviceOptions: RallarRtcTopologyServiceOptions,
        dependencies: RtcTopologyPlanner.Dependencies
    ) {
        this.serviceOptions = serviceOptions;
        this.dependencies = dependencies;
    }

    plan(
        input: RtcTopologyPlanner.PlanInput,
        publicDispatch: RtcTopologyPlanner.PublicDispatch = this
    ): RallarRtcTopologyUpdateResult {
        return this.planPrepared(
            {
                ...input,
                ...this.createActivePlanningInput(input.group, input.rttMeasurements)
            },
            publicDispatch
        );
    }

    createActivePlanningInput(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[]
    ): RtcTopologyPlanner.ActivePlanningInput {
        const activeSessionIds = toCanonicalTopologySessionIds(readGroupMemberSessionIds(group));
        const relevantRttMeasurements = filterRttMeasurementsForActiveSessions(
            rttMeasurements,
            activeSessionIds
        );
        this.dependencies.metrics.recordTopologyRttMeasurementCount(relevantRttMeasurements.length);
        return { activeSessionIds, relevantRttMeasurements };
    }

    planPrepared(
        input: RtcTopologyPlanner.PreparedPlanInput,
        publicDispatch: RtcTopologyPlanner.PublicDispatch = this
    ): RallarRtcTopologyUpdateResult {
        const topologyOptions = this.readTopologyOptions(input.updateOptions);
        const topology = this.selectPlanTopology(
            input.group,
            topologyOptions,
            input.previous,
            publicDispatch
        );
        const degreeLimit = this.readDegreeLimit(topologyOptions);
        const nextHopsBySessionId = this.computePlannedNextHops(
            {
                group: input.group,
                activeSessionIds: input.activeSessionIds,
                relevantRttMeasurements: input.relevantRttMeasurements,
                topology,
                previous: input.previous,
                topologyOptions,
                planningIntent: input.updateOptions.planningIntent ?? 'full-rebuild'
            },
            publicDispatch
        );
        const result = planRallarRtcTopologySnapshot({
            group: input.group,
            previous: input.previous,
            topology,
            nextHopsBySessionId,
            degreeLimit,
            nowEpochMs: input.nowEpochMs
        });
        this.dependencies.metrics.recordTopologyResult(result.changed);
        return result;
    }

    createRoomGraph(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[],
        publicDispatch: RtcTopologyPlanner.PublicDispatch = this
    ): WeightedGraph {
        const topology = publicDispatch.selectTopology(group, this.serviceOptions);
        return this.createMeasuredRoomGraph(
            {
                group,
                rttMeasurements,
                topology,
                options: this.serviceOptions
            },
            publicDispatch
        );
    }

    selectTopology(
        group: GroupSnapshot,
        options: RallarRtcTopologyServiceOptions,
        previousKind?: RallarRtcTopologyKind
    ): RallarRtcTopologyKind {
        if (isExplicitTopologyKind(options.topologyKind)) {
            return options.topologyKind;
        }
        return resolveTopologyKindWithHysteresis({
            activeSize: new Set(readGroupMemberSessionIds(group)).size,
            treeMinSize: this.readTreeMinSize(options),
            meshMinSize: this.readMeshMinSize(options),
            meshExitWidth: this.readKindHysteresisWidths().meshExitWidth,
            treeExitWidth: this.readKindHysteresisWidths().treeExitWidth,
            previousKind
        });
    }

    readRttReportingDegreeLimit(options: RallarRtcTopologyServiceOptions): number {
        return normalizeRttReportingDegreeLimit(
            options.rttReportingDegreeLimit,
            this.readDegreeLimit(options)
        );
    }

    readKindHysteresisWidths(): RtcTopologyKindHysteresisWidths {
        return {
            meshExitWidth: Math.max(0, this.serviceOptions.meshExitWidth ?? DEFAULT_MESH_EXIT_WIDTH),
            treeExitWidth: Math.max(0, this.serviceOptions.treeExitWidth ?? DEFAULT_TREE_EXIT_WIDTH)
        };
    }

    private selectPlanTopology(
        group: GroupSnapshot,
        topologyOptions: RallarRtcTopologyServiceOptions,
        previous: RallarOverlayTopologySnapshot | undefined,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): RallarRtcTopologyKind {
        const previousKind = previous?.state === 'active' ? previous.topology : undefined;
        const topology = publicDispatch.selectTopology(group, topologyOptions, previousKind);
        if (
            previousKind !== undefined &&
            topology === previousKind &&
            publicDispatch.selectTopology(group, topologyOptions) !== topology
        ) {
            this.dependencies.metrics.recordHysteresisHold();
        }
        return topology;
    }

    private computePlannedNextHops(
        plan: RtcTopologyPlanInput,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): Record<string, readonly string[]> {
        if (plan.topology === 'star') {
            return this.computeStarNextHops(plan);
        }
        const evolved = this.computeEvolvedNextHops(plan, publicDispatch);
        if (evolved !== undefined) {
            return evolved;
        }
        if (plan.relevantRttMeasurements.length === 0) {
            return this.computeNoRttNextHops(plan);
        }
        return this.createNextHopMap({
            topology: plan.topology,
            group: plan.group,
            activeSessionIds: plan.activeSessionIds,
            globalGraph: this.createMeasuredRoomGraph(
                {
                    group: plan.group,
                    rttMeasurements: plan.relevantRttMeasurements,
                    topology: plan.topology,
                    options: plan.topologyOptions
                },
                publicDispatch
            ),
            options: plan.topologyOptions
        });
    }

    private computeStarNextHops(plan: RtcTopologyPlanInput): Record<string, readonly string[]> {
        const startedAtMs = this.dependencies.durationNowMs();
        const nextHopsBySessionId = computeNoRttTopologyNextHops({
            topology: plan.topology,
            activeSessionIds: plan.activeSessionIds,
            degreeLimit: this.readDegreeLimit(plan.topologyOptions),
            meshParamK: this.readMeshArgs(plan.topologyOptions).meshParamK
        });
        this.dependencies.metrics.recordStarPlan(this.dependencies.durationNowMs() - startedAtMs);
        return nextHopsBySessionId;
    }

    private computeEvolvedNextHops(
        plan: RtcTopologyPlanInput,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): Record<string, readonly string[]> | undefined {
        if (
            plan.planningIntent !== 'membership-delta' ||
            plan.previous?.state !== 'active' ||
            plan.previous.topology !== plan.topology ||
            (plan.topology !== 'tree' && plan.topology !== 'mesh')
        ) {
            return undefined;
        }
        const evolved = computeEvolvedTopologyNextHops({
            previous: plan.previous,
            group: plan.group,
            activeSessionIds: plan.activeSessionIds,
            globalGraph: this.createMeasuredRoomGraph(
                {
                    group: plan.group,
                    rttMeasurements: plan.relevantRttMeasurements,
                    topology: plan.topology,
                    options: plan.topologyOptions
                },
                publicDispatch
            ),
            kind: plan.topology,
            degreeLimit: this.readDegreeLimit(plan.topologyOptions),
            meshParamK: this.readMeshArgs(plan.topologyOptions).meshParamK
        });
        if (evolved.outcome === 'full-rebuild') {
            this.dependencies.metrics.recordIncrementalFallback(evolved.reason);
            return undefined;
        }
        this.dependencies.metrics.recordIncrementalPlan();
        return evolved.nextHopsBySessionId;
    }

    private computeNoRttNextHops(plan: RtcTopologyPlanInput): Record<string, readonly string[]> {
        const startedAtMs = this.dependencies.durationNowMs();
        const nextHopsBySessionId = computeNoRttTopologyNextHops({
            topology: plan.topology,
            activeSessionIds: plan.activeSessionIds,
            degreeLimit: this.readDegreeLimit(plan.topologyOptions),
            meshParamK: this.readMeshArgs(plan.topologyOptions).meshParamK
        });
        const durationMs = this.dependencies.durationNowMs() - startedAtMs;
        if (plan.topology === 'tree') {
            this.dependencies.metrics.recordNoRttTreePlan(durationMs);
        }
        else {
            this.dependencies.metrics.recordNoRttMeshPlan(durationMs);
        }
        return nextHopsBySessionId;
    }

    private createMeasuredRoomGraph(
        input: CreateMeasuredRoomGraphInput,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): WeightedGraph {
        const startedAtMs = this.dependencies.durationNowMs();
        this.dependencies.metrics.recordWeightedRoomGraphAttempt();
        const activeSessionIds = toCanonicalTopologySessionIds(readGroupMemberSessionIds(input.group));
        const result = createRtcRoomGraph({
            group: input.group,
            activeSessionIds,
            rttMeasurements: input.rttMeasurements,
            degreeLimit: this.readDegreeLimit(input.options),
            rttReportingDegreeLimit: publicDispatch.readRttReportingDegreeLimit(input.options),
            seedTopology: input.topology,
            meshParamK: this.readMeshArgs(input.options).meshParamK
        });
        if (result.outcome === 'sparse-fallback') {
            this.dependencies.metrics.recordWeightedRoomGraphSparseFallback();
        }
        this.dependencies.metrics.recordWeightedRoomGraphDuration(
            this.dependencies.durationNowMs() - startedAtMs
        );
        return result.outcome === 'ready'
            ? result.graph
            : materializeSparseRtcRoomGraphFallback(result);
    }

    private createNextHopMap(
        input: CreateWeightedTopologyNextHopsInput
    ): Record<string, readonly string[]> {
        const startedAtMs = this.dependencies.durationNowMs();
        this.dependencies.metrics.recordWeightedPlanAttempt();
        const graph = input.topology === 'tree'
            ? createGroupTree({
                group: input.group,
                globalGraph: input.globalGraph,
                maxDegree: this.readDegreeLimit(input.options)
            }).tree
            : createGroupMesh({
                group: input.group,
                globalGraph: input.globalGraph,
                maxDegree: this.readDegreeLimit(input.options),
                globalArgs: this.readMeshArgs(input.options),
                deps: { insertMeshAlgorithmTimed: insertToMesh }
            }).mesh;
        const nextHopsBySessionId = Object.fromEntries(
            input.activeSessionIds.map((sessionId) => [
                sessionId,
                graph.hasNode(sessionId) ? (graph.neighbors(sessionId) as string[]).sort() : []
            ])
        );
        this.dependencies.metrics.recordWeightedPlanDuration(
            this.dependencies.durationNowMs() - startedAtMs
        );
        return nextHopsBySessionId;
    }

    private readTopologyOptions(
        updateOptions: RallarRtcTopologyUpdateOptions
    ): RallarRtcTopologyServiceOptions {
        if (updateOptions.topologyOptions === undefined) {
            return this.serviceOptions;
        }
        return {
            ...this.serviceOptions,
            ...updateOptions.topologyOptions,
            rttRebuildDebounceMs: this.serviceOptions.rttRebuildDebounceMs
        };
    }

    private readMeshArgs(options: RallarRtcTopologyServiceOptions): GlobalMeshArgs {
        return {
            meshParamK: options.meshParamK ?? DEFAULT_MESH_PARAM_K,
            insertAlgo: DynamicMeshAlgo.K_INSERT_MC,
            removeAlgo: DynamicMeshAlgo.K_REMOVE_MC,
            diameterBound: Number.POSITIVE_INFINITY,
            reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO
        };
    }

    private readDegreeLimit(options: RallarRtcTopologyServiceOptions): number {
        return options.degreeLimit ?? DEFAULT_DEGREE_LIMIT;
    }

    private readTreeMinSize(options: RallarRtcTopologyServiceOptions): number {
        return options.treeMinSize ?? DEFAULT_TREE_MIN_SIZE;
    }

    private readMeshMinSize(options: RallarRtcTopologyServiceOptions): number {
        return options.meshMinSize ?? DEFAULT_MESH_MIN_SIZE;
    }
}

function filterRttMeasurementsForActiveSessions(
    rttMeasurements: readonly RttMeasurementInfo[],
    activeSessionIds: readonly string[]
): readonly RttMeasurementInfo[] {
    if (rttMeasurements.length === 0) {
        return rttMeasurements;
    }
    const activeSessionIdSet = new Set(activeSessionIds);
    return rttMeasurements.filter(
        (rtt) => activeSessionIdSet.has(rtt.sessionIdFrom) && activeSessionIdSet.has(rtt.sessionIdTo)
    );
}

function isExplicitTopologyKind(
    topologyKind: GroupTopologyKindSetting | undefined
): topologyKind is RallarRtcTopologyKind {
    return topologyKind === 'star' || topologyKind === 'tree' || topologyKind === 'mesh';
}
