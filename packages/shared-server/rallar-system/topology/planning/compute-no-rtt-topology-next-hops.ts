import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import { compareRtcTopologyIdentifiers } from '../../rtc-topology-identifiers.ts';
import { computeCanonicalTopologyPairWeight } from './canonical-topology-planning-input.ts';

export interface ComputeNoRttTopologyNextHopsInput {
  readonly topology: RallarRtcTopologyKind;
  readonly activeSessionIds: readonly string[];
  readonly degreeLimit: number;
  readonly meshParamK: number;
}

interface NoRttTreeState {
  readonly nearBySessionId: Map<string, string | undefined>;
  readonly eccentricityBySessionId: Map<string, number>;
  readonly distanceBySessionId: Map<string, Map<string, number>>;
  readonly notInTree: Set<string>;
  readonly treeNodeOrder: string[];
  readonly nextHopsBySessionId: Map<string, Set<string>>;
  nearest: NoRttNearestChoice;
}

interface NoRttNearestChoice {
  readonly node?: string;
  readonly score: number;
}

interface AttachNoRttTreeVertexInput {
  readonly state: NoRttTreeState;
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly degreeLimit: number;
}

interface SetNoRttTreeDistanceInput {
  readonly state: NoRttTreeState;
  readonly left: string;
  readonly right: string;
  readonly value: number;
}

export function computeNoRttTopologyNextHops(
  input: ComputeNoRttTopologyNextHopsInput,
): Record<string, readonly string[]> {
  if (input.topology === 'star') {
    return createStarNextHopMap(input.activeSessionIds);
  }
  if (input.topology === 'tree') {
    return createNoRttTreeNextHopMap(input.activeSessionIds, input.degreeLimit);
  }
  return createNoRttMeshNextHopMap(input);
}

function createStarNextHopMap(
  activeSessionIds: readonly string[],
): Record<string, readonly string[]> {
  return Object.fromEntries(
    activeSessionIds.map((sessionId) => [
      sessionId,
      activeSessionIds.filter((peerId) => peerId !== sessionId),
    ]),
  );
}

function createNoRttMeshNextHopMap(
  input: ComputeNoRttTopologyNextHopsInput,
): Record<string, readonly string[]> {
  const insertedSessionIds: string[] = [];
  const nextHopsBySessionId = new Map<string, Set<string>>();

  for (const sessionId of input.activeSessionIds) {
    if (nextHopsBySessionId.has(sessionId)) {
      continue;
    }

    if (insertedSessionIds.length === 0) {
      nextHopsBySessionId.set(sessionId, new Set());
      insertedSessionIds.push(sessionId);
      continue;
    }

    const rankedCandidates = insertedSessionIds
      .filter((candidate) => (nextHopsBySessionId.get(candidate)?.size ?? 0) < input.degreeLimit)
      .map((candidate) => ({
        candidate,
        weight: computeCanonicalTopologyPairWeight(sessionId, candidate),
      }))
      .sort(
        (left, right) =>
          left.weight - right.weight ||
          compareRtcTopologyIdentifiers(left.candidate, right.candidate),
      );

    if (rankedCandidates.length === 0) {
      break;
    }

    const nextHops = new Set<string>();
    nextHopsBySessionId.set(sessionId, nextHops);
    insertedSessionIds.push(sessionId);

    for (const { candidate } of rankedCandidates.slice(0, input.meshParamK)) {
      nextHops.add(candidate);
      nextHopsBySessionId.get(candidate)?.add(sessionId);
    }
  }

  return toNoRttNextHopRecord(input.activeSessionIds, nextHopsBySessionId);
}

function createNoRttTreeNextHopMap(
  activeSessionIds: readonly string[],
  degreeLimit: number,
): Record<string, readonly string[]> {
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
    return toNoRttNextHopRecord(activeSessionIds, state.nextHopsBySessionId);
  }

  addNoRttTreeNode(state, source);
  state.eccentricityBySessionId.set(source, 0);
  setNoRttTreeDistance({ state, left: source, right: source, value: 0 });
  state.notInTree.delete(source);

  while (state.notInTree.size > 0) {
    const next = state.nearest.node;
    if (next === undefined) {
      break;
    }

    const parent = state.nearBySessionId.get(next);
    if (parent === undefined || !state.nextHopsBySessionId.has(parent)) {
      break;
    }

    attachNoRttTreeVertex({
      state,
      sessionId: next,
      parentSessionId: parent,
      degreeLimit,
    });
    state.notInTree.delete(next);

    if (state.notInTree.size === 0) {
      break;
    }

    recomputeNoRttTreeNear(state, degreeLimit);
    state.nearest = selectNoRttTreeNearestVertex(state, degreeLimit);
  }

  return toNoRttNextHopRecord(activeSessionIds, state.nextHopsBySessionId);
}

function pickNoRttTreeSource(activeSessionIds: readonly string[]): string {
  let selected = activeSessionIds[0];
  let selectedScore = Number.POSITIVE_INFINITY;

  for (const sessionId of activeSessionIds) {
    let score = 0;
    for (const otherSessionId of activeSessionIds) {
      if (otherSessionId === sessionId) {
        continue;
      }
      score += computeCanonicalTopologyPairWeight(sessionId, otherSessionId);
    }

    if (
      score < selectedScore ||
      (score === selectedScore && compareRtcTopologyIdentifiers(sessionId, selected) < 0)
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
      const weight = computeCanonicalTopologyPairWeight(sessionId, source);
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
  if (state.nextHopsBySessionId.has(sessionId)) {
    return;
  }
  state.nextHopsBySessionId.set(sessionId, new Set());
  state.treeNodeOrder.push(sessionId);
}

function attachNoRttTreeVertex(input: AttachNoRttTreeVertexInput): void {
  addNoRttTreeNode(input.state, input.sessionId);
  input.state.nextHopsBySessionId.get(input.sessionId)?.add(input.parentSessionId);
  input.state.nextHopsBySessionId.get(input.parentSessionId)?.add(input.sessionId);

  const parentDegree = input.state.nextHopsBySessionId.get(input.parentSessionId)?.size ?? 0;
  if (parentDegree > input.degreeLimit) {
    throw new Error(`Degree bound exceeded for ${input.parentSessionId}`);
  }

  updateNoRttTreeDistancesAfterAttach(input.state, input.sessionId, input.parentSessionId);
}

function updateNoRttTreeDistancesAfterAttach(
  state: NoRttTreeState,
  sessionId: string,
  parentSessionId: string,
): void {
  const weight = computeCanonicalTopologyPairWeight(sessionId, parentSessionId);

  for (const treeSessionId of state.treeNodeOrder) {
    const parentToTreeSession = readNoRttTreeDistance(state, parentSessionId, treeSessionId);
    if (parentToTreeSession > 0) {
      setNoRttTreeDistance({
        state,
        left: sessionId,
        right: treeSessionId,
        value: parentToTreeSession + weight,
      });
    }
  }

  setNoRttTreeDistance({ state, left: sessionId, right: sessionId, value: 0 });
  state.eccentricityBySessionId.set(
    sessionId,
    (state.eccentricityBySessionId.get(parentSessionId) ?? 0) + weight,
  );

  setNoRttTreeDistance({
    state,
    left: parentSessionId,
    right: sessionId,
    value: weight,
  });
  if ((state.eccentricityBySessionId.get(parentSessionId) ?? 0) <= 0) {
    state.eccentricityBySessionId.set(parentSessionId, weight);
  }

  for (const treeSessionId of state.treeNodeOrder) {
    const treeSessionToParent = readNoRttTreeDistance(state, treeSessionId, parentSessionId);
    setNoRttTreeDistance({
      state,
      left: treeSessionId,
      right: sessionId,
      value: treeSessionToParent + weight,
    });
    state.eccentricityBySessionId.set(
      treeSessionId,
      Math.max(
        state.eccentricityBySessionId.get(treeSessionId) ?? 0,
        readNoRttTreeDistance(state, treeSessionId, sessionId),
      ),
    );
  }
}

function recomputeNoRttTreeNear(state: NoRttTreeState, degreeLimit: number): void {
  for (const sessionId of state.notInTree) {
    let bestParent: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const inTreeSessionId of state.treeNodeOrder) {
      const inTreeDegree = state.nextHopsBySessionId.get(inTreeSessionId)?.size ?? 0;
      if (inTreeDegree >= degreeLimit) {
        continue;
      }

      const weight = computeCanonicalTopologyPairWeight(sessionId, inTreeSessionId);
      const score = (state.eccentricityBySessionId.get(inTreeSessionId) ?? 0) + weight;

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
    if (nearSessionId === undefined) {
      continue;
    }

    const outDegree = state.nextHopsBySessionId.get(nearSessionId)?.size ?? 0;
    const weight = computeCanonicalTopologyPairWeight(sessionId, nearSessionId);
    const score = (state.eccentricityBySessionId.get(nearSessionId) ?? 0) + weight;

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

function toNoRttNextHopRecord(
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

function readNoRttTreeDistance(state: NoRttTreeState, left: string, right: string): number {
  return state.distanceBySessionId.get(left)?.get(right) ?? 0;
}

function setNoRttTreeDistance(input: SetNoRttTreeDistanceInput): void {
  let row = input.state.distanceBySessionId.get(input.left);
  if (row === undefined) {
    row = new Map();
    input.state.distanceBySessionId.set(input.left, row);
  }
  row.set(input.right, input.value);
}
