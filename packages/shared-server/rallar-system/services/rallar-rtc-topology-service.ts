import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind, } from '@shared/api/overlay-topology.ts';
import {
    readGroupCreatedAtEpochMs,
    readGroupCreatedByPrincipalId,
    readGroupDisplayName,
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
    degreeLimit?: number;
    treeMinSize?: number;
    meshMinSize?: number;
    meshParamK?: number;
    rttRebuildDebounceMs?: number;
    now?: () => number;
}>;

export type RallarRtcTopologyMetrics = Readonly<{
    topologyUpdateCount: number;
    topologyChangedCount: number;
    topologyUnchangedCount: number;
    updatesWithRttMeasurementCount: number;
    updatesWithoutRttMeasurementCount: number;
    starPlanCount: number;
    starPlanDurationMs: number;
    noRttTreePlanCount: number;
    noRttTreePlanDurationMs: number;
    noRttMeshPlanCount: number;
    noRttMeshPlanDurationMs: number;
    weightedPlanCount: number;
    weightedPlanDurationMs: number;
    weightedRoomGraphBuildCount: number;
    weightedRoomGraphBuildDurationMs: number;
    rttQueueRequestCount: number;
    rttQueueNewCount: number;
    rttQueueCoalescedCount: number;
    rttQueueImmediateCount: number;
    rttFlushAttemptCount: number;
    rttFlushSkippedCount: number;
    rttFlushExecutedCount: number;
    topologyPublishAttemptCount: number;
    topologyPublishedCount: number;
    topologyPublishSkippedUnchangedCount: number;
    topologyRemovalRequestCount: number;
    topologyRemovedCount: number;
    topologyRemoveMissCount: number;
    topologySnapshotCount: number;
    pendingRttUpdateCount: number;
}>;

export type RallarRtcTopologyUpdateResult = Readonly<{
    snapshot: RallarOverlayTopologySnapshot;
    changed: boolean;
    previous?: RallarOverlayTopologySnapshot;
}>;

export type RallarRtcTopologyUpdateOptions = Readonly<{
    previous?: RallarOverlayTopologySnapshot;
}>;

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

type MutableRallarRtcTopologyMetrics = {
    -readonly [K in keyof Omit<
        RallarRtcTopologyMetrics,
        'pendingRttUpdateCount' | 'topologySnapshotCount'
    >]: number;
};

const emptyTopologyMetrics = (): MutableRallarRtcTopologyMetrics => ({
    topologyUpdateCount: 0,
    topologyChangedCount: 0,
    topologyUnchangedCount: 0,
    updatesWithRttMeasurementCount: 0,
    updatesWithoutRttMeasurementCount: 0,
    starPlanCount: 0,
    starPlanDurationMs: 0,
    noRttTreePlanCount: 0,
    noRttTreePlanDurationMs: 0,
    noRttMeshPlanCount: 0,
    noRttMeshPlanDurationMs: 0,
    weightedPlanCount: 0,
    weightedPlanDurationMs: 0,
    weightedRoomGraphBuildCount: 0,
    weightedRoomGraphBuildDurationMs: 0,
    rttQueueRequestCount: 0,
    rttQueueNewCount: 0,
    rttQueueCoalescedCount: 0,
    rttQueueImmediateCount: 0,
    rttFlushAttemptCount: 0,
    rttFlushSkippedCount: 0,
    rttFlushExecutedCount: 0,
    topologyPublishAttemptCount: 0,
    topologyPublishedCount: 0,
    topologyPublishSkippedUnchangedCount: 0,
    topologyRemovalRequestCount: 0,
    topologyRemovedCount: 0,
    topologyRemoveMissCount: 0,
});

export class RallarRtcTopologyService {
    private readonly snapshotsByOverlayId = new Map<
        string,
        RallarOverlayTopologySnapshot
    >();
    private readonly pendingRttUpdateDueAtByOverlayId = new Map<string, number>();
    private readonly metrics = emptyTopologyMetrics();

    constructor(
        private readonly options: RallarRtcTopologyServiceOptions = {},
    ) {
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

    recordTopologyPublishResult(changed: boolean): void {
        this.metrics.topologyPublishAttemptCount += 1;
        if (changed) {
            this.metrics.topologyPublishedCount += 1;
        } else {
            this.metrics.topologyPublishSkippedUnchangedCount += 1;
        }
    }

    updateGroupTopology(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {},
    ): RallarRtcTopologyUpdateResult {
        this.metrics.topologyUpdateCount += 1;
        if (rttMeasurements.length > 0) {
            this.metrics.updatesWithRttMeasurementCount += 1;
        } else {
            this.metrics.updatesWithoutRttMeasurementCount += 1;
        }

        const overlayId = toScopedOverlayId(group.group);
        const previous = this.readPreviousSnapshot(overlayId, options);
        const topology = this.selectTopology(group);
        const activeSessionIds = readGroupMemberSessionIds(group);
        let nextHopsBySessionId: Record<string, readonly string[]>;

        if (topology === 'star') {
            const startedAtMs = this.durationNowMs();
            nextHopsBySessionId = this.createStarNextHopMap(activeSessionIds);
            this.metrics.starPlanCount += 1;
            this.metrics.starPlanDurationMs += this.durationNowMs() - startedAtMs;
        } else if (rttMeasurements.length === 0) {
            const startedAtMs = this.durationNowMs();
            if (topology === 'tree') {
                nextHopsBySessionId = createNoRttTreeNextHopMap(
                    activeSessionIds,
                    this.degreeLimit(),
                );
                this.metrics.noRttTreePlanCount += 1;
                this.metrics.noRttTreePlanDurationMs +=
                    this.durationNowMs() - startedAtMs;
            } else {
                nextHopsBySessionId = this.createNoRttMeshNextHopMap(
                    activeSessionIds,
                );
                this.metrics.noRttMeshPlanCount += 1;
                this.metrics.noRttMeshPlanDurationMs +=
                    this.durationNowMs() - startedAtMs;
            }
        } else {
            nextHopsBySessionId = this.createNextHopMap(
                topology,
                group,
                activeSessionIds,
                this.createRoomGraph(group, rttMeasurements),
            );
        }
        const changed = previous === undefined ||
            previous.topology !== topology ||
            !isSameNextHopMap(previous.nextHopsBySessionId, nextHopsBySessionId);
        if (changed) {
            this.metrics.topologyChangedCount += 1;
        } else {
            this.metrics.topologyUnchangedCount += 1;
        }
        const now = this.now();
        const snapshot: RallarOverlayTopologySnapshot = {
            overlayId,
            groupRef: group.group,
            name: readGroupDisplayName(group),
            topology,
            activeSessionIds,
            nextHopsBySessionId,
            degreeLimit: this.degreeLimit(),
            version: changed ? (previous?.version ?? 0) + 1 : previous.version,
            createdByClientId: readGroupCreatedByPrincipalId(group),
            createdAtEpochMs: previous?.createdAtEpochMs ??
                readGroupCreatedAtEpochMs(group),
            updatedAtEpochMs: changed ? now : previous.updatedAtEpochMs,
        };
        const resultSnapshot = changed ? snapshot : previous;

        this.snapshotsByOverlayId.set(overlayId, resultSnapshot);
        this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);

        return {
            snapshot: resultSnapshot,
            changed,
            previous,
        };
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
    ): RallarRtcTopologyUpdateResult | undefined {
        this.metrics.rttFlushAttemptCount += 1;
        const overlayId = toScopedOverlayId(group.group);
        const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(
            overlayId,
        );
        if (dueAtEpochMs === undefined || dueAtEpochMs > this.now()) {
            this.metrics.rttFlushSkippedCount += 1;
            return undefined;
        }

        this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
        this.metrics.rttFlushExecutedCount += 1;
        return this.updateGroupTopology(group, rttMeasurements);
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

    selectTopology(group: GroupSnapshot): RallarRtcTopologyKind {
        const activeSize = readGroupMemberSessionIds(group).length;

        if (activeSize >= this.meshMinSize()) {
            return 'mesh';
        }

        if (activeSize >= this.treeMinSize()) {
            return 'tree';
        }

        return 'star';
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

    createRoomGraph(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
    ): WeightedGraph {
        const startedAtMs = this.durationNowMs();
        this.metrics.weightedRoomGraphBuildCount += 1;
        const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
        const degreeLimit = this.degreeLimit();
        const activeSessionIds = readGroupMemberSessionIds(group);
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

        for (let i = 0; i < activeSessionIds.length; i++) {
            for (let j = i + 1; j < activeSessionIds.length; j++) {
                const from = activeSessionIds[i];
                const to = activeSessionIds[j];
                graph.addEdge(from, to, {
                    from,
                    to,
                    weight: readRttWeight(rttBySessionId, from, to) ??
                        fallbackWeight(i, j),
                });
            }
        }

        this.metrics.weightedRoomGraphBuildDurationMs +=
            this.durationNowMs() - startedAtMs;
        return graph;
    }

    private createNextHopMap(
        topology: RallarRtcTopologyKind,
        group: GroupSnapshot,
        activeSessionIds: readonly string[],
        globalGraph: WeightedGraph,
    ): Record<string, readonly string[]> {
        const startedAtMs = this.durationNowMs();
        this.metrics.weightedPlanCount += 1;
        const graph = topology === 'tree'
            ? createGroupTree({
                group,
                globalGraph,
                maxDegree: this.degreeLimit(),
            }).tree
            : createGroupMesh({
                group,
                globalGraph,
                maxDegree: this.degreeLimit(),
                globalArgs: this.meshArgs(),
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
    ): Record<string, readonly string[]> {
        const targetEdgeCount = this.meshArgs().meshParamK;
        const degreeLimit = this.degreeLimit();
        const insertedSessionIds: string[] = [];
        const nextHopsBySessionId = new Map<string, Set<string>>();

        for (const sessionId of activeSessionIds) {
            if (nextHopsBySessionId.has(sessionId)) continue;

            if (insertedSessionIds.length === 0) {
                nextHopsBySessionId.set(sessionId, new Set());
                insertedSessionIds.push(sessionId);
                continue;
            }

            let hasFeasibleCandidate = false;
            let selectedCount = 0;
            const selectedCandidates: string[] = [];

            for (let i = insertedSessionIds.length - 1; i >= 0; i--) {
                const candidate = insertedSessionIds[i];
                const candidateDegree =
                    nextHopsBySessionId.get(candidate)?.size ?? 0;

                if (candidateDegree >= degreeLimit) continue;

                hasFeasibleCandidate = true;

                if (selectedCount >= targetEdgeCount) continue;

                selectedCandidates.push(candidate);
                selectedCount++;
            }

            if (!hasFeasibleCandidate) break;

            const nextHops = new Set<string>();
            nextHopsBySessionId.set(sessionId, nextHops);
            insertedSessionIds.push(sessionId);

            for (const candidate of selectedCandidates) {
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

    private meshArgs(): GlobalMeshArgs {
        return {
            meshParamK: this.options.meshParamK ?? DEFAULT_MESH_PARAM_K,
            insertAlgo: DynamicMeshAlgo.K_INSERT_MC,
            removeAlgo: DynamicMeshAlgo.K_REMOVE_MC,
            diameterBound: Number.POSITIVE_INFINITY,
            reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO,
        };
    }

    private degreeLimit(): number {
        return this.options.degreeLimit ?? DEFAULT_DEGREE_LIMIT;
    }

    private treeMinSize(): number {
        return this.options.treeMinSize ?? DEFAULT_TREE_MIN_SIZE;
    }

    private meshMinSize(): number {
        return this.options.meshMinSize ?? DEFAULT_MESH_MIN_SIZE;
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

function fallbackWeight(i: number, j: number): number {
    return Math.abs(i - j) + 1;
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
    readonly indexBySessionId: ReadonlyMap<string, number>;
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
    let selected = activeSessionIds[0];
    let selectedScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < activeSessionIds.length; i++) {
        let score = 0;
        for (let j = 0; j < activeSessionIds.length; j++) {
            if (i === j) continue;
            score += Math.abs(i - j);
        }

        const sessionId = activeSessionIds[i];
        if (
            score < selectedScore ||
            (score === selectedScore && sessionId.localeCompare(selected) < 0)
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
    const indexBySessionId = new Map(
        activeSessionIds.map((sessionId, index) => [sessionId, index]),
    );
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
            const weight = noRttTreeWeight(indexBySessionId, sessionId, source);
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
        indexBySessionId,
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
    const weight = noRttTreeWeight(
        state.indexBySessionId,
        sessionId,
        parentSessionId,
    );

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

            const weight = noRttTreeWeight(
                state.indexBySessionId,
                sessionId,
                inTreeSessionId,
            );
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
        const weight = noRttTreeWeight(
            state.indexBySessionId,
            sessionId,
            nearSessionId,
        );
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

function noRttTreeWeight(
    indexBySessionId: ReadonlyMap<string, number>,
    left: string,
    right: string,
): number {
    return fallbackWeight(
        indexBySessionId.get(left) ?? 0,
        indexBySessionId.get(right) ?? 0,
    );
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
    if (left.length !== right.length) {
        return false;
    }

    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
}
