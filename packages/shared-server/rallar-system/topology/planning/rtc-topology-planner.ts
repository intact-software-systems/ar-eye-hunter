import { ReconfigAlgo } from '@shared-graph/algo-props.ts';
import type { WeightedGraph } from '@shared-graph/graph-props.ts';
import { createGroupMesh, type GlobalMeshArgs } from '@shared-graph/graphs-mesh-service.ts';
import { createGroupTree } from '@shared-graph/graphs-tree-service.ts';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { insertToMesh } from '@shared-graph/mesh/insert-mesh-algs.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupTopologyKindSetting } from '@shared/api/graph-topology-management-types.ts';
import { readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import { resolveRallarGroupLeaderSessionId } from '@shared/api/group-director.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';
import {
    HELD_TOPOLOGY_RESHAPE_REASONS,
    type TopologyReshapePermission
} from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { normalizeRttReportingDegreeLimit } from '@shared/rtc/rtt-reporting-policy.ts';

import type {
    RallarRtcTopologyServiceOptions,
    RallarRtcTopologyUpdateOptions,
    RallarRtcTopologyUpdateResult,
    RtcTopologyKindHysteresisWidths,
    RtcTopologyPlanningIntent
} from '../runtime/rallar-rtc-topology-service.ts';
import type {
    RtcTopologyMetrics,
    RtcTopologyPlanningObservation
} from '../runtime/rtc-topology-metrics.ts';
import { toCanonicalTopologySessionIds } from './canonical-topology-planning-input.ts';
import { computeNoRttTopologyNextHops } from './compute-no-rtt-topology-next-hops.ts';
import {
    createCompleteRtcRoomGraph,
    createRtcRoomGraph,
    materializeSparseRtcRoomGraphFallback
} from './create-rtc-room-graph.ts';
import {
    computeEvolvedTopologyNextHops,
    type EvolvePlannedTopologyFullRebuildReason,
    type EvolvePlannedTopologyResult
} from './evolve-planned-topology.ts';
import { planRallarRtcTopologySnapshot } from './plan-rallar-rtc-topology-snapshot.ts';
import type {
    DerivedRtcTopologyNextHops,
    RtcTopologyPlanDerivation
} from './plan-record/rtc-topology-plan-derivation.ts';
import { resolveHeldTopologyKind, type HeldTopologyKind } from './reshape-gate/resolve-held-topology-kind.ts';
import { resolveRttRefinementNextHops } from './resolve-rtt-refinement-next-hops.ts';
import {
    DEFAULT_MESH_EXIT_WIDTH,
    DEFAULT_TREE_EXIT_WIDTH,
    resolveTopologyKindWithHysteresis
} from './topology-kind-hysteresis.ts';

const DEFAULT_DEGREE_LIMIT = 5;
const DEFAULT_TREE_MIN_SIZE = 5;
const DEFAULT_MESH_MIN_SIZE = 16;
const DEFAULT_MESH_PARAM_K = 2;
const UNGATED_TOPOLOGY_RESHAPE: TopologyReshapePermission = { reshape: 'allowed', wantedReasons: [] };
/** A held room whose in-place update failed is rebuilt at once, so the rebuild takes the kind and root it wants. */
const HELD_TOPOLOGY_REBUILD_RESHAPE: TopologyReshapePermission = {
    reshape: 'allowed',
    wantedReasons: HELD_TOPOLOGY_RESHAPE_REASONS
};

interface RtcTopologyPlanInput {
    readonly group: GroupSnapshot;
    readonly leaderSessionId: string | undefined;
    readonly activeSessionIds: readonly string[];
    readonly relevantRttMeasurements: readonly RttMeasurementInfo[];
    readonly topology: RallarRtcTopologyKind;
    readonly previous: RallarOverlayTopologySnapshot | undefined;
    readonly topologyOptions: RallarRtcTopologyServiceOptions;
    readonly planningIntent: RtcTopologyPlanningIntent;
    readonly reshape: TopologyReshapePermission;
}

interface PlanTopologySelectionInput {
    readonly group: GroupSnapshot;
    readonly activeSessionIds: readonly string[];
    readonly topologyOptions: RallarRtcTopologyServiceOptions;
    readonly previous: RallarOverlayTopologySnapshot | undefined;
    readonly reshape: TopologyReshapePermission;
}

interface PlannedRtcTopologyNextHops extends DerivedRtcTopologyNextHops {
    readonly topology: RallarRtcTopologyKind;
}

interface CreateWeightedTopologyNextHopsInput {
    readonly topology: RallarRtcTopologyKind;
    readonly group: GroupSnapshot;
    readonly leaderSessionId: string | undefined;
    readonly activeSessionIds: readonly string[];
    readonly globalGraph: WeightedGraph;
    readonly options: RallarRtcTopologyServiceOptions;
}

interface CreateRoomGraphInput {
    readonly group: GroupSnapshot;
    readonly leaderSessionId: string | undefined;
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly topology: RallarRtcTopologyKind;
    readonly options: RallarRtcTopologyServiceOptions;
}

export namespace RtcTopologyPlanner {
    export type Metrics = Pick<
        RtcTopologyMetrics,
        | 'recordHysteresisHold'
        | 'recordIncrementalFallback'
        | 'recordIncrementalPlan'
        | 'recordNoRttMeshPlan'
        | 'recordNoRttTreePlan'
        | 'recordStarPlan'
        | 'recordTopologyResult'
        | 'recordTopologyRttMeasurementCount'
        | 'recordWeightedPlanAttempt'
        | 'recordWeightedPlanDuration'
        | 'recordWeightedRoomGraphAttempt'
        | 'recordWeightedRoomGraphDuration'
        | 'recordWeightedRoomGraphSparseFallback'
    >;

    export interface Dependencies {
        readonly metrics: Metrics;
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

    export interface CanonicalPlanInput extends ActivePlanningInput {
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

export interface ComputedRtcTopologyPlan extends RallarRtcTopologyUpdateResult {
    readonly planningObservation: RtcTopologyPlanningObservation;
}

/** Computes both the plan and its deterministic observation without external side effects. */
export function computeRtcTopologyPlan(
    serviceOptions: RallarRtcTopologyServiceOptions,
    input: RtcTopologyPlanner.PlanInput
): ComputedRtcTopologyPlan {
    const projection = createRtcTopologyPlanningProjection();
    const result = new RtcTopologyPlanner(serviceOptions, projection.dependencies).plan(input);
    return { ...result, planningObservation: projection.read() };
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
        return this.planCanonical(
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

    planCanonical(
        input: RtcTopologyPlanner.CanonicalPlanInput,
        publicDispatch: RtcTopologyPlanner.PublicDispatch = this
    ): RallarRtcTopologyUpdateResult {
        const planned = this.computeCanonicalNextHops(
            input,
            input.updateOptions.reshape ?? UNGATED_TOPOLOGY_RESHAPE,
            publicDispatch
        );
        const result = planRallarRtcTopologySnapshot({
            group: input.group,
            previous: input.previous,
            ...planned,
            degreeLimit: this.readDegreeLimit(this.readTopologyOptions(input.updateOptions)),
            nowEpochMs: input.nowEpochMs
        });
        this.dependencies.metrics.recordTopologyResult(result.changed);
        return result;
    }

    /** The graph a weighted rebuild of the room plans over, for the kind the planner selects for it. */
    createRoomGraph(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[],
        publicDispatch: RtcTopologyPlanner.PublicDispatch = this
    ): WeightedGraph {
        const topology = publicDispatch.selectTopology(group, this.serviceOptions);
        return this.createRebuildRoomGraph(
            {
                group,
                leaderSessionId: resolveRallarGroupLeaderSessionId(group),
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
        // A reporting limit below the planning degree limit would reject
        // evidence for planned edges, so readiness could never cover the plan.
        const degreeLimit = this.readDegreeLimit(options);
        return Math.max(
            normalizeRttReportingDegreeLimit(options.rttReportingDegreeLimit, degreeLimit),
            degreeLimit
        );
    }

    readKindHysteresisWidths(): RtcTopologyKindHysteresisWidths {
        return {
            meshExitWidth: Math.max(0, this.serviceOptions.meshExitWidth ?? DEFAULT_MESH_EXIT_WIDTH),
            treeExitWidth: Math.max(0, this.serviceOptions.treeExitWidth ?? DEFAULT_TREE_EXIT_WIDTH)
        };
    }

    private computeCanonicalNextHops(
        input: RtcTopologyPlanner.CanonicalPlanInput,
        reshape: TopologyReshapePermission,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): PlannedRtcTopologyNextHops {
        const topologyOptions = this.readTopologyOptions(input.updateOptions);
        const selected = this.selectPlanTopology({ ...input, topologyOptions, reshape }, publicDispatch);
        const plan: RtcTopologyPlanInput = {
            group: input.group,
            leaderSessionId: resolveRallarGroupLeaderSessionId(input.group),
            activeSessionIds: input.activeSessionIds,
            relevantRttMeasurements: input.relevantRttMeasurements,
            topology: selected.topology,
            previous: input.previous,
            topologyOptions,
            planningIntent: input.updateOptions.planningIntent ?? 'full-rebuild',
            reshape
        };
        const evolved = this.computeEvolvedNextHops(plan);
        if (reshape.reshape === 'held' && evolved?.outcome === 'full-rebuild') {
            return this.computeCanonicalNextHops(input, HELD_TOPOLOGY_REBUILD_RESHAPE, publicDispatch);
        }
        const planned = this.computePlannedNextHops(plan, evolved, publicDispatch);
        const heldReshapeReasons = HELD_TOPOLOGY_RESHAPE_REASONS.filter((reason) =>
            selected.heldReshapeReasons.includes(reason) || planned.heldReshapeReasons.includes(reason)
        );
        return { ...planned, topology: selected.topology, heldReshapeReasons };
    }

    private selectPlanTopology(
        input: PlanTopologySelectionInput,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): HeldTopologyKind {
        const previousKind = input.previous?.state === 'active' ? input.previous.topology : undefined;
        const topology = publicDispatch.selectTopology(input.group, input.topologyOptions, previousKind);
        if (
            previousKind !== undefined &&
            topology === previousKind &&
            publicDispatch.selectTopology(input.group, input.topologyOptions) !== topology
        ) {
            this.dependencies.metrics.recordHysteresisHold();
        }
        return resolveHeldTopologyKind({
            reshape: input.reshape,
            previousKind,
            selectedKind: topology,
            explicitKind: isExplicitTopologyKind(input.topologyOptions.topologyKind),
            activeSize: input.activeSessionIds.length,
            degreeLimit: this.readDegreeLimit(input.topologyOptions)
        });
    }

    private computePlannedNextHops(
        plan: RtcTopologyPlanInput,
        evolved: EvolvePlannedTopologyResult | undefined,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): DerivedRtcTopologyNextHops {
        if (plan.topology === 'star') {
            return this.computeStarNextHops(plan);
        }
        if (evolved?.outcome === 'planned') {
            return {
                nextHopsBySessionId: evolved.nextHopsBySessionId,
                derivation: { method: 'incremental' },
                heldReshapeReasons: evolved.heldReshapeReasons
            };
        }
        const rebuildDerivation = resolveRtcTopologyPlanDerivation(plan, {
            method: 'rebuilt',
            reason: evolved?.reason ?? 'refinement'
        });
        if (plan.relevantRttMeasurements.length === 0) {
            return {
                nextHopsBySessionId: this.computeNoRttNextHops(plan),
                derivation: rebuildDerivation,
                heldReshapeReasons: []
            };
        }
        return this.computeWeightedNextHops(plan, rebuildDerivation, publicDispatch);
    }

    private computeWeightedNextHops(
        plan: RtcTopologyPlanInput,
        rebuildDerivation: RtcTopologyPlanDerivation,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): DerivedRtcTopologyNextHops {
        const rebuiltNextHopsBySessionId = this.createNextHopMap({
            topology: plan.topology,
            group: plan.group,
            leaderSessionId: plan.leaderSessionId,
            activeSessionIds: plan.activeSessionIds,
            globalGraph: this.createRebuildRoomGraph(toRoomGraphInput(plan), publicDispatch),
            options: plan.topologyOptions
        });
        if (
            plan.planningIntent !== 'full-rebuild' || plan.topology !== 'tree' || plan.previous?.state !== 'active' ||
            plan.previous.topology !== 'tree'
        ) {
            return {
                nextHopsBySessionId: rebuiltNextHopsBySessionId,
                derivation: rebuildDerivation,
                heldReshapeReasons: []
            };
        }
        const refined = resolveRttRefinementNextHops({
            evolve: {
                previous: plan.previous,
                group: plan.group,
                leaderSessionId: plan.leaderSessionId,
                activeSessionIds: plan.activeSessionIds,
                globalGraph: this.createEvolutionRoomGraph(plan, plan.previous),
                kind: plan.topology,
                degreeLimit: this.readDegreeLimit(plan.topologyOptions),
                meshParamK: this.readMeshArgs(plan.topologyOptions).meshParamK,
                reshape: plan.reshape
            },
            rttMeasurements: plan.relevantRttMeasurements,
            rebuiltNextHopsBySessionId
        });
        return { ...refined, heldReshapeReasons: [] };
    }

    private computeStarNextHops(plan: RtcTopologyPlanInput): DerivedRtcTopologyNextHops {
        const startedAtMs = this.dependencies.durationNowMs();
        const nextHopsBySessionId = computeNoRttTopologyNextHops({
            topology: plan.topology,
            activeSessionIds: plan.activeSessionIds,
            preferredSourceSessionId: undefined,
            degreeLimit: this.readDegreeLimit(plan.topologyOptions),
            meshParamK: this.readMeshArgs(plan.topologyOptions).meshParamK
        });
        this.dependencies.metrics.recordStarPlan(this.dependencies.durationNowMs() - startedAtMs);
        return {
            nextHopsBySessionId,
            derivation: resolveRtcTopologyPlanDerivation(plan, { method: 'incremental' }),
            heldReshapeReasons: []
        };
    }

    /** With the reshape held, every plan evolves as a membership delta, whatever its intent. */
    private computeEvolvedNextHops(plan: RtcTopologyPlanInput): EvolvePlannedTopologyResult | undefined {
        if (
            (plan.planningIntent !== 'membership-delta' && plan.reshape.reshape !== 'held') ||
            plan.previous?.state !== 'active' ||
            plan.previous.topology !== plan.topology ||
            (plan.topology !== 'tree' && plan.topology !== 'mesh')
        ) {
            return undefined;
        }
        const evolved = computeEvolvedTopologyNextHops({
            previous: plan.previous,
            group: plan.group,
            leaderSessionId: plan.leaderSessionId,
            activeSessionIds: plan.activeSessionIds,
            globalGraph: this.createEvolutionRoomGraph(plan, plan.previous),
            kind: plan.topology,
            degreeLimit: this.readDegreeLimit(plan.topologyOptions),
            meshParamK: this.readMeshArgs(plan.topologyOptions).meshParamK,
            reshape: plan.reshape
        });
        if (evolved.outcome === 'full-rebuild') {
            this.dependencies.metrics.recordIncrementalFallback(evolved.reason);
            return evolved;
        }
        this.dependencies.metrics.recordIncrementalPlan();
        return evolved;
    }

    private computeNoRttNextHops(plan: RtcTopologyPlanInput): Record<string, readonly string[]> {
        const startedAtMs = this.dependencies.durationNowMs();
        const nextHopsBySessionId = computeNoRttTopologyNextHops({
            topology: plan.topology,
            activeSessionIds: plan.activeSessionIds,
            preferredSourceSessionId: plan.leaderSessionId,
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
        input: CreateRoomGraphInput,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): WeightedGraph {
        const startedAtMs = this.dependencies.durationNowMs();
        this.dependencies.metrics.recordWeightedRoomGraphAttempt();
        const activeSessionIds = toCanonicalTopologySessionIds(readGroupMemberSessionIds(input.group));
        const result = createRtcRoomGraph({
            group: input.group,
            activeSessionIds,
            preferredSourceSessionId: input.leaderSessionId,
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

    private createRebuildRoomGraph(
        input: CreateRoomGraphInput,
        publicDispatch: RtcTopologyPlanner.PublicDispatch
    ): WeightedGraph {
        // K_INSERT_MC weighs a link from each inserted member to every mesh member with a free link, so it needs
        // every pair; the measured graph, capped at the reporting limit, lacks most of them.
        return input.topology === 'mesh'
            ? this.createCompleteRoomGraph(input, readGroupMemberSessionIds(input.group))
            : this.createMeasuredRoomGraph(input, publicDispatch);
    }

    /**
     * The previous layout's members leaving in this plan stay vertices, so the repair of one leaver can read the limit
     * of a neighbour that leaves after it; the repair removes them all, and validation reads the current members only.
     */
    private createEvolutionRoomGraph(
        plan: RtcTopologyPlanInput,
        previous: RallarOverlayTopologySnapshot
    ): WeightedGraph {
        return this.createCompleteRoomGraph(toRoomGraphInput(plan), [
            ...readGroupMemberSessionIds(plan.group),
            ...previous.activeSessionIds
        ]);
    }

    private createCompleteRoomGraph(input: CreateRoomGraphInput, sessionIds: readonly string[]): WeightedGraph {
        const startedAtMs = this.dependencies.durationNowMs();
        this.dependencies.metrics.recordWeightedRoomGraphAttempt();
        const graph = createCompleteRtcRoomGraph({
            group: input.group,
            sessionIds: toCanonicalTopologySessionIds(sessionIds),
            rttMeasurements: input.rttMeasurements,
            degreeLimit: this.readDegreeLimit(input.options)
        });
        this.dependencies.metrics.recordWeightedRoomGraphDuration(
            this.dependencies.durationNowMs() - startedAtMs
        );
        return graph;
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
                maxDegree: this.readDegreeLimit(input.options),
                preferredSource: input.leaderSessionId
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
            ...updateOptions.topologyOptions
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

function resolveRtcTopologyPlanDerivation(
    plan: RtcTopologyPlanInput,
    sameKindDerivation: RtcTopologyPlanDerivation
): RtcTopologyPlanDerivation {
    if (plan.previous?.state !== 'active') {
        return { method: 'established' };
    }
    if (plan.previous.topology !== plan.topology) {
        return { method: 'rebuilt', reason: 'kind-change' };
    }
    return sameKindDerivation;
}

function toRoomGraphInput(plan: RtcTopologyPlanInput): CreateRoomGraphInput {
    return {
        group: plan.group,
        leaderSessionId: plan.leaderSessionId,
        rttMeasurements: plan.relevantRttMeasurements,
        topology: plan.topology,
        options: plan.topologyOptions
    };
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

interface RtcTopologyPlanningProjection {
    readonly dependencies: RtcTopologyPlanner.Dependencies;
    readonly read: () => RtcTopologyPlanningObservation;
}

function createRtcTopologyPlanningProjection(): RtcTopologyPlanningProjection {
    const observation = {
        relevantRttMeasurementCount: 0,
        resultChanged: false,
        starPlanCount: 0,
        noRttTreePlanCount: 0,
        noRttMeshPlanCount: 0,
        weightedPlanCount: 0,
        weightedRoomGraphBuildCount: 0,
        weightedRoomGraphSparseFallbackCount: 0,
        incrementalPlanCount: 0,
        incrementalFallbackReasons: [] as EvolvePlannedTopologyFullRebuildReason[],
        hysteresisHoldCount: 0
    };
    return {
        dependencies: {
            metrics: {
                recordHysteresisHold: () => {
                    observation.hysteresisHoldCount += 1;
                },
                recordIncrementalFallback: (reason) => {
                    observation.incrementalFallbackReasons.push(reason);
                },
                recordIncrementalPlan: () => {
                    observation.incrementalPlanCount += 1;
                },
                recordNoRttMeshPlan: () => {
                    observation.noRttMeshPlanCount += 1;
                },
                recordNoRttTreePlan: () => {
                    observation.noRttTreePlanCount += 1;
                },
                recordStarPlan: () => {
                    observation.starPlanCount += 1;
                },
                recordTopologyResult: (changed) => {
                    observation.resultChanged = changed;
                },
                recordTopologyRttMeasurementCount: (count) => {
                    observation.relevantRttMeasurementCount = count;
                },
                recordWeightedPlanAttempt: () => {
                    observation.weightedPlanCount += 1;
                },
                recordWeightedPlanDuration: () => {},
                recordWeightedRoomGraphAttempt: () => {
                    observation.weightedRoomGraphBuildCount += 1;
                },
                recordWeightedRoomGraphDuration: () => {},
                recordWeightedRoomGraphSparseFallback: () => {
                    observation.weightedRoomGraphSparseFallbackCount += 1;
                }
            },
            durationNowMs: () => 0
        },
        read: () => ({
            ...observation,
            incrementalFallbackReasons: [...observation.incrementalFallbackReasons]
        })
    };
}
