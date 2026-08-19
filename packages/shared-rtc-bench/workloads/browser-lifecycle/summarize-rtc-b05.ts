import type {
  RtcBaselineJson,
  RtcBaselineSampleDto,
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import * as baselineStatistics from '../../baseline/evidence/rtc-baseline-statistics.ts';

function toJsonObject(value: RtcBaselineJson | undefined): Record<string, RtcBaselineJson> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, RtcBaselineJson>)
    : null;
}

function computeFiniteMetric(
  value: RtcBaselineJson | undefined,
  metric: string,
  unit: string,
): RtcBaselineSampleDto['metrics'] {
  return typeof value === 'number' && Number.isFinite(value) ? [{ metric, unit, value }] : [];
}

function computeFiniteMetricValues(
  iterations: readonly Record<string, RtcBaselineJson>[],
  field: 'openDurationMs' | 'closeDurationMs',
) {
  return iterations.flatMap((iteration) => {
    const value = iteration[field];
    return typeof value === 'number' && Number.isFinite(value) ? [value] : [];
  });
}

function computeMedianMetric(
  values: readonly number[],
  metric: string,
  unit: string,
): RtcBaselineSampleDto['metrics'] {
  return values.length === 0
    ? []
    : [{ metric, unit, value: baselineStatistics.computeRtcBaselineMetricSummary(values).median }];
}

function computeLifecycleMetrics(results: readonly RtcBaselineJson[]) {
  const firstIteration = toJsonObject(results[0]);
  const steadyIterations = results
    .slice(1)
    .map(toJsonObject)
    .filter((iteration) => iteration !== null);
  return [
    ...computeFiniteMetric(firstIteration?.openDurationMs, 'firstOpenDurationMs', 'ms'),
    ...computeMedianMetric(
      computeFiniteMetricValues(steadyIterations, 'openDurationMs'),
      'steadyOpenMedianDurationMs',
      'ms',
    ),
    ...computeFiniteMetric(firstIteration?.closeDurationMs, 'firstCloseDurationMs', 'ms'),
    ...computeMedianMetric(
      computeFiniteMetricValues(steadyIterations, 'closeDurationMs'),
      'steadyCloseMedianDurationMs',
      'ms',
    ),
  ];
}

function computeHeapMetrics(
  heapValue: RtcBaselineJson | undefined,
): RtcBaselineSampleDto['metrics'] {
  const heap = toJsonObject(heapValue);
  const values = [heap?.beforeBytes, heap?.afterBytes, heap?.deltaBytes];
  return values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? [
        { metric: 'heapBeforeBytes', unit: 'bytes', value: values[0] as number },
        { metric: 'heapAfterBytes', unit: 'bytes', value: values[1] as number },
        { metric: 'heapDeltaBytes', unit: 'bytes', value: values[2] as number },
      ]
    : [];
}

export function summarizeRtcB05(
  rawEvidenceValue: RtcBaselineJson,
): RtcBaselineSampleDto['metrics'] {
  const rawEvidence = toJsonObject(rawEvidenceValue);
  if (rawEvidence === null) {
    return [];
  }
  const soak = toJsonObject(rawEvidence.soak);
  const results = Array.isArray(soak?.results) ? soak.results : [];
  return [
    ...computeFiniteMetric(rawEvidence.durationMs, 'durationMs', 'ms'),
    ...computeLifecycleMetrics(results),
    ...computeHeapMetrics(rawEvidence.heap),
  ];
}
