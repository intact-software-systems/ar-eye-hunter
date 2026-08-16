import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupTopologyKindSetting } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import {
  compareOverlayTopologyCausalTuple,
  type RallarOverlayTopologySnapshot,
  type RallarRtcTopologyKind,
} from '@shared/api/overlay-topology.ts';
import { normalizeRttReportingDegreeLimit } from '@shared/rtc/rtt-reporting-policy.ts';
import { ReconfigAlgo } from '@shared-graph/algo-props.ts';
import { createGroupMesh, type GlobalMeshArgs } from '@shared-graph/graphs-mesh-service.ts';
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

import {
  compareRtcTopologyIdentifiers,
  toCanonicalRtcTopologyPairIdentity,
} from '../rtc-topology-identifiers.ts';
import {
  computeCanonicalTopologyPairWeight,
  toCanonicalTopologySessionIds,
} from '../topology/planning/canonical-topology-planning-input.ts';
import { computeNoRttTopologyNextHops } from '../topology/planning/compute-no-rtt-topology-next-hops.ts';
import { computeEvolvedTopologyNextHops } from '../topology/planning/evolve-planned-topology.ts';
import { planRallarRtcTopologySnapshot } from '../topology/planning/plan-rallar-rtc-topology-snapshot.ts';
import {
  DEFAULT_MESH_EXIT_WIDTH,
  DEFAULT_TREE_EXIT_WIDTH,
  resolveTopologyKindWithHysteresis,
} from '../topology/planning/topology-kind-hysteresis.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import {
  RtcTopologyMetrics,
  type RallarRtcTopologyMetrics,
} from '../topology/rallar-rtc-topology-metrics.ts';

export interface RallarRtcTopologyServiceOptions {
  readonly topologyKind?: GroupTopologyKindSetting;
  readonly degreeLimit?: number;
  readonly rttReportingDegreeLimit?: number;
  readonly treeMinSize?: number;
  readonly meshMinSize?: number;
  readonly meshParamK?: number;
  readonly meshExitWidth?: number;
  readonly treeExitWidth?: number;
  readonly rttRebuildDebounceMs?: number;
  readonly now?: () => number;
}

export interface RallarRtcTopologyUpdateResult {
  readonly snapshot: RallarOverlayTopologySnapshot;
  readonly changed: boolean;
  readonly previous: RallarOverlayTopologySnapshot | null;
}

export interface RallarRtcTopologyUpdateOptions {
  readonly previous?: RallarOverlayTopologySnapshot;
  readonly topologyOptions?: RallarRtcTopologyServiceOptions;
  readonly planningIntent?: RtcTopologyPlanningIntent;
}

/**
 * `membership-delta` work (the coalesced group-revision path) may evolve the
 * previous accepted graph incrementally; every other trigger — explicit
 * reconfigure, RTT refresh — plans a full rebuild, which is also the periodic
 * bound on incremental drift.
 */
export type RtcTopologyPlanningIntent = 'membership-delta' | 'full-rebuild';

export interface RtcTopologyKindHysteresisWidths {
  readonly meshExitWidth: number;
  readonly treeExitWidth: number;
}

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

interface SparseRoomGraphPopulationResult {
  readonly connected: boolean;
}

export { planRallarRtcTopologySnapshot } from '../topology/planning/plan-rallar-rtc-topology-snapshot.ts';

export interface RallarRtcTopologyRttQueueResult {
  readonly overlayId: string;
  readonly dueAtEpochMs: number;
  readonly delayMs: number;
  readonly newlyQueued: boolean;
  readonly immediate: boolean;
}

const DEFAULT_DEGREE_LIMIT = 5;
const DEFAULT_TREE_MIN_SIZE = 5;
const DEFAULT_MESH_MIN_SIZE = 16;
const DEFAULT_MESH_PARAM_K = 2;
const DEFAULT_RTT_REBUILD_DEBOUNCE_MS = 250;

export class RallarRtcTopologyService {
  private readonly snapshotsByOverlayId = new Map<string, RallarOverlayTopologySnapshot>();
  private readonly pendingRttUpdateDueAtByOverlayId = new Map<string, number>();
  private readonly metrics = new RtcTopologyMetrics();

  private readonly options: RallarRtcTopologyServiceOptions;

  constructor(options: RallarRtcTopologyServiceOptions = {}) {
    this.options = options;
  }

  readMetrics(): RallarRtcTopologyMetrics {
    return this.metrics.read(
      this.snapshotsByOverlayId.size,
      this.pendingRttUpdateDueAtByOverlayId.size,
    );
  }

  resetMetrics(): void {
    this.metrics.reset();
  }

  observeTopologySnapshot(snapshot: RallarOverlayTopologySnapshot): boolean {
    const current = this.snapshotsByOverlayId.get(snapshot.overlayId);
    const comparison = current ? compareOverlayTopologyCausalTuple(snapshot, current) : null;
    if (!current || comparison === 'dominates') {
      this.snapshotsByOverlayId.set(snapshot.overlayId, snapshot);
      return true;
    }
    if (comparison === 'equal' && !rtcTopologySemanticEqual(snapshot, current)) {
      throw new Error(`RTC topology process-cache revision conflict: ${snapshot.overlayId}`);
    }
    if (comparison === 'incomparable') {
      throw new Error(`RTC topology process-cache causal conflict: ${snapshot.overlayId}`);
    }
    return false;
  }

  recordTopologyPublishResult(changed: boolean): void {
    this.metrics.recordPublish(changed);
  }

  recordTopologyRebuildSkippedFingerprint(): void {
    this.metrics.recordFingerprintSkip();
  }

  updateGroupTopology(
    group: GroupSnapshot,
    rttMeasurements: readonly RttMeasurementInfo[] = [],
    options: RallarRtcTopologyUpdateOptions = {},
  ): RallarRtcTopologyUpdateResult {
    const result = this.planGroupTopology(group, rttMeasurements, options);
    this.observeCommittedTopologySnapshot(result.snapshot);
    return result;
  }

  observeCommittedTopologySnapshot(snapshot: RallarOverlayTopologySnapshot): boolean {
    const changed = this.observeTopologySnapshot(snapshot);
    this.pendingRttUpdateDueAtByOverlayId.delete(snapshot.overlayId);
    return changed;
  }

  planGroupTopology(
    group: GroupSnapshot,
    rttMeasurements: readonly RttMeasurementInfo[] = [],
    options: RallarRtcTopologyUpdateOptions = {},
  ): RallarRtcTopologyUpdateResult {
    return this.planGroupTopologyAt(group, rttMeasurements, options, this.now());
  }

  planGroupTopologyAt(
    group: GroupSnapshot,
    rttMeasurements: readonly RttMeasurementInfo[],
    options: RallarRtcTopologyUpdateOptions,
    nowEpochMs: number,
  ): RallarRtcTopologyUpdateResult {
    const activeSessionIds = toCanonicalTopologySessionIds(readGroupMemberSessionIds(group));
    const relevantRttMeasurements = filterRttMeasurementsForActiveSessions(
      rttMeasurements,
      activeSessionIds,
    );
    this.metrics.recordTopologyUpdate(relevantRttMeasurements.length);

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
    this.metrics.recordTopologyResult(result.changed);
    return result;
  }

  removeGroupTopology(group: GroupSnapshot): boolean {
    const overlayId = toScopedOverlayId(group.group);
    this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
    const removed = this.snapshotsByOverlayId.delete(overlayId);
    this.metrics.recordRemoval(removed);
    return removed;
  }

  readSnapshot(group: GroupSnapshot): RallarOverlayTopologySnapshot | undefined {
    return this.snapshotsByOverlayId.get(toScopedOverlayId(group.group));
  }

  queueRttTopologyUpdate(group: GroupSnapshot): RallarRtcTopologyRttQueueResult {
    const overlayId = toScopedOverlayId(group.group);
    const now = this.now();
    const existingDueAt = this.pendingRttUpdateDueAtByOverlayId.get(overlayId);

    if (existingDueAt !== undefined) {
      this.metrics.recordRttQueue('coalesced', existingDueAt <= now);
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
    this.metrics.recordRttQueue('new', dueAtEpochMs <= now);

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
    const overlayId = toScopedOverlayId(groupRef);
    const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(overlayId);
    if (dueAtEpochMs === undefined || dueAtEpochMs > this.now()) {
      this.metrics.recordRttFlush(false);
      return false;
    }

    this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
    this.metrics.recordRttFlush(true);
    return true;
  }

  readRttTopologyUpdateDelayMs(group: GroupSnapshot): number | undefined {
    const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(toScopedOverlayId(group.group));
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

  readRttReportingDegreeLimit(options: RallarRtcTopologyServiceOptions = this.options): number {
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
      this.metrics.recordHysteresisHold();
    }
    return topology;
  }

  private computePlannedNextHops(plan: RtcTopologyPlanInput): Record<string, readonly string[]> {
    if (plan.topology === 'star') {
      const startedAtMs = this.durationNowMs();
      const nextHopsBySessionId = computeNoRttTopologyNextHops({
        topology: plan.topology,
        activeSessionIds: plan.activeSessionIds,
        degreeLimit: this.degreeLimit(plan.topologyOptions),
        meshParamK: this.meshArgs(plan.topologyOptions).meshParamK,
      });
      this.metrics.recordStarPlan(this.durationNowMs() - startedAtMs);
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
      this.metrics.recordIncrementalFallback(evolved.reason);
      return undefined;
    }

    this.metrics.recordIncrementalPlan();
    return evolved.nextHopsBySessionId;
  }

  private computeNoRttNextHops(plan: RtcTopologyPlanInput): Record<string, readonly string[]> {
    const startedAtMs = this.durationNowMs();
    const nextHopsBySessionId = computeNoRttTopologyNextHops({
      topology: plan.topology,
      activeSessionIds: plan.activeSessionIds,
      degreeLimit: this.degreeLimit(plan.topologyOptions),
      meshParamK: this.meshArgs(plan.topologyOptions).meshParamK,
    });
    if (plan.topology === 'tree') {
      this.metrics.recordNoRttTreePlan(this.durationNowMs() - startedAtMs);
      return nextHopsBySessionId;
    }

    this.metrics.recordNoRttMeshPlan(this.durationNowMs() - startedAtMs);
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

  private createRoomGraphWithOptions(roomGraphInput: RtcTopologyRoomGraphInput): WeightedGraph {
    const { group, rttMeasurements, options } = roomGraphInput;
    const startedAtMs = this.durationNowMs();
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    const degreeLimit = this.degreeLimit(options);
    const rttReportingDegreeLimit = this.readRttReportingDegreeLimit(options);
    const activeSessionIds = toCanonicalTopologySessionIds(readGroupMemberSessionIds(group));
    const rttBySessionId =
      rttMeasurements.length > 0 ? createRttWeightLookup(rttMeasurements) : undefined;

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
      const fallbackNextHops = computeNoRttTopologyNextHops({
        topology: roomGraphInput.seedTopology,
        activeSessionIds,
        degreeLimit,
        meshParamK: this.meshArgs(options).meshParamK,
      });
      const sparse = this.populateSparseRoomGraph(
        graph,
        activeSessionIds,
        rttMeasurements,
        fallbackNextHops,
        rttReportingDegreeLimit,
      );

      if (!sparse.connected) {
        this.metrics.recordWeightedRoomGraph(this.durationNowMs() - startedAtMs, true);
        return createFallbackRoomGraph(group, activeSessionIds, fallbackNextHops, degreeLimit);
      }
    }

    this.metrics.recordWeightedRoomGraph(this.durationNowMs() - startedAtMs, false);
    return graph;
  }

  private populateSparseRoomGraph(
    graph: WeightedGraph,
    activeSessionIds: readonly string[],
    rttMeasurements: readonly RttMeasurementInfo[],
    fallbackNextHops: Readonly<Record<string, readonly string[]>>,
    degreeLimit: number,
  ): SparseRoomGraphPopulationResult {
    const maxEdges = Math.floor((activeSessionIds.length * degreeLimit) / 2);

    for (const edge of createSortedRttEdges(rttMeasurements, activeSessionIds)) {
      addBoundedRoomEdge(graph, edge.from, edge.to, edge.weight, degreeLimit, maxEdges);
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
          computeCanonicalTopologyPairWeight(activeSessionIds[i], activeSessionIds[j]),
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
    const graph =
      topology === 'tree'
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
        graph.hasNode(sessionId) ? (graph.neighbors(sessionId) as string[]).sort() : [],
      ]),
    );
    this.metrics.recordWeightedPlan(this.durationNowMs() - startedAtMs);
    return nextHopsBySessionId;
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
    return Math.max(0, this.options.rttRebuildDebounceMs ?? DEFAULT_RTT_REBUILD_DEBOUNCE_MS);
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
  return rttMeasurements.filter(
    (rtt) => activeSessionIdSet.has(rtt.sessionIdFrom) && activeSessionIdSet.has(rtt.sessionIdTo),
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
        weight:
          readRttWeight(rttBySessionId, from, to) ?? computeCanonicalTopologyPairWeight(from, to),
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
      addRoomEdgeIfAbsent(graph, from, to, computeCanonicalTopologyPairWeight(from, to));
    }
  }

  return graph;
}

interface WeightedRoomEdge {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly version: number;
}

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

    const [from, to] =
      compareRtcTopologyIdentifiers(rtt.sessionIdFrom, rtt.sessionIdTo) <= 0
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

  return [...edgeByPair.values()].sort(
    (left, right) =>
      left.weight - right.weight ||
      compareRtcTopologyIdentifiers(left.from, right.from) ||
      compareRtcTopologyIdentifiers(left.to, right.to),
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

function addRoomEdgeIfAbsent(graph: WeightedGraph, from: string, to: string, weight: number): void {
  if (from === to || graph.hasEdge(from, to)) {
    return;
  }
  graph.addEdge(from, to, {
    from,
    to,
    weight,
  });
}

function isConnectedRoomGraph(graph: WeightedGraph, activeSessionIds: readonly string[]): boolean {
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

function createRttWeightLookup(rttMeasurements: readonly RttMeasurementInfo[]): RttWeightLookup {
  const lookup = new Map<string, Map<string, number>>();

  for (const rtt of rttMeasurements) {
    setRttWeight(lookup, rtt.sessionIdFrom, rtt.sessionIdTo, rtt.rttMs);
    setRttWeight(lookup, rtt.sessionIdTo, rtt.sessionIdFrom, rtt.rttMs);
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
