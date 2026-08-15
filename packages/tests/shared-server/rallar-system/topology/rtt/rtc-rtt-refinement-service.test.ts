import { describe, expect, it, vi } from 'vitest';

import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { VivaldiNodeData } from '@shared-graph/graph/vivaldi.ts';
import { RtcRttRefinementGate } from '@shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-gate.ts';
import { RtcRttRefinementService } from '@shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-service.ts';

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

  it('claims legacy work early without inventing an RTT observation', () => {
    const observeRtt = vi.fn(() => true);
    const service = new RtcRttRefinementService({
      gate: new RtcRttRefinementGate({
        minIntervalMs: 0,
        vivaldiDeltaThresholdMs: 10,
      }),
      nowEpochMs: () => 1_000,
      observeRtt,
      readPredictedNodeData: () => new Map(),
    });

    expect(claim(service, 'legacy-1', 'legacy-work', null)).toBe(true);
    expect(claim(service, 'legacy-1', 'legacy-work', null)).toBe(true);
    expect(observeRtt).not.toHaveBeenCalled();
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
  rtt: RttMeasurementInfo | null,
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
