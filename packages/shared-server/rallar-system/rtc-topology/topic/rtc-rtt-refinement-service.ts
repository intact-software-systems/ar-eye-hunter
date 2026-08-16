import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { predictedRttMs, type VivaldiNodeData } from '@shared-graph/graph/vivaldi.ts';

import { RateLimiter } from '@shared/resilience/Resilience.ts';

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

type ExpiringObservation = Readonly<{
  predictedDeltaMs: number;
  expireAtEpochMs: number;
}>;

type ExpiringDecision = Readonly<{
  claimed: boolean;
  expireAtEpochMs: number;
}>;

/** Coordinates stable refinement decisions across durable work retries. */
export class RtcRttRefinementService {
  private readonly dependencies: RtcRttRefinementServiceDependencies;
  private readonly pruneRateLimiter: RateLimiter;
  private readonly observations = new Map<string, ExpiringObservation>();
  private readonly decisions = new Map<string, ExpiringDecision>();

  constructor(dependencies: RtcRttRefinementServiceDependencies) {
    this.dependencies = dependencies;
    const pruneLimit = dependencies.pruneLimit ?? DEFAULT_RTT_REFINEMENT_PRUNE_LIMIT;
    this.pruneRateLimiter = RateLimiter.initWithTs(
      pruneLimit.windowMs,
      pruneLimit.maxPerWindow,
      dependencies.nowEpochMs(),
    );
  }

  claimWork(input: ClaimRtcRttRefinementWorkInput): boolean {
    const nowEpochMs = this.dependencies.nowEpochMs();
    if (this.pruneRateLimiter.allowAt(nowEpochMs)) {
      this.pruneExpired(nowEpochMs);
    }
    const existingDecision = readUnexpiredEntry(this.decisions, input.workId, nowEpochMs);
    if (existingDecision) return existingDecision.claimed;

    const predictedDeltaMs = this.readOrObserveDelta(input, nowEpochMs);
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

  readRetainedEntryCounts(): Readonly<{ observations: number; decisions: number }> {
    return { observations: this.observations.size, decisions: this.decisions.size };
  }

  private readOrObserveDelta(
    input: ClaimRtcRttRefinementWorkInput,
    nowEpochMs: number,
  ): number {
    const existing = readUnexpiredEntry(this.observations, input.observationId, nowEpochMs);
    if (existing) return existing.predictedDeltaMs;

    const predictedDeltaMs = this.observeAndMeasurePredictedDelta(input.rtt);
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

function readUnexpiredEntry<T extends Readonly<{ expireAtEpochMs: number }>>(
  entries: Map<string, T>,
  key: string,
  nowEpochMs: number,
): T | undefined {
  const entry = entries.get(key);
  if (entry === undefined) return undefined;
  if (entry.expireAtEpochMs <= nowEpochMs) {
    entries.delete(key);
    return undefined;
  }
  return entry;
}

function pruneExpiredEntries<T extends Readonly<{ expireAtEpochMs: number }>>(
  entries: Map<string, T>,
  nowEpochMs: number,
): void {
  for (const [key, value] of entries) {
    if (value.expireAtEpochMs <= nowEpochMs) entries.delete(key);
  }
}
