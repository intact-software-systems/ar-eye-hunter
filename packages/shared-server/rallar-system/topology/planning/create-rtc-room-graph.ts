import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';
import {
  type EdgeProp,
  type GraphProp,
  type VertexProp,
  VertexState,
  VertexType,
  type WeightedGraph,
} from '@shared-graph/graph-props.ts';
import { UndirectedGraph } from 'graphology';

import {
  compareRtcTopologyIdentifiers,
  toCanonicalRtcTopologyPairIdentity,
} from '../../rtc-topology-identifiers.ts';
import { computeNoRttTopologyNextHops } from './compute-no-rtt-topology-next-hops.ts';
import { computeCanonicalTopologyPairWeight } from './canonical-topology-planning-input.ts';

export interface CreateRtcRoomGraphInput {
  readonly group: GroupSnapshot;
  readonly activeSessionIds: readonly string[];
  readonly rttMeasurements: readonly RttMeasurementInfo[];
  readonly degreeLimit: number;
  readonly rttReportingDegreeLimit: number;
  readonly seedTopology: RallarRtcTopologyKind;
  readonly meshParamK: number;
}

export interface CreateRtcRoomGraphResult {
  readonly graph: WeightedGraph;
  readonly usedSparseFallback: boolean;
}

interface CreateFallbackRoomGraphInput {
  readonly group: GroupSnapshot;
  readonly activeSessionIds: readonly string[];
  readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
  readonly degreeLimit: number;
}

interface PopulateSparseRoomGraphInput {
  readonly graph: WeightedGraph;
  readonly activeSessionIds: readonly string[];
  readonly rttMeasurements: readonly RttMeasurementInfo[];
  readonly fallbackNextHops: Readonly<Record<string, readonly string[]>>;
  readonly degreeLimit: number;
}

interface AddBoundedRoomEdgeInput {
  readonly graph: WeightedGraph;
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly degreeLimit: number;
  readonly maxEdges: number;
}

interface AddRoomEdgeIfAbsentInput {
  readonly graph: WeightedGraph;
  readonly from: string;
  readonly to: string;
  readonly weight: number;
}

interface SetRttWeightInput {
  readonly lookup: Map<string, Map<string, number>>;
  readonly from: string;
  readonly to: string;
  readonly rttMs: number;
}

interface WeightedRoomEdge {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly version: number;
}

type RttWeightLookup = ReadonlyMap<string, ReadonlyMap<string, number>>;

export function createRtcRoomGraph(input: CreateRtcRoomGraphInput): CreateRtcRoomGraphResult {
  const graph = createRoomGraph(input.group, input.activeSessionIds, input.degreeLimit);
  const rttBySessionId =
    input.rttMeasurements.length > 0 ? createRttWeightLookup(input.rttMeasurements) : undefined;

  if (input.rttMeasurements.length === 0) {
    addCompleteFallbackRoomEdges(graph, input.activeSessionIds, rttBySessionId);
    return { graph, usedSparseFallback: false };
  }

  const fallbackNextHops = computeNoRttTopologyNextHops({
    topology: input.seedTopology,
    activeSessionIds: input.activeSessionIds,
    degreeLimit: input.degreeLimit,
    meshParamK: input.meshParamK,
  });
  const sparse = populateSparseRoomGraph({
    graph,
    activeSessionIds: input.activeSessionIds,
    rttMeasurements: input.rttMeasurements,
    fallbackNextHops,
    degreeLimit: input.rttReportingDegreeLimit,
  });

  if (!sparse.connected) {
    return {
      graph: createFallbackRoomGraph({
        group: input.group,
        activeSessionIds: input.activeSessionIds,
        nextHopsBySessionId: fallbackNextHops,
        degreeLimit: input.degreeLimit,
      }),
      usedSparseFallback: true,
    };
  }

  return { graph, usedSparseFallback: false };
}

function createRoomGraph(
  group: GroupSnapshot,
  activeSessionIds: readonly string[],
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
  return graph;
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

function createFallbackRoomGraph(input: CreateFallbackRoomGraphInput): WeightedGraph {
  const graph = createRoomGraph(input.group, input.activeSessionIds, input.degreeLimit);
  for (const [from, nextHops] of Object.entries(input.nextHopsBySessionId)) {
    for (const to of nextHops) {
      addRoomEdgeIfAbsent({
        graph,
        from,
        to,
        weight: computeCanonicalTopologyPairWeight(from, to),
      });
    }
  }
  return graph;
}

function populateSparseRoomGraph(
  input: PopulateSparseRoomGraphInput,
): Readonly<{ connected: boolean }> {
  const maxEdges = Math.floor((input.activeSessionIds.length * input.degreeLimit) / 2);
  for (const edge of createSortedRttEdges(input.rttMeasurements, input.activeSessionIds)) {
    addBoundedRoomEdge({
      graph: input.graph,
      from: edge.from,
      to: edge.to,
      weight: edge.weight,
      degreeLimit: input.degreeLimit,
      maxEdges,
    });
  }
  for (const [from, nextHops] of Object.entries(input.fallbackNextHops)) {
    for (const to of nextHops) {
      addBoundedRoomEdge({
        graph: input.graph,
        from,
        to,
        weight: computeCanonicalTopologyPairWeight(from, to),
        degreeLimit: input.degreeLimit,
        maxEdges,
      });
    }
  }
  if (!isConnectedRoomGraph(input.graph, input.activeSessionIds)) {
    return { connected: false };
  }
  for (let i = 0; i < input.activeSessionIds.length; i++) {
    for (let j = i + 1; j < input.activeSessionIds.length; j++) {
      if (input.graph.size >= maxEdges) {
        return { connected: true };
      }
      const from = input.activeSessionIds[i];
      const to = input.activeSessionIds[j];
      addBoundedRoomEdge({
        graph: input.graph,
        from,
        to,
        weight: computeCanonicalTopologyPairWeight(from, to),
        degreeLimit: input.degreeLimit,
        maxEdges,
      });
    }
  }
  return { connected: true };
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
    edgeByPair.set(key, { from, to, weight: rtt.rttMs, version: rtt.version });
  }
  return [...edgeByPair.values()].sort(
    (left, right) =>
      left.weight - right.weight ||
      compareRtcTopologyIdentifiers(left.from, right.from) ||
      compareRtcTopologyIdentifiers(left.to, right.to),
  );
}

function addBoundedRoomEdge(input: AddBoundedRoomEdgeInput): boolean {
  if (
    input.graph.size >= input.maxEdges ||
    input.graph.hasEdge(input.from, input.to) ||
    input.graph.degree(input.from) >= input.degreeLimit ||
    input.graph.degree(input.to) >= input.degreeLimit
  ) {
    return false;
  }
  addRoomEdgeIfAbsent(input);
  return true;
}

function addRoomEdgeIfAbsent(input: AddRoomEdgeIfAbsentInput): void {
  if (input.from === input.to || input.graph.hasEdge(input.from, input.to)) {
    return;
  }
  input.graph.addEdge(input.from, input.to, {
    from: input.from,
    to: input.to,
    weight: input.weight,
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
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return seen.size === activeSessionIds.length;
}

function createRttWeightLookup(rttMeasurements: readonly RttMeasurementInfo[]): RttWeightLookup {
  const lookup = new Map<string, Map<string, number>>();
  for (const rtt of rttMeasurements) {
    setRttWeight({ lookup, from: rtt.sessionIdFrom, to: rtt.sessionIdTo, rttMs: rtt.rttMs });
    setRttWeight({ lookup, from: rtt.sessionIdTo, to: rtt.sessionIdFrom, rttMs: rtt.rttMs });
  }
  return lookup;
}

function setRttWeight(input: SetRttWeightInput): void {
  let byPeer = input.lookup.get(input.from);
  if (byPeer === undefined) {
    byPeer = new Map();
    input.lookup.set(input.from, byPeer);
  }
  byPeer.set(input.to, input.rttMs);
}

function readRttWeight(
  lookup: RttWeightLookup | undefined,
  from: string,
  to: string,
): number | undefined {
  return lookup?.get(from)?.get(to);
}
