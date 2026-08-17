import { compareRtcTopologyIdentifiers } from '../../rtc-topology-identifiers.ts';
import { computeCanonicalTopologyPairWeight } from './canonical-topology-planning-input.ts';
import {
  type NoRttNearestChoice,
  updateNoRttTreeAttachmentSelection,
} from './update-no-rtt-tree-attachment-selection.ts';

export interface ComputeNoRttTreeNextHopsInput {
  readonly activeSessionIds: readonly string[];
  readonly degreeLimit: number;
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

export function computeNoRttTreeNextHops(
  input: ComputeNoRttTreeNextHopsInput,
): ReadonlyMap<string, ReadonlySet<string>> {
  if (input.activeSessionIds.length === 0) {
    return new Map();
  }

  if (input.activeSessionIds.length === 1) {
    return new Map([[input.activeSessionIds[0], new Set()]]);
  }

  const source = pickNoRttTreeSource(input.activeSessionIds);
  const state = initializeNoRttTreeState(input.activeSessionIds, source);

  if (state.nearest.node === undefined) {
    return state.nextHopsBySessionId;
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
      degreeLimit: input.degreeLimit,
    });
    state.notInTree.delete(next);

    if (state.notInTree.size === 0) {
      break;
    }

    state.nearest = updateNoRttTreeAttachmentSelection({
      nearBySessionId: state.nearBySessionId,
      eccentricityBySessionId: state.eccentricityBySessionId,
      notInTree: state.notInTree,
      treeNodeOrder: state.treeNodeOrder,
      nextHopsBySessionId: state.nextHopsBySessionId,
      degreeLimit: input.degreeLimit,
    });
  }

  return state.nextHopsBySessionId;
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
