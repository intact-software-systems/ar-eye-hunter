export const DEFAULT_RTT_REFINEMENT_MIN_INTERVAL_MS = 30_000;
export const DEFAULT_RTT_VIVALDI_DELTA_MS = 5;

export interface RtcRttRefinementGateConfig {
  readonly minIntervalMs: number;
  readonly vivaldiDeltaThresholdMs: number;
}

export interface ClaimRttRefinementInput {
  readonly groupKey: string;
  readonly predictedDeltaMs: number;
  readonly nowEpochMs: number;
}

/**
 * Owns process-local damping for RTT-driven placement refinement (M8): a replan is enqueued only when
 * the accumulated Vivaldi predicted-RTT movement since the last refinement
 * crosses the threshold AND the per-group interval floor has elapsed, so
 * placement improves occasionally instead of per report. Sub-threshold
 * movement keeps accumulating — knowledge is never dropped, only the replan
 * deferred. Both knobs at 0 keep the pre-gate per-report behavior. The state
 * is process-local damping, not authority: a restarted server refines at most
 * once early.
 */
export class RtcRttRefinementGate {
  private readonly config: RtcRttRefinementGateConfig;
  private readonly accumulatedDeltaMsByGroupKey = new Map<string, number>();
  private readonly lastRefinementAtByGroupKey = new Map<string, number>();

  constructor(config: RtcRttRefinementGateConfig) {
    this.config = config;
  }

  claimRefinement(input: ClaimRttRefinementInput): boolean {
    const accumulated =
      (this.accumulatedDeltaMsByGroupKey.get(input.groupKey) ?? 0) +
      Math.abs(input.predictedDeltaMs);
    if (accumulated < this.config.vivaldiDeltaThresholdMs) {
      this.accumulatedDeltaMsByGroupKey.set(input.groupKey, accumulated);
      return false;
    }

    const lastRefinementAt = this.lastRefinementAtByGroupKey.get(input.groupKey);
    if (
      lastRefinementAt !== undefined &&
      input.nowEpochMs - lastRefinementAt < this.config.minIntervalMs
    ) {
      this.accumulatedDeltaMsByGroupKey.set(input.groupKey, accumulated);
      return false;
    }

    this.accumulatedDeltaMsByGroupKey.delete(input.groupKey);
    this.lastRefinementAtByGroupKey.set(input.groupKey, input.nowEpochMs);
    return true;
  }
}

export function createDefaultRtcRttRefinementGate(): RtcRttRefinementGate {
  return new RtcRttRefinementGate({
    minIntervalMs: DEFAULT_RTT_REFINEMENT_MIN_INTERVAL_MS,
    vivaldiDeltaThresholdMs: DEFAULT_RTT_VIVALDI_DELTA_MS,
  });
}
