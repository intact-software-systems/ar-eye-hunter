import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupTopologyKindSetting } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    compareOverlayTopologyCausalTuple,
    type RallarOverlayTopologySnapshot,
    type RallarRtcTopologyKind,
} from '@shared/api/overlay-topology.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import {
    emptyTopologyMetrics,
    type RallarRtcTopologyMetrics,
} from '../topology/rallar-rtc-topology-metrics.ts';
import { normalizeRttReportingDegreeLimit } from '@shared/rtc/rtt-reporting-policy.ts';
import {
    compareRtcTopologyIdentifiers,
    toCanonicalRtcTopologyPairIdentity,
} from '../rtc-topology-identifiers.ts';
import {
    computeCanonicalTopologyPairWeight,
    toCanonicalTopologySessionIds,
} from '../topology/planning/canonical-topology-planning-input.ts';
import {
    computeEvolvedTopologyNextHops,
} from '../topology/planning/evolve-planned-topology.ts';
import {
    DEFAULT_MESH_EXIT_WIDTH,
    DEFAULT_TREE_EXIT_WIDTH,
    resolveTopologyKindWithHysteresis,
} from '../topology/planning/topology-kind-hysteresis.ts';
import {
    readGroupCreatedAtEpochMs,
    readGroupCreatedByPrincipalId,
    readGroupDisplayName,
    readGroupCausalRevision,
    readGroupMemberSessionIds,
} from '@shared/api/group-client-views.ts';
import { ReconfigAlgo } from '@shared-graph/algo-props.ts';
import { createGroupMesh, type GlobalMeshArgs, } from '@shared-graph/graphs-mesh-service.ts';
import { createGroupTree } from '@shared-graph/graphs-tree-service.ts';
import {
    type EdgeProp,
    type GraphProp,
    type VertexProp,
    VertexState,
    VertexType,
    type WeightedGraph,
} from '@shared-graph/graph-props.ts';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { insertToMesh } from '@shared-graph/mesh/insert-mesh-algs.ts';
import { UndirectedGraph } from 'graphology';

export type RallarRtcTopologyServiceOptions = Readonly<{
    topologyKind?: GroupTopologyKindSetting;
    degreeLimit?: number;
    rttReportingDegreeLimit?: number;
    treeMinSize?: number;
    meshMinSize?: number;
    meshParamK?: number;
    meshExitWidth?: number;
    treeExitWidth?: number;
    rttRebuildDebounceMs?: number;
    now?: () => number;
}>;

export type RallarRtcTopologyUpdateResult = Readonly<{
    snapshot: RallarOverlayTopologySnapshot;
    changed: boolean;
    previous: RallarOverlayTopologySnapshot | null;
}>;

export type RallarRtcTopologyUpdateOptions = Readonly<{
    previous?: RallarOverlayTopologySnapshot;
    topologyOptions?: RallarRtcTopologyServiceOptions;
    planningIntent?: RtcTopologyPlanningIntent;
}>;

/**
 * `membership-delta` work (the coalesced group-revision path) may evolve the
 * previous accepted graph incrementally; every other trigger — explicit
 * reconfigure, RTT refresh — plans a full rebuild, which is also the periodic
 * bound on incremental drift.
 */
export type RtcTopologyPlanningIntent = 'membership-delta' | 'full-rebuild';

export type RtcTopologyKindHysteresisWidths = Readonly<{
    meshExitWidth: number;
    treeExitWidth: number;
}>;

interface RtcTopologyPlanInput {
    readonly group: GroupSnapshot;
    readonly activeSessionIds: readonly string[];
    readonly relevantRttMeasurements: readonly RttMeasurementInfo[];
    readonly topology: RallarRtcTopologyKind;
    readonly previous: RallarOverlayTopologySnapshot | undefined;
    readonly topologyOptions: RallarRtcTopologyServiceOptions;
    readonly planningIntent: RtcTopologyPlanningIntent;
}

interface RtcTopologyRoomGraphInput {
    readonly group: GroupSnapshot;
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly options: RallarRtcTopologyServiceOptions;
    readonly seedTopology: RallarRtcTopologyKind;
}

export function planRallarRtcTopologySnapshot(input: Readonly<{
    group: GroupSnapshot;
    previous?: RallarOverlayTopologySnapshot;
    topology: RallarRtcTopologyKind;
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
    degreeLimit: number;
    nowEpochMs: number;
}>): RallarRtcTopologyUpdateResult {
    const activeSessionIds = [...readGroupMemberSessionIds(input.group)]
        .sort(compareRtcTopologyIdentifiers);
    const name = readGroupDisplayName(input.group);
    const changed = input.previous === undefined ||
        input.previous.topology !== input.topology ||
        input.previous.name !== name ||
        input.previous.degreeLimit !== input.degreeLimit ||
        !isSameNextHopMap(
            input.previous.nextHopsBySessionId,
            input.nextHopsBySessionId,
        );
    const candidate: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision: readGroupCausalRevision(input.group),
        state: 'active',
        overlayId: toScopedOverlayId(input.group.group),
        groupRef: canonicalGroupRef(input.group.group),
        name,
        topology: input.topology,
        activeSessionIds,
        nextHopsBySessionId: input.nextHopsBySessionId,
        degreeLimit: input.degreeLimit,
        version: changed
            ? (input.previous?.version ?? 0) + 1
            : input.previous.version,
        createdByClientId: readGroupCreatedByPrincipalId(input.group),
        createdAtEpochMs: input.previous?.createdAtEpochMs ??
            readGroupCreatedAtEpochMs(input.group),
        updatedAtEpochMs: changed
            ? input.nowEpochMs
            : input.previous.updatedAtEpochMs,
    };
    const snapshot = input.previous &&
            rtcTopologySemanticEqual(candidate, input.previous)
        ? input.previous
        : candidate;
    return { snapshot, changed, previous: input.previous ?? null };
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
    };
}

export type RallarRtcTopologyRttQueueResult = Readonly<{
    overlayId: string;
    dueAtEpochMs: number;
    delayMs: number;
    newlyQueued: boolean;
    immediate: boolean;
}>;

const DEFAULT_DEGREE_LIMIT = 5;
const DEFAULT_TREE_MIN_SIZE = 5;
const DEFAULT_MESH_MIN_SIZE = 16;
const DEFAULT_MESH_PARAM_K = 2;
const DEFAULT_RTT_REBUILD_DEBOUNCE_MS = 250;

export class RallarRtcTopologyService {
    private readonly snapshotsByOverlayId = new Map<
        string,
        RallarOverlayTopologySnapshot
    >();
    private readonly pendingRttUpdateDueAtByOverlayId = new Map<string, number>();
    private readonly metrics = emptyTopologyMetrics();

    private readonly options: RallarRtcTopologyServiceOptions;

    constructor(
        options: RallarRtcTopologyServiceOptions = {},
    ) {
        this.options = options;
    }

    readMetrics(): RallarRtcTopologyMetrics {
        return {
            ...this.metrics,
            topologySnapshotCount: this.snapshotsByOverlayId.size,
            pendingRttUpdateCount: this.pendingRttUpdateDueAtByOverlayId.size,
        };
    }

    resetMetrics(): void {
        Object.assign(this.metrics, emptyTopologyMetrics());
    }

    observeTopologySnapshot(snapshot: RallarOverlayTopologySnapshot): boolean {
        const current = this.snapshotsByOverlayId.get(snapshot.overlayId);
        const comparison = current
            ? compareOverlayTopologyCausalTuple(snapshot, current)
            : null;
        if (!current || comparison === 'dominates') {
            this.snapshotsByOverlayId.set(snapshot.overlayId, snapshot);
            return true;
        }
        if (comparison === 'equal' &&
            !rtcTopologySemanticEqual(snapshot, current)) {
            throw new Error(
                `RTC topology process-cache revision conflict: ${snapshot.overlayId}`,
            );
        }
        if (comparison === 'incomparable') {
            throw new Error(
                `RTC topology process-cache causal conflict: ${snapshot.overlayId}`,
            );
        }
        return false;
    }

    recordTopologyPublishResult(changed: boolean): void {
        this.metrics.topologyPublishAttemptCount += 1;
        if (changed) {
            this.metrics.topologyPublishedCount += 1;
        } else {
            this.metrics.topologyPublishSkippedUnchangedCount += 1;
        }
    }

    recordTopologyRebuildSkippedFingerprint(): void {
        this.metrics.topologyRebuildSkippedFingerprintCount += 1;
    }

    updateGroupTopology(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {},
    ): RallarRtcTopologyUpdateResult {
        const result = this.planGroupTopology(
            group,
            rttMeasurements,
            options,
        );
        this.observeCommittedTopologySnapshot(result.snapshot);
        return result;
    }

    observeCommittedTopologySnapshot(
        snapshot: RallarOverlayTopologySnapshot,
    ): boolean {
        const changed = this.observeTopologySnapshot(snapshot);
        this.pendingRttUpdateDueAtByOverlayId.delete(snapshot.overlayId);
        return changed;
    }

    planGroupTopology(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {},
    ): RallarRtcTopologyUpdateResult {
        return this.planGroupTopologyAt(
            group,
            rttMeasurements,
            options,
            this.now(),
        );
    }

    planGroupTopologyAt(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[],
        options: RallarRtcTopologyUpdateOptions,
        nowEpochMs: number,
    ): RallarRtcTopologyUpdateResult {
        this.metrics.topologyUpdateCount += 1;
        const activeSessionIds = toCanonicalTopologySessionIds(
            readGroupMemberSessionIds(group),
        );
        const relevantRttMeasurements = filterRttMeasurementsForActiveSessions(
            rttMeasurements,
            activeSessionIds,
        );
        if (relevantRttMeasurements.length > 0) {
            this.metrics.updatesWithRttMeasurementCount += 1;
        } else {
            this.metrics.updatesWithoutRttMeasurementCount += 1;
        }

        const overlayId = toScopedOverlayId(group.group);
        const previous = this.readPreviousSnapshot(overlayId, options);
        const topologyOptions = this.readTopologyOptions(options);
        const topology = this.selectPlanTopology(group, topologyOptions, previous);
        const degreeLimit = this.degreeLimit(topologyOptions);
        const nextHopsBySessionId = this.computePlannedNextHops({
            group,
            activeSessionIds,
            relevantRttMeasurements,
            topology,
            previous,
            topologyOptions,
            planningIntent: options.planningIntent ?? 'full-rebuild',
        });
        const result = planRallarRtcTopologySnapshot({
            group,
            previous,
            topology,
            nextHopsBySessionId,
            degreeLimit,
            nowEpochMs,
        });
        if (result.changed) {
            this.metrics.topologyChangedCount += 1;
        } else {
            this.metrics.topologyUnchangedCount += 1;
        }
        return result;
    }

    removeGroupTopology(group: GroupSnapshot): boolean {
        const overlayId = toScopedOverlayId(group.group);
        this.metrics.topologyRemovalRequestCount += 1;
        this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
        const removed = this.snapshotsByOverlayId.delete(overlayId);
        if (removed) {
            this.metrics.topologyRemovedCount += 1;
        } else {
            this.metrics.topologyRemoveMissCount += 1;
        }
        return removed;
    }

    readSnapshot(group: GroupSnapshot): RallarOverlayTopologySnapshot | undefined {
        return this.snapshotsByOverlayId.get(toScopedOverlayId(group.group));
    }

    queueRttTopologyUpdate(
        group: GroupSnapshot,
    ): RallarRtcTopologyRttQueueResult {
        this.metrics.rttQueueRequestCount += 1;
        const overlayId = toScopedOverlayId(group.group);
        const now = this.now();
        const existingDueAt = this.pendingRttUpdateDueAtByOverlayId.get(
            overlayId,
        );

        if (existingDueAt !== undefined) {
            this.metrics.rttQueueCoalescedCount += 1;
            if (existingDueAt <= now) {
                this.metrics.rttQueueImmediateCount += 1;
            }
            return {
                overlayId,
                dueAtEpochMs: existingDueAt,
                delayMs: Math.max(0, existingDueAt - now),
                newlyQueued: false,
                immediate: existingDueAt <= now,
            };
        }

        const dueAtEpochMs = this.snapshotsByOverlayId.has(overlayId)
            ? now + this.rttRebuildDebounceMs()
            : now;
        this.pendingRttUpdateDueAtByOverlayId.set(overlayId, dueAtEpochMs);
        this.metrics.rttQueueNewCount += 1;
        if (dueAtEpochMs <= now) {
            this.metrics.rttQueueImmediateCount += 1;
        }

        return {
            overlayId,
            dueAtEpochMs,
            delayMs: Math.max(0, dueAtEpochMs - now),
            newlyQueued: true,
            immediate: dueAtEpochMs <= now,
        };
    }

    flushDueRttTopologyUpdate(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {},
    ): RallarRtcTopologyUpdateResult | undefined {
        if (!this.claimDueRttTopologyUpdate(group.group)) return undefined;
        return this.updateGroupTopology(group, rttMeasurements, options);
    }

    claimDueRttTopologyUpdate(groupRef: GroupRef): boolean {
        this.metrics.rttFlushAttemptCount += 1;
        const overlayId = toScopedOverlayId(groupRef);
        const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(
            overlayId,
        );
        if (dueAtEpochMs === undefined || dueAtEpochMs > this.now()) {
            this.metrics.rttFlushSkippedCount += 1;
            return false;
        }

        this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
        this.metrics.rttFlushExecutedCount += 1;
        return true;
    }

    readRttTopologyUpdateDelayMs(group: GroupSnapshot): number | undefined {
        const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(
            toScopedOverlayId(group.group),
        );
        if (dueAtEpochMs === undefined) {
            return undefined;
        }

        return Math.max(0, dueAtEpochMs - this.now());
    }

    readRttRebuildDebounceMs(): number {
        return this.rttRebuildDebounceMs();
    }

    readNowEpochMs(): number {
        return this.now();
    }

    readRttReportingDegreeLimit(
        options: RallarRtcTopologyServiceOptions = this.options,
    ): number {
        return normalizeRttReportingDegreeLimit(
            options.rttReportingDegreeLimit,
            this.degreeLimit(options),
        );
    }

    selectTopology(
        group: GroupSnapshot,
        options: RallarRtcTopologyServiceOptions = this.options,
        previousKind?: RallarRtcTopologyKind,
    ): RallarRtcTopologyKind {
        if (
            options.topologyKind === 'star' ||
            options.topologyKind === 'tree' ||
            options.topologyKind === 'mesh'
        ) {
            return options.topologyKind;
        }

        return resolveTopologyKindWithHysteresis({
            activeSize: new Set(readGroupMemberSessionIds(group)).size,
            treeMinSize: this.treeMinSize(options),
            meshMinSize: this.meshMinSize(options),
            meshExitWidth: this.meshExitWidth(),
            treeExitWidth: this.treeExitWidth(),
            previousKind,
        });
    }

    private readPreviousSnapshot(
        overlayId: string,
        options: RallarRtcTopologyUpdateOptions,
    ): RallarOverlayTopologySnapshot | undefined {
        if (options.previous?.overlayId === overlayId) {
            return options.previous;
        }

        return this.snapshotsByOverlayId.get(overlayId);
    }

    private selectPlanTopology(
        group: GroupSnapshot,
        topologyOptions: RallarRtcTopologyServiceOptions,
        previous: RallarOverlayTopologySnapshot | undefined,
    ): RallarRtcTopologyKind {
        const previousKind = previous?.state === 'active' ? previous.topology : undefined;
        const topology = this.selectTopology(group, topologyOptions, previousKind);
        if (
            previousKind !== undefined &&
            topology === previousKind &&
            this.selectTopology(group, topologyOptions) !== topology
        ) {
            this.metrics.hysteresisHeldKindCount += 1;
        }
        return topology;
    }

    private computePlannedNextHops(
        plan: RtcTopologyPlanInput,
    ): Record<string, readonly string[]> {
        if (plan.topology === 'star') {
            const startedAtMs = this.durationNowMs();
            const nextHopsBySessionId = this.createStarNextHopMap(plan.activeSessionIds);
            this.metrics.starPlanCount += 1;
            this.metrics.starPlanDurationMs += this.durationNowMs() - startedAtMs;
            return nextHopsBySessionId;
        }

        const evolved = this.computeEvolvedNextHops(plan);
        if (evolved !== undefined) {
            return evolved;
        }

        if (plan.relevantRttMeasurements.length === 0) {
            return this.computeNoRttNextHops(plan);
        }

        return this.createNextHopMap(
            plan.topology,
            plan.group,
            plan.activeSessionIds,
            this.readPlanRoomGraph(plan),
            plan.topologyOptions,
        );
    }

    private computeEvolvedNextHops(
        plan: RtcTopologyPlanInput,
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
            globalGraph: this.readPlanRoomGraph(plan),
            kind: plan.topology,
            degreeLimit: this.degreeLimit(plan.topologyOptions),
            meshParamK: this.meshArgs(plan.topologyOptions).meshParamK,
        });
        if (evolved.outcome === 'full-rebuild') {
            this.metrics.incrementalPlanFallbackFullCount += 1;
            return undefined;
        }

        this.metrics.incrementalPlanCount += 1;
        return evolved.nextHopsBySessionId;
    }

    private computeNoRttNextHops(
        plan: RtcTopologyPlanInput,
    ): Record<string, readonly string[]> {
        const startedAtMs = this.durationNowMs();
        if (plan.topology === 'tree') {
            const nextHopsBySessionId = createNoRttTreeNextHopMap(
                plan.activeSessionIds,
                this.degreeLimit(plan.topologyOptions),
            );
            this.metrics.noRttTreePlanCount += 1;
            this.metrics.noRttTreePlanDurationMs += this.durationNowMs() - startedAtMs;
            return nextHopsBySessionId;
        }

        const nextHopsBySessionId = this.createNoRttMeshNextHopMap(
            plan.activeSessionIds,
            plan.topologyOptions,
        );
        this.metrics.noRttMeshPlanCount += 1;
        this.metrics.noRttMeshPlanDurationMs += this.durationNowMs() - startedAtMs;
        return nextHopsBySessionId;
    }

    private readPlanRoomGraph(plan: RtcTopologyPlanInput): WeightedGraph {
        return this.createRoomGraphWithOptions({
            group: plan.group,
            rttMeasurements: plan.relevantRttMeasurements,
            options: plan.topologyOptions,
            seedTopology: plan.topology,
        });
    }

    createRoomGraph(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
    ): WeightedGraph {
        return this.createRoomGraphWithOptions({
            group,
            rttMeasurements,
            options: this.options,
            seedTopology: this.selectTopology(group, this.options),
        });
    }

    private createRoomGraphWithOptions(
        roomGraphInput: RtcTopologyRoomGraphInput,
    ): WeightedGraph {
        const { group, rttMeasurements, options } = roomGraphInput;
        const startedAtMs = this.durationNowMs();
        this.metrics.weightedRoomGraphBuildCount += 1;
        const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
        const degreeLimit = this.degreeLimit(options);
        const rttReportingDegreeLimit = this.readRttReportingDegreeLimit(options);
        const activeSessionIds = toCanonicalTopologySessionIds(
            readGroupMemberSessionIds(group),
        );
        const rttBySessionId = rttMeasurements.length > 0
            ? createRttWeightLookup(rttMeasurements)
            : undefined;

        graph.replaceAttributes({
            id: toScopedOverlayId(group.group),
            version: group.group.snapshotVersion,
            degreeLimitMember: degreeLimit,
            degreeLimitSteiner: degreeLimit,
        });

        for (const sessionId of activeSessionIds) {
            graph.addNode(sessionId, {
                id: sessionId,
                type: VertexType.CLIENT,
                state: VertexState.MEMBER,
                degreeLimit,
            });
        }

        if (rttMeasurements.length === 0) {
            addCompleteFallbackRoomEdges(graph, activeSessionIds, rttBySessionId);
        } else {
            const fallbackNextHops = this.createNoRttNextHopMap(
                roomGraphInput.seedTopology,
                activeSessionIds,
                options,
            );
            const sparse = this.populateSparseRoomGraph(
                graph,
                activeSessionIds,
                rttMeasurements,
                fallbackNextHops,
                rttReportingDegreeLimit,
            );

            if (!sparse.connected) {
                this.metrics.weightedRoomGraphSparseFallbackCount += 1;
                this.metrics.weightedRoomGraphBuildDurationMs +=
                    this.durationNowMs() - startedAtMs;
                return createFallbackRoomGraph(
                    group,
                    activeSessionIds,
                    fallbackNextHops,
                    degreeLimit,
                );
            }
        }

        this.metrics.weightedRoomGraphBuildDurationMs +=
            this.durationNowMs() - startedAtMs;
        return graph;
    }

    private populateSparseRoomGraph(
        graph: WeightedGraph,
        activeSessionIds: readonly string[],
        rttMeasurements: readonly RttMeasurementInfo[],
        fallbackNextHops: Readonly<Record<string, readonly string[]>>,
        degreeLimit: number,
    ): Readonly<{ connected: boolean }> {
        const maxEdges = Math.floor((activeSessionIds.length * degreeLimit) / 2);

        for (const edge of createSortedRttEdges(rttMeasurements, activeSessionIds)) {
            addBoundedRoomEdge(
                graph,
                edge.from,
                edge.to,
                edge.weight,
                degreeLimit,
                maxEdges,
            );
        }

        for (const [from, nextHops] of Object.entries(fallbackNextHops)) {
            for (const to of nextHops) {
                addBoundedRoomEdge(
                    graph,
                    from,
                    to,
                    computeCanonicalTopologyPairWeight(from, to),
                    degreeLimit,
                    maxEdges,
                );
            }
        }

        if (!isConnectedRoomGraph(graph, activeSessionIds)) {
            return { connected: false };
        }

        for (let i = 0; i < activeSessionIds.length; i++) {
            for (let j = i + 1; j < activeSessionIds.length; j++) {
                if (graph.size >= maxEdges) {
                    return { connected: true };
                }
                addBoundedRoomEdge(
                    graph,
                    activeSessionIds[i],
                    activeSessionIds[j],
                    computeCanonicalTopologyPairWeight(
                        activeSessionIds[i],
                        activeSessionIds[j],
                    ),
                    degreeLimit,
                    maxEdges,
                );
            }
        }

        return { connected: true };
    }

    private createNextHopMap(
        topology: RallarRtcTopologyKind,
        group: GroupSnapshot,
        activeSessionIds: readonly string[],
        globalGraph: WeightedGraph,
        options: RallarRtcTopologyServiceOptions,
    ): Record<string, readonly string[]> {
        const startedAtMs = this.durationNowMs();
        this.metrics.weightedPlanCount += 1;
        const graph = topology === 'tree'
            ? createGroupTree({
                group,
                globalGraph,
                maxDegree: this.degreeLimit(options),
            }).tree
            : createGroupMesh({
                group,
                globalGraph,
                maxDegree: this.degreeLimit(options),
                globalArgs: this.meshArgs(options),
                deps: {
                    insertMeshAlgorithmTimed: insertToMesh,
                },
            }).mesh;

        const nextHopsBySessionId = Object.fromEntries(
            activeSessionIds.map((sessionId) => [
                sessionId,
                graph.hasNode(sessionId)
                    ? (graph.neighbors(sessionId) as string[]).sort()
                    : [],
            ]),
        );
        this.metrics.weightedPlanDurationMs += this.durationNowMs() - startedAtMs;
        return nextHopsBySessionId;
    }

    private createStarNextHopMap(
        activeSessionIds: readonly string[],
    ): Record<string, readonly string[]> {
        return Object.fromEntries(
            activeSessionIds.map((sessionId) => [
                sessionId,
                activeSessionIds.filter((peerId) => peerId !== sessionId),
            ]),
        );
    }

    private createNoRttMeshNextHopMap(
        activeSessionIds: readonly string[],
        options: RallarRtcTopologyServiceOptions,
    ): Record<string, readonly string[]> {
        // Mirrors createGroupMesh + kInsertMC (k cheapest feasible candidates
        // by direct pair weight) for fallback weights without materializing
        // the complete Graphology room graph.
        const targetEdgeCount = this.meshArgs(options).meshParamK;
        const degreeLimit = this.degreeLimit(options);
        const insertedSessionIds: string[] = [];
        const nextHopsBySessionId = new Map<string, Set<string>>();

        for (const sessionId of activeSessionIds) {
            if (nextHopsBySessionId.has(sessionId)) continue;

            if (insertedSessionIds.length === 0) {
                nextHopsBySessionId.set(sessionId, new Set());
                insertedSessionIds.push(sessionId);
                continue;
            }

            const rankedCandidates = insertedSessionIds
                .filter((candidate) =>
                    (nextHopsBySessionId.get(candidate)?.size ?? 0) < degreeLimit
                )
                .map((candidate) => ({
                    candidate,
                    weight: computeCanonicalTopologyPairWeight(sessionId, candidate),
                }))
                .sort((left, right) =>
                    left.weight - right.weight ||
                    compareRtcTopologyIdentifiers(left.candidate, right.candidate)
                );

            if (rankedCandidates.length === 0) break;

            const nextHops = new Set<string>();
            nextHopsBySessionId.set(sessionId, nextHops);
            insertedSessionIds.push(sessionId);

            for (const { candidate } of rankedCandidates.slice(0, targetEdgeCount)) {
                nextHops.add(candidate);
                nextHopsBySessionId.get(candidate)?.add(sessionId);
            }
        }

        return Object.fromEntries(
            activeSessionIds.map((sessionId) => [
                sessionId,
                [...(nextHopsBySessionId.get(sessionId) ?? [])].sort(),
            ]),
        );
    }

    private createNoRttNextHopMap(
        seedTopology: RallarRtcTopologyKind,
        activeSessionIds: readonly string[],
        options: RallarRtcTopologyServiceOptions,
    ): Record<string, readonly string[]> {
        if (seedTopology === 'mesh') {
            return this.createNoRttMeshNextHopMap(activeSessionIds, options);
        }
        if (seedTopology === 'tree') {
            return createNoRttTreeNextHopMap(
                activeSessionIds,
                this.degreeLimit(options),
            );
        }
        return this.createStarNextHopMap(activeSessionIds);
    }

    private readTopologyOptions(
        updateOptions: RallarRtcTopologyUpdateOptions,
    ): RallarRtcTopologyServiceOptions {
        if (updateOptions.topologyOptions === undefined) {
            return this.options;
        }

        return {
            ...this.options,
            ...updateOptions.topologyOptions,
            rttRebuildDebounceMs: this.options.rttRebuildDebounceMs,
        };
    }

    private meshArgs(options: RallarRtcTopologyServiceOptions): GlobalMeshArgs {
        return {
            meshParamK: options.meshParamK ?? DEFAULT_MESH_PARAM_K,
            insertAlgo: DynamicMeshAlgo.K_INSERT_MC,
            removeAlgo: DynamicMeshAlgo.K_REMOVE_MC,
            diameterBound: Number.POSITIVE_INFINITY,
            reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO,
        };
    }

    private degreeLimit(options: RallarRtcTopologyServiceOptions): number {
        return options.degreeLimit ?? DEFAULT_DEGREE_LIMIT;
    }

    private treeMinSize(options: RallarRtcTopologyServiceOptions): number {
        return options.treeMinSize ?? DEFAULT_TREE_MIN_SIZE;
    }

    private meshMinSize(options: RallarRtcTopologyServiceOptions): number {
        return options.meshMinSize ?? DEFAULT_MESH_MIN_SIZE;
    }

    readKindHysteresisWidths(): RtcTopologyKindHysteresisWidths {
        return {
            meshExitWidth: this.meshExitWidth(),
            treeExitWidth: this.treeExitWidth(),
        };
    }

    private meshExitWidth(): number {
        return Math.max(0, this.options.meshExitWidth ?? DEFAULT_MESH_EXIT_WIDTH);
    }

    private treeExitWidth(): number {
        return Math.max(0, this.options.treeExitWidth ?? DEFAULT_TREE_EXIT_WIDTH);
    }

    private rttRebuildDebounceMs(): number {
        return Math.max(
            0,
            this.options.rttRebuildDebounceMs ??
            DEFAULT_RTT_REBUILD_DEBOUNCE_MS,
        );
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private durationNowMs(): number {
        return globalThis.performance?.now() ?? Date.now();
    }
}

function filterRttMeasurementsForActiveSessions(
    rttMeasurements: readonly RttMeasurementInfo[],
    activeSessionIds: readonly string[],
): readonly RttMeasurementInfo[] {
    if (rttMeasurements.length === 0) {
        return rttMeasurements;
    }

    const activeSessionIdSet = new Set(activeSessionIds);
    return rttMeasurements.filter((rtt) =>
        activeSessionIdSet.has(rtt.sessionIdFrom) &&
        activeSessionIdSet.has(rtt.sessionIdTo)
    );
}

function addCompleteFallbackRoomEdges(
    graph: WeightedGraph,
    activeSessionIds: readonly string[],
    rttBySessionId: RttWeightLookup | undefined,
): void {
    for (let i = 0; i < activeSessionIds.length; i++) {
        for (let j = i + 1; j < activeSessionIds.length; j++) {
            const from = activeSessionIds[i];
            const to = activeSessionIds[j];
            graph.addEdge(from, to, {
                from,
                to,
                weight: readRttWeight(rttBySessionId, from, to) ??
                    computeCanonicalTopologyPairWeight(from, to),
            });
        }
    }
}

function createFallbackRoomGraph(
    group: GroupSnapshot,
    activeSessionIds: readonly string[],
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>,
    degreeLimit: number,
): WeightedGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes({
        id: toScopedOverlayId(group.group),
        version: group.group.snapshotVersion,
        degreeLimitMember: degreeLimit,
        degreeLimitSteiner: degreeLimit,
    });

    for (const sessionId of activeSessionIds) {
        graph.addNode(sessionId, {
            id: sessionId,
            type: VertexType.CLIENT,
            state: VertexState.MEMBER,
            degreeLimit,
        });
    }

    for (const [from, nextHops] of Object.entries(nextHopsBySessionId)) {
        for (const to of nextHops) {
            addRoomEdgeIfAbsent(
                graph,
                from,
                to,
                computeCanonicalTopologyPairWeight(from, to),
            );
        }
    }

    return graph;
}

type WeightedRoomEdge = Readonly<{
    from: string;
    to: string;
    weight: number;
    version: number;
}>;

function createSortedRttEdges(
    rttMeasurements: readonly RttMeasurementInfo[],
    activeSessionIds: readonly string[],
): readonly WeightedRoomEdge[] {
    const activeSessionIdSet = new Set(activeSessionIds);
    const edgeByPair = new Map<string, WeightedRoomEdge>();

    for (const rtt of rttMeasurements) {
        if (
            !activeSessionIdSet.has(rtt.sessionIdFrom) ||
            !activeSessionIdSet.has(rtt.sessionIdTo) ||
            !Number.isFinite(rtt.rttMs) ||
            rtt.rttMs <= 0
        ) {
            continue;
        }

        const [from, to] = compareRtcTopologyIdentifiers(
                rtt.sessionIdFrom,
                rtt.sessionIdTo,
            ) <= 0
            ? [rtt.sessionIdFrom, rtt.sessionIdTo]
            : [rtt.sessionIdTo, rtt.sessionIdFrom];
        const key = toCanonicalRtcTopologyPairIdentity(from, to);
        const current = edgeByPair.get(key);
        if (current && current.version >= rtt.version) {
            continue;
        }

        edgeByPair.set(key, {
            from,
            to,
            weight: rtt.rttMs,
            version: rtt.version,
        });
    }

    return [...edgeByPair.values()].sort((left, right) =>
        left.weight - right.weight ||
        compareRtcTopologyIdentifiers(left.from, right.from) ||
        compareRtcTopologyIdentifiers(left.to, right.to)
    );
}

function addBoundedRoomEdge(
    graph: WeightedGraph,
    from: string,
    to: string,
    weight: number,
    degreeLimit: number,
    maxEdges: number,
): boolean {
    if (graph.size >= maxEdges || graph.hasEdge(from, to)) {
        return false;
    }
    if (graph.degree(from) >= degreeLimit || graph.degree(to) >= degreeLimit) {
        return false;
    }

    addRoomEdgeIfAbsent(graph, from, to, weight);
    return true;
}

function addRoomEdgeIfAbsent(
    graph: WeightedGraph,
    from: string,
    to: string,
    weight: number,
): void {
    if (from === to || graph.hasEdge(from, to)) {
        return;
    }
    graph.addEdge(from, to, {
        from,
        to,
        weight,
    });
}

function isConnectedRoomGraph(
    graph: WeightedGraph,
    activeSessionIds: readonly string[],
): boolean {
    if (activeSessionIds.length <= 1) {
        return true;
    }

    const [first] = activeSessionIds;
    const seen = new Set<string>([first]);
    const queue = [first];

    for (let index = 0; index < queue.length; index++) {
        for (const neighbor of graph.neighbors(queue[index]) as string[]) {
            if (seen.has(neighbor)) {
                continue;
            }
            seen.add(neighbor);
            queue.push(neighbor);
        }
    }

    return seen.size === activeSessionIds.length;
}

type RttWeightLookup = ReadonlyMap<string, ReadonlyMap<string, number>>;

function createRttWeightLookup(
    rttMeasurements: readonly RttMeasurementInfo[],
): RttWeightLookup {
    const lookup = new Map<string, Map<string, number>>();

    for (const rtt of rttMeasurements) {
        setRttWeight(
            lookup,
            rtt.sessionIdFrom,
            rtt.sessionIdTo,
            rtt.rttMs,
        );
        setRttWeight(
            lookup,
            rtt.sessionIdTo,
            rtt.sessionIdFrom,
            rtt.rttMs,
        );
    }

    return lookup;
}

function setRttWeight(
    lookup: Map<string, Map<string, number>>,
    from: string,
    to: string,
    rttMs: number,
): void {
    let byPeer = lookup.get(from);
    if (byPeer === undefined) {
        byPeer = new Map();
        lookup.set(from, byPeer);
    }
    byPeer.set(to, rttMs);
}

function readRttWeight(
    lookup: RttWeightLookup | undefined,
    from: string,
    to: string,
): number | undefined {
    return lookup?.get(from)?.get(to);
}

type NoRttTreeState = {
    readonly nearBySessionId: Map<string, string | undefined>;
    readonly eccentricityBySessionId: Map<string, number>;
    readonly distanceBySessionId: Map<string, Map<string, number>>;
    readonly notInTree: Set<string>;
    readonly treeNodeOrder: string[];
    readonly nextHopsBySessionId: Map<string, Set<string>>;
    nearest: NoRttNearestChoice;
};

type NoRttNearestChoice = {
    readonly node?: string;
    readonly score: number;
};

function createNoRttTreeNextHopMap(
    activeSessionIds: readonly string[],
    degreeLimit: number,
): Record<string, readonly string[]> {
    // Mirrors createGroupTree + mddlOTTC for fallback weights without materializing
    // the complete Graphology room graph.
    if (activeSessionIds.length === 0) {
        return {};
    }

    if (activeSessionIds.length === 1) {
        return {
            [activeSessionIds[0]]: [],
        };
    }

    const source = pickNoRttTreeSource(activeSessionIds);
    const state = initializeNoRttTreeState(activeSessionIds, source);

    if (state.nearest.node === undefined) {
        return noRttTreeNextHopRecord(activeSessionIds, state.nextHopsBySessionId);
    }

    addNoRttTreeNode(state, source);
    state.eccentricityBySessionId.set(source, 0);
    setNoRttTreeDistance(state, source, source, 0);
    state.notInTree.delete(source);

    while (state.notInTree.size > 0) {
        const next = state.nearest.node;
        if (next === undefined) break;

        const parent = state.nearBySessionId.get(next);
        if (parent === undefined || !state.nextHopsBySessionId.has(parent)) {
            break;
        }

        attachNoRttTreeVertex(state, next, parent, degreeLimit);
        state.notInTree.delete(next);

        if (state.notInTree.size === 0) {
            break;
        }

        recomputeNoRttTreeNear(state, degreeLimit);
        state.nearest = selectNoRttTreeNearestVertex(state, degreeLimit);
    }

    return noRttTreeNextHopRecord(activeSessionIds, state.nextHopsBySessionId);
}

function pickNoRttTreeSource(activeSessionIds: readonly string[]): string {
    // Mirrors createGroupTree's source pick (mean direct edge weight over the
    // complete fallback graph, best first) without materializing the graph.
    let selected = activeSessionIds[0];
    let selectedScore = Number.POSITIVE_INFINITY;

    for (const sessionId of activeSessionIds) {
        let score = 0;
        for (const otherSessionId of activeSessionIds) {
            if (otherSessionId === sessionId) continue;
            score += computeCanonicalTopologyPairWeight(sessionId, otherSessionId);
        }

        if (
            score < selectedScore ||
            (
                score === selectedScore &&
                compareRtcTopologyIdentifiers(sessionId, selected) < 0
            )
        ) {
            selected = sessionId;
            selectedScore = score;
        }
    }

    return selected;
}

function initializeNoRttTreeState(
    activeSessionIds: readonly string[],
    source: string,
): NoRttTreeState {
    const nearBySessionId = new Map<string, string | undefined>();
    const eccentricityBySessionId = new Map<string, number>();
    const distanceBySessionId = new Map<string, Map<string, number>>();
    const notInTree = new Set(activeSessionIds);
    let nearest: NoRttNearestChoice = {
        node: undefined,
        score: Number.POSITIVE_INFINITY,
    };

    for (const sessionId of activeSessionIds) {
        eccentricityBySessionId.set(sessionId, 0);

        if (sessionId === source) {
            nearBySessionId.set(sessionId, source);
        } else {
            nearBySessionId.set(sessionId, source);
            const weight = noRttTreeWeight(sessionId, source);
            if (weight < nearest.score) {
                nearest = { node: sessionId, score: weight };
            }
        }

        const row = new Map<string, number>();
        for (const otherSessionId of activeSessionIds) {
            row.set(otherSessionId, 0);
        }
        distanceBySessionId.set(sessionId, row);
    }

    return {
        nearBySessionId,
        eccentricityBySessionId,
        distanceBySessionId,
        notInTree,
        treeNodeOrder: [],
        nextHopsBySessionId: new Map(),
        nearest,
    };
}

function addNoRttTreeNode(state: NoRttTreeState, sessionId: string): void {
    if (state.nextHopsBySessionId.has(sessionId)) return;
    state.nextHopsBySessionId.set(sessionId, new Set());
    state.treeNodeOrder.push(sessionId);
}

function attachNoRttTreeVertex(
    state: NoRttTreeState,
    sessionId: string,
    parentSessionId: string,
    degreeLimit: number,
): void {
    addNoRttTreeNode(state, sessionId);
    state.nextHopsBySessionId.get(sessionId)?.add(parentSessionId);
    state.nextHopsBySessionId.get(parentSessionId)?.add(sessionId);

    const parentDegree = state.nextHopsBySessionId.get(parentSessionId)?.size ?? 0;
    if (parentDegree > degreeLimit) {
        throw new Error(`Degree bound exceeded for ${parentSessionId}`);
    }

    updateNoRttTreeDistancesAfterAttach(state, sessionId, parentSessionId);
}

function updateNoRttTreeDistancesAfterAttach(
    state: NoRttTreeState,
    sessionId: string,
    parentSessionId: string,
): void {
    const weight = noRttTreeWeight(sessionId, parentSessionId);

    for (const treeSessionId of state.treeNodeOrder) {
        const parentToTreeSession = readNoRttTreeDistance(
            state,
            parentSessionId,
            treeSessionId,
        );
        if (parentToTreeSession > 0) {
            setNoRttTreeDistance(
                state,
                sessionId,
                treeSessionId,
                parentToTreeSession + weight,
            );
        }
    }

    setNoRttTreeDistance(state, sessionId, sessionId, 0);
    state.eccentricityBySessionId.set(
        sessionId,
        (state.eccentricityBySessionId.get(parentSessionId) ?? 0) + weight,
    );

    setNoRttTreeDistance(state, parentSessionId, sessionId, weight);
    if ((state.eccentricityBySessionId.get(parentSessionId) ?? 0) <= 0) {
        state.eccentricityBySessionId.set(parentSessionId, weight);
    }

    for (const treeSessionId of state.treeNodeOrder) {
        const treeSessionToParent = readNoRttTreeDistance(
            state,
            treeSessionId,
            parentSessionId,
        );
        setNoRttTreeDistance(
            state,
            treeSessionId,
            sessionId,
            treeSessionToParent + weight,
        );
        state.eccentricityBySessionId.set(
            treeSessionId,
            Math.max(
                state.eccentricityBySessionId.get(treeSessionId) ?? 0,
                readNoRttTreeDistance(state, treeSessionId, sessionId),
            ),
        );
    }
}

function recomputeNoRttTreeNear(
    state: NoRttTreeState,
    degreeLimit: number,
): void {
    for (const sessionId of state.notInTree) {
        let bestParent: string | undefined;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const inTreeSessionId of state.treeNodeOrder) {
            const inTreeDegree =
                state.nextHopsBySessionId.get(inTreeSessionId)?.size ?? 0;
            if (inTreeDegree >= degreeLimit) continue;

            const weight = noRttTreeWeight(sessionId, inTreeSessionId);
            const score =
                (state.eccentricityBySessionId.get(inTreeSessionId) ?? 0) +
                weight;

            if (score < bestScore) {
                bestParent = inTreeSessionId;
                bestScore = score;
            }
        }

        state.nearBySessionId.set(sessionId, bestParent);
    }
}

function selectNoRttTreeNearestVertex(
    state: NoRttTreeState,
    degreeLimit: number,
): NoRttNearestChoice {
    let nearest: NoRttNearestChoice = {
        node: undefined,
        score: Number.POSITIVE_INFINITY,
    };
    let hasDegreeBrokenCandidate = false;

    for (const sessionId of state.notInTree) {
        const nearSessionId = state.nearBySessionId.get(sessionId);
        if (nearSessionId === undefined) continue;

        const outDegree = state.nextHopsBySessionId.get(nearSessionId)?.size ?? 0;
        const weight = noRttTreeWeight(sessionId, nearSessionId);
        const score =
            (state.eccentricityBySessionId.get(nearSessionId) ?? 0) + weight;

        if (outDegree < degreeLimit && score < nearest.score) {
            nearest = { node: sessionId, score };
        }

        if (outDegree >= degreeLimit) {
            hasDegreeBrokenCandidate = true;
        }
    }

    return nearest.node !== undefined || !hasDegreeBrokenCandidate
        ? nearest
        : { node: undefined, score: Number.POSITIVE_INFINITY };
}

function noRttTreeNextHopRecord(
    activeSessionIds: readonly string[],
    nextHopsBySessionId: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, readonly string[]> {
    return Object.fromEntries(
        activeSessionIds.map((sessionId) => [
            sessionId,
            [...(nextHopsBySessionId.get(sessionId) ?? [])].sort(),
        ]),
    );
}

function noRttTreeWeight(left: string, right: string): number {
    return computeCanonicalTopologyPairWeight(left, right);
}

function readNoRttTreeDistance(
    state: NoRttTreeState,
    left: string,
    right: string,
): number {
    return state.distanceBySessionId.get(left)?.get(right) ?? 0;
}

function setNoRttTreeDistance(
    state: NoRttTreeState,
    left: string,
    right: string,
    value: number,
): void {
    let row = state.distanceBySessionId.get(left);
    if (row === undefined) {
        row = new Map();
        state.distanceBySessionId.set(left, row);
    }
    row.set(right, value);
}

/**
 * Order-sensitive by design: published next-hop arrays are a canonical-order
 * contract (`assertCanonicalIdentifiers`), and the persisted semantic-equality
 * check compares them index-wise. An ordering change must therefore register
 * as `changed` and bump the version — a same-version byte change at an equal
 * causal tuple reads as snapshot corruption downstream.
 */
function isSameNextHopMap(
    left: Readonly<Record<string, readonly string[]>>,
    right: Readonly<Record<string, readonly string[]>>,
): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    for (let i = 0; i < leftKeys.length; i++) {
        const key = leftKeys[i];
        if (key !== rightKeys[i]) {
            return false;
        }

        if (!sameStringArray(left[key], right[key])) {
            return false;
        }
    }

    return true;
}

function sameStringArray(
    left: readonly string[],
    right: readonly string[],
): boolean {
    return left.length === right.length &&
        left.every((value, index) => value === right[index]);
}
