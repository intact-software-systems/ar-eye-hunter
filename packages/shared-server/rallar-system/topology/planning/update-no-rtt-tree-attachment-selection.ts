import { computeCanonicalTopologyPairWeight } from './canonical-topology-planning-input.ts';

export interface NoRttNearestChoice {
  readonly node?: string;
  readonly score: number;
}

export interface UpdateNoRttTreeAttachmentSelectionInput {
  readonly nearBySessionId: Map<string, string | undefined>;
  readonly eccentricityBySessionId: ReadonlyMap<string, number>;
  readonly notInTree: ReadonlySet<string>;
  readonly treeNodeOrder: readonly string[];
  readonly nextHopsBySessionId: ReadonlyMap<string, ReadonlySet<string>>;
  readonly degreeLimit: number;
}

export function updateNoRttTreeAttachmentSelection(
  input: UpdateNoRttTreeAttachmentSelectionInput,
): NoRttNearestChoice {
  for (const sessionId of input.notInTree) {
    let bestParent: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const inTreeSessionId of input.treeNodeOrder) {
      const inTreeDegree = input.nextHopsBySessionId.get(inTreeSessionId)?.size ?? 0;
      if (inTreeDegree >= input.degreeLimit) {
        continue;
      }

      const weight = computeCanonicalTopologyPairWeight(sessionId, inTreeSessionId);
      const score = (input.eccentricityBySessionId.get(inTreeSessionId) ?? 0) + weight;

      if (score < bestScore) {
        bestParent = inTreeSessionId;
        bestScore = score;
      }
    }

    input.nearBySessionId.set(sessionId, bestParent);
  }

  return selectNoRttTreeNearestVertex(input);
}

function selectNoRttTreeNearestVertex(
  input: UpdateNoRttTreeAttachmentSelectionInput,
): NoRttNearestChoice {
  let nearest: NoRttNearestChoice = {
    node: undefined,
    score: Number.POSITIVE_INFINITY,
  };
  let hasDegreeBrokenCandidate = false;

  for (const sessionId of input.notInTree) {
    const nearSessionId = input.nearBySessionId.get(sessionId);
    if (nearSessionId === undefined) {
      continue;
    }

    const outDegree = input.nextHopsBySessionId.get(nearSessionId)?.size ?? 0;
    const weight = computeCanonicalTopologyPairWeight(sessionId, nearSessionId);
    const score = (input.eccentricityBySessionId.get(nearSessionId) ?? 0) + weight;

    if (outDegree < input.degreeLimit && score < nearest.score) {
      nearest = { node: sessionId, score };
    }

    if (outDegree >= input.degreeLimit) {
      hasDegreeBrokenCandidate = true;
    }
  }

  return nearest.node !== undefined || !hasDegreeBrokenCandidate
    ? nearest
    : { node: undefined, score: Number.POSITIVE_INFINITY };
}
