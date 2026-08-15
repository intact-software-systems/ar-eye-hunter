import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { predictedRttMs, type VivaldiNodeData } from '@shared-graph/graph/vivaldi.ts';

import type { RtcRttRefinementGate } from './rtc-rtt-refinement-gate.ts';

export interface RtcRttRefinementServiceDependencies {
  readonly gate: RtcRttRefinementGate;
  readonly nowEpochMs: () => number;
  readonly observeRtt: (rtt: RttMeasurementInfo) => boolean;
  readonly readPredictedNodeData: () => ReadonlyMap<string, VivaldiNodeData>;
}

export interface ClaimRtcRttRefinementWorkInput {
  readonly observationId: string;
  readonly workId: string;
  readonly groupKey: string;
  readonly rtt: RttMeasurementInfo | null;
  readonly expireAtEpochMs: number;
}

type ExpiringObservation = Readonly<{
  predictedDeltaMs: number;
  expireAtEpochMs: number;
}>;

type ExpiringDecision = Readonly<{
  claimed: boolean;
  expireAtEpochMs: number;
}>;

export class RtcRttRefinementService {
  private readonly dependencies: RtcRttRefinementServiceDependencies;
  private readonly observations = new Map<string, ExpiringObservation>();
  private readonly decisions = new Map<string, ExpiringDecision>();

  constructor(dependencies: RtcRttRefinementServiceDependencies) {
    this.dependencies = dependencies;
  }

  claimWork(input: ClaimRtcRttRefinementWorkInput): boolean {
    const nowEpochMs = this.dependencies.nowEpochMs();
    this.pruneExpired(nowEpochMs);
    const existingDecision = this.decisions.get(input.workId);
    if (existingDecision) return existingDecision.claimed;

    const predictedDeltaMs = this.readOrObserveDelta(input);
    const claimed = this.dependencies.gate.claimRefinement({
      groupKey: input.groupKey,
      predictedDeltaMs,
      nowEpochMs,
    });
    this.decisions.set(input.workId, {
      claimed,
      expireAtEpochMs: input.expireAtEpochMs,
    });
    return claimed;
  }

  private readOrObserveDelta(input: ClaimRtcRttRefinementWorkInput): number {
    const existing = this.observations.get(input.observationId);
    if (existing) return existing.predictedDeltaMs;

    const predictedDeltaMs = input.rtt
      ? this.observeAndMeasurePredictedDelta(input.rtt)
      : Number.POSITIVE_INFINITY;
    this.observations.set(input.observationId, {
      predictedDeltaMs,
      expireAtEpochMs: input.expireAtEpochMs,
    });
    return predictedDeltaMs;
  }

  private observeAndMeasurePredictedDelta(rtt: RttMeasurementInfo): number {
    const predictedBefore = readPredictedPairRttMs(rtt, this.dependencies.readPredictedNodeData());
    this.dependencies.observeRtt(rtt);
    const predictedAfter = readPredictedPairRttMs(rtt, this.dependencies.readPredictedNodeData());
    return predictedBefore === undefined || predictedAfter === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs(predictedAfter - predictedBefore);
  }

  private pruneExpired(nowEpochMs: number): void {
    pruneExpiredEntries(this.observations, nowEpochMs);
    pruneExpiredEntries(this.decisions, nowEpochMs);
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

function pruneExpiredEntries<T extends Readonly<{ expireAtEpochMs: number }>>(
  entries: Map<string, T>,
  nowEpochMs: number,
): void {
  for (const [key, value] of entries) {
    if (value.expireAtEpochMs <= nowEpochMs) entries.delete(key);
  }
}
