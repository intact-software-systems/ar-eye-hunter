import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { predictedRttMs, type VivaldiNodeData } from '@shared-graph/graph/vivaldi.ts';

import { LatestRepository } from '@shared/cache/LatestRepository.ts';

import type { RtcRttRefinementGate } from './rtc-rtt-refinement-gate.ts';

export const DEFAULT_RTT_REFINEMENT_PRUNE_LIMIT = {
  windowMs: 5_000,
  maxPerWindow: 2,
} as const;

export interface RtcRttRefinementPruneLimit {
  readonly windowMs: number;
  readonly maxPerWindow: number;
}

export interface RtcRttRefinementServiceDependencies {
  readonly gate: RtcRttRefinementGate;
  readonly nowEpochMs: () => number;
  readonly observeRtt: (rtt: RttMeasurementInfo) => boolean;
  readonly readPredictedNodeData: () => ReadonlyMap<string, VivaldiNodeData>;
  readonly pruneLimit?: RtcRttRefinementPruneLimit;
}

export interface ClaimRtcRttRefinementWorkInput {
  readonly observationId: string;
  readonly workId: string;
  readonly groupKey: string;
  readonly rtt: RttMeasurementInfo;
  readonly expireAtEpochMs: number;
}

/** Coordinates stable refinement decisions across durable work retries. */
export class RtcRttRefinementService {
  private readonly dependencies: RtcRttRefinementServiceDependencies;
  private readonly observations: LatestRepository<string, number>;
  private readonly decisions: LatestRepository<string, boolean>;

  constructor(dependencies: RtcRttRefinementServiceDependencies) {
    this.dependencies = dependencies;
    const pruneLimit = dependencies.pruneLimit ?? DEFAULT_RTT_REFINEMENT_PRUNE_LIMIT;
    this.observations = new LatestRepository({
      evictWindowMs: pruneLimit.windowMs,
      evictsPerWindow: pruneLimit.maxPerWindow,
    });
    this.decisions = new LatestRepository({
      evictWindowMs: pruneLimit.windowMs,
      evictsPerWindow: pruneLimit.maxPerWindow,
    });
  }

  claimWork(input: ClaimRtcRttRefinementWorkInput): boolean {
    const nowEpochMs = this.dependencies.nowEpochMs();
    const existingDecision = this.decisions.readAt(input.workId, nowEpochMs);
    if (existingDecision !== undefined) return existingDecision;

    const predictedDeltaMs = this.observations.readOrAcceptAt({
      key: input.observationId,
      nowEpochMs,
      expireAtEpochMs: input.expireAtEpochMs,
      create: () => this.observeAndMeasurePredictedDelta(input.rtt),
    });

    const claimed = this.dependencies.gate.claimRefinement({
      groupKey: input.groupKey,
      predictedDeltaMs,
      nowEpochMs,
    });
    this.decisions.acceptAt({
      key: input.workId,
      value: claimed,
      nowEpochMs,
      expireAtEpochMs: input.expireAtEpochMs,
    });
    return claimed;
  }

  readRetainedEntryCounts(): Readonly<{ observations: number; decisions: number }> {
    return {
      observations: this.observations.size(),
      decisions: this.decisions.size(),
    };
  }

  private observeAndMeasurePredictedDelta(rtt: RttMeasurementInfo): number {
    const predictedBefore = readPredictedPairRttMs(rtt, this.dependencies.readPredictedNodeData());
    this.dependencies.observeRtt(rtt);
    const predictedAfter = readPredictedPairRttMs(rtt, this.dependencies.readPredictedNodeData());
    return predictedBefore === undefined || predictedAfter === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs(predictedAfter - predictedBefore);
  }
}

function readPredictedPairRttMs(
  rtt: RttMeasurementInfo,
  nodes: ReadonlyMap<string, VivaldiNodeData>,
): number | undefined {
  const fromNode = nodes.get(rtt.sessionIdFrom);
  const toNode = nodes.get(rtt.sessionIdTo);
  return fromNode && toNode ? predictedRttMs(fromNode, toNode) : undefined;
}
