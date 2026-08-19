import { describe, expect, it } from 'vitest';

import type { RtcBaselineJson } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import {
  computeRtcBaselineMetricSummary,
  requiresRtcBaselineRepeat,
} from '../../../baseline/evidence/rtc-baseline-statistics.ts';
import { summarizeRtcB05 } from '../../../workloads/browser-lifecycle/summarize-rtc-b05.ts';

function createRawEvidence(openDurationsMs: readonly number[]): RtcBaselineJson {
  return {
    durationMs: 600,
    heap: {
      beforeBytes: 550_000,
      afterBytes: 600_000,
      deltaBytes: 50_000,
    },
    soak: {
      results: openDurationsMs.map((openDurationMs, index) => ({
        openDurationMs,
        closeDurationMs: openDurationMs + 0.25,
        index: index + 1,
      })),
    },
  };
}

function computeSteadyOpenMedianDuration(openDurationsMs: readonly number[]) {
  const metric = summarizeRtcB05(createRawEvidence(openDurationsMs)).find(
    ({ metric: metricName }) => metricName === 'steadyOpenMedianDurationMs',
  );
  if (!metric) {
    throw new Error('Expected RTC-B05 steady-open median metric');
  }
  return metric.value;
}

describe('RTC-B05 browser lifecycle metrics', () => {
  it('projects one first and one steady median timing for each lifecycle phase', () => {
    const metrics = summarizeRtcB05(
      createRawEvidence(Array.from({ length: 25 }, (_, index) => index + 1.25)),
    );

    expect(metrics).toEqual([
      { metric: 'durationMs', unit: 'ms', value: 600 },
      { metric: 'firstOpenDurationMs', unit: 'ms', value: 1.25 },
      { metric: 'steadyOpenMedianDurationMs', unit: 'ms', value: 13.75 },
      { metric: 'firstCloseDurationMs', unit: 'ms', value: 1.5 },
      { metric: 'steadyCloseMedianDurationMs', unit: 'ms', value: 14 },
      { metric: 'heapBeforeBytes', unit: 'bytes', value: 550_000 },
      { metric: 'heapAfterBytes', unit: 'bytes', value: 600_000 },
      { metric: 'heapDeltaBytes', unit: 'bytes', value: 50_000 },
    ]);
  });

  it('keeps isolated steady-iteration spikes out of the repeat decision', () => {
    const steadyOpenMedians = Array.from({ length: 5 }, (_, attemptIndex) =>
      computeSteadyOpenMedianDuration(
        Array.from({ length: 25 }, (_, iterationIndex) =>
          iterationIndex === 0 ? 13 : iterationIndex === attemptIndex + 1 ? 20 : 7,
        ),
      ),
    );

    expect(steadyOpenMedians).toEqual([7, 7, 7, 7, 7]);
    expect(
      requiresRtcBaselineRepeat(computeRtcBaselineMetricSummary(steadyOpenMedians), 'local'),
    ).toBe(false);
  });

  it('still requests a repeat when steady timing drifts between outer attempts', () => {
    const steadyOpenMedians = [7, 8, 9, 10, 11].map((steadyDurationMs) =>
      computeSteadyOpenMedianDuration([13, ...Array<number>(24).fill(steadyDurationMs)]),
    );

    expect(steadyOpenMedians).toEqual([7, 8, 9, 10, 11]);
    expect(
      requiresRtcBaselineRepeat(computeRtcBaselineMetricSummary(steadyOpenMedians), 'local'),
    ).toBe(true);
  });
});
