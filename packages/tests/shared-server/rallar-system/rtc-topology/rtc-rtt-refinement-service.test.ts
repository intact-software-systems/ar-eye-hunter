import { describe, expect, it, vi } from 'vitest';

import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { VivaldiNodeData } from '@shared-graph/graph/vivaldi.ts';
import { RtcRttRefinementGate } from '@shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-gate.ts';
import { RtcRttRefinementService } from '@shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-service.ts';

const RTT: RttMeasurementInfo = {
  sessionIdFrom: 'peer-a',
  sessionIdTo: 'peer-b',
  rttMs: 12,
  createdAtEpochMs: 1_000,
  version: 1,
};

describe('RTC RTT refinement service', () => {
  it('accumulates one predicted delta per durable observation and reuses decisions on retry', () => {
    let nowEpochMs = 1_000;
    let predictedDistanceMs = 0;
    const observeRtt = vi.fn(() => {
      predictedDistanceMs += 4;
      return true;
    });
    const service = new RtcRttRefinementService({
      gate: new RtcRttRefinementGate({
        minIntervalMs: 0,
        vivaldiDeltaThresholdMs: 10,
      }),
      nowEpochMs: () => nowEpochMs,
      observeRtt,
      readPredictedNodeData: () => predictedNodes(predictedDistanceMs),
    });

    expect(claim(service, 'observation-1', 'work-1', RTT)).toBe(false);
    expect(claim(service, 'observation-2', 'work-2', { ...RTT, version: 2 })).toBe(false);
    expect(claim(service, 'observation-3', 'work-3', { ...RTT, version: 3 })).toBe(true);
    expect(claim(service, 'observation-3', 'work-3', { ...RTT, version: 3 })).toBe(true);
    expect(observeRtt).toHaveBeenCalledTimes(3);

    nowEpochMs = 70_000;
    expect(claim(service, 'observation-3', 'work-3', { ...RTT, version: 3 }, 60_000)).toBe(false);
    expect(observeRtt).toHaveBeenCalledTimes(4);
  });

  it('observes one receipt once and applies its delta independently to every affected group', () => {
    let predictedDistanceMs = 0;
    const observeRtt = vi.fn(() => {
      predictedDistanceMs = 6;
      return true;
    });
    const service = new RtcRttRefinementService({
      gate: new RtcRttRefinementGate({
        minIntervalMs: 0,
        vivaldiDeltaThresholdMs: 5,
      }),
      nowEpochMs: () => 1_000,
      observeRtt,
      readPredictedNodeData: () => predictedNodes(predictedDistanceMs),
    });

    expect(claim(service, 'receipt-1', 'work-a', RTT, 60_000, 'group-a')).toBe(true);
    expect(claim(service, 'receipt-1', 'work-b', RTT, 60_000, 'group-b')).toBe(true);
    expect(observeRtt).toHaveBeenCalledOnce();
  });

  // #240: the prune used to scan both maps on every claim, O(N^2) across N live
  // claims. These two pin both halves of the fix — the scan stops being
  // per-claim, and skipping it never lets an expired entry answer a claim.
  it('stops scanning both maps on every claim', () => {
    let nowEpochMs = 1_000;
    const service = new RtcRttRefinementService({
      gate: new RtcRttRefinementGate({ minIntervalMs: 0, vivaldiDeltaThresholdMs: 0 }),
      nowEpochMs: () => nowEpochMs,
      observeRtt: () => true,
      readPredictedNodeData: () => predictedNodes(0),
      pruneLimit: { windowMs: 60_000, maxPerWindow: 1 },
    });

    claim(service, 'observation-1', 'work-1', RTT);
    expect(service.readRetainedEntryCounts()).toEqual({ observations: 1, decisions: 1 });

    // Past every earlier entry's expiry, so an eager prune would empty both maps.
    nowEpochMs = 70_000;
    for (const index of [2, 3, 4, 5]) {
      claim(service, `observation-${index}`, `work-${index}`, { ...RTT, version: index }, 120_000);
    }

    // The first claim spent the single allowed prune, so the expired entry is
    // still held rather than rescanned away.
    expect(service.readRetainedEntryCounts()).toEqual({ observations: 5, decisions: 5 });
  });

  it('never answers a claim from an expired entry while the prune is rate limited', () => {
    let nowEpochMs = 1_000;
    const observeRtt = vi.fn(() => true);
    const service = new RtcRttRefinementService({
      gate: new RtcRttRefinementGate({ minIntervalMs: 30_000, vivaldiDeltaThresholdMs: 0 }),
      nowEpochMs: () => nowEpochMs,
      observeRtt,
      readPredictedNodeData: () => predictedNodes(0),
      pruneLimit: { windowMs: 60_000, maxPerWindow: 1 },
    });

    expect(claim(service, 'observation-1', 'work-1', RTT)).toBe(true);
    expect(observeRtt).toHaveBeenCalledTimes(1);

    // Same identities after expiry. The entries are still in the maps because
    // the prune budget is spent, so only the read-time expiry check can stop
    // the stale decision being replayed.
    nowEpochMs = 70_000;
    expect(claim(service, 'observation-1', 'work-1', RTT)).toBe(true);
    expect(observeRtt).toHaveBeenCalledTimes(2);
  });

  // Prune cadence is driven by moving the injected clock, not by sleeping;
  // nothing here touches wall time.
  it('reclaims expired entries once the prune window rolls on the injected clock', () => {
    let nowEpochMs = 1_000;
    const service = new RtcRttRefinementService({
      gate: new RtcRttRefinementGate({ minIntervalMs: 0, vivaldiDeltaThresholdMs: 0 }),
      nowEpochMs: () => nowEpochMs,
      observeRtt: () => true,
      readPredictedNodeData: () => predictedNodes(0),
      pruneLimit: { windowMs: 20_000, maxPerWindow: 1 },
    });

    // Spends this window's one allowed prune.
    claim(service, 'observation-1', 'work-1', RTT, 2_000);

    // Both fall inside the 20s window, so no prune runs even though the earlier
    // entries are past expiry: they are held, not answered.
    nowEpochMs = 3_000;
    claim(service, 'observation-2', 'work-2', { ...RTT, version: 2 }, 4_000);
    nowEpochMs = 5_000;
    claim(service, 'observation-3', 'work-3', { ...RTT, version: 3 }, 200_000);
    expect(service.readRetainedEntryCounts()).toEqual({ observations: 3, decisions: 3 });

    // Rolling past the window refills the budget, so this claim prunes.
    nowEpochMs = 30_000;
    claim(service, 'observation-4', 'work-4', { ...RTT, version: 4 }, 200_000);
    expect(service.readRetainedEntryCounts()).toEqual({ observations: 2, decisions: 2 });
  });

  it('preserves per-work refinement when both knobs are zero', () => {
    const service = new RtcRttRefinementService({
      gate: new RtcRttRefinementGate({ minIntervalMs: 0, vivaldiDeltaThresholdMs: 0 }),
      nowEpochMs: () => 1_000,
      observeRtt: () => true,
      readPredictedNodeData: () => predictedNodes(0),
    });

    expect(claim(service, 'observation-1', 'work-1', RTT)).toBe(true);
    expect(claim(service, 'observation-2', 'work-2', { ...RTT, version: 2 })).toBe(true);
  });
});

function claim(
  service: RtcRttRefinementService,
  observationId: string,
  workId: string,
  rtt: RttMeasurementInfo,
  expireAtEpochMs = 60_000,
  groupKey = 'group-1',
): boolean {
  return service.claimWork({
    observationId,
    workId,
    groupKey,
    rtt,
    expireAtEpochMs,
  });
}

function predictedNodes(distanceMs: number): ReadonlyMap<string, VivaldiNodeData> {
  return new Map([
    ['peer-a', { id: 'peer-a', coords: [0], err: 0.1, rttMs: 0 }],
    ['peer-b', { id: 'peer-b', coords: [distanceMs], err: 0.1, rttMs: 0 }],
  ]);
}
