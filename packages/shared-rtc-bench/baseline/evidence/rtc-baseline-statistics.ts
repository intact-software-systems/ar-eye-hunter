import type {
  RtcBaselineCaptureManifestDto,
  RtcBaselineEnvironmentDto,
  RtcBaselineRuntimeObservationDto,
  RtcBaselineResult,
  RtcBaselineWorkloadId,
} from '../contracts/rtc-baseline-contracts.ts';

const groupingFields = [
  'headCommit',
  'headTree',
  'environmentId',
  'provider',
  'browserBuild',
  'databaseMode',
  'configurationIdentity',
  'workloadId',
  'caseId',
  'inputKey',
  'metric',
  'unit',
] as const;
const nonGitFields = groupingFields.slice(2);
const provenanceFields = groupingFields.slice(0, 7);
const metricIdentityFields = groupingFields.slice(7);

type RtcBaselineStringGroupingField = Exclude<(typeof groupingFields)[number], 'workloadId'>;
export type RtcBaselineMetricGrouping = Record<RtcBaselineStringGroupingField, string> & {
  workloadId: RtcBaselineWorkloadId;
};
export interface RtcBaselineMetricObservation {
  grouping: RtcBaselineMetricGrouping;
  sampleId: string;
  value: number;
}
export interface RtcBaselineMetricPartition {
  grouping: RtcBaselineMetricGrouping;
  values: readonly number[];
}

export interface RtcBaselineMetricSummary {
  count: number;
  minimum: number;
  median: number;
  maximum: number;
  mad: number;
  coefficientOfVariation: number;
}
export interface RtcBaselineDefinedRelativeMedianChange {
  kind: 'defined';
  value: number;
}
export interface RtcBaselineUndefinedRelativeMedianChange {
  kind: 'undefined-zero-baseline';
}
export type RtcBaselineRelativeMedianChange =
  RtcBaselineDefinedRelativeMedianChange | RtcBaselineUndefinedRelativeMedianChange;
export interface RtcBaselinePersistedMetricComparison {
  baseline: RtcBaselineMetricSummary;
  candidate: RtcBaselineMetricSummary;
  absoluteMedianChange: number;
  relativeMedianChange: RtcBaselineRelativeMedianChange;
}
export interface RtcBaselineWorkloadRepeatEvaluation {
  repeatRequired: boolean;
  stillNoisy: boolean;
}
export interface RtcBaselineWorkloadRepeatEvaluationInput {
  primaryMetrics: readonly PersistedMetric[];
  repeatMetrics: readonly PersistedMetric[];
  workloadId: RtcBaselineWorkloadId;
  executionContext: 'local' | 'distributed';
}
export interface PersistedMetric extends RtcBaselineMetricSummary {
  workloadId: RtcBaselineWorkloadId;
  caseId: string;
  inputKey: string;
  metric: string;
  unit: string;
}
export interface PersistedEnvironment {
  environmentId: string;
  observation: Pick<
    RtcBaselineRuntimeObservationDto,
    'git' | 'runtime' | 'host' | 'resolvedConfiguration'
  >;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
export function computeRtcBaselineMetricSummary(
  values: readonly number[],
): RtcBaselineMetricSummary {
  const center = median(values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    minimum: Math.min(...values),
    median: center,
    maximum: Math.max(...values),
    mad: median(values.map((value) => Math.abs(value - center))),
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / Math.abs(mean),
  };
}
export function validateRtcBaselinePersistedMetricSummaries(
  expected: readonly PersistedMetric[],
  actual: readonly PersistedMetric[],
) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  return [
    {
      path: '$.summary.metricSummaries',
      code: 'metric-summary-mismatch',
      message: 'Metric summaries must exactly match checksum-verified retained samples.',
    },
  ];
}
export function summarizeRtcBaselineMetricPartitions(
  partitions: readonly RtcBaselineMetricPartition[],
  summarize = computeRtcBaselineMetricSummary,
): PersistedMetric[] {
  return partitions
    .map(({ grouping, values }) => ({
      workloadId: grouping.workloadId,
      caseId: grouping.caseId,
      inputKey: grouping.inputKey,
      metric: grouping.metric,
      unit: grouping.unit,
      ...summarize(values),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function requiresRtcBaselineRepeat(
  summary: { coefficientOfVariation: number },
  executionContext: 'local' | 'distributed',
) {
  return summary.coefficientOfVariation > (executionContext === 'local' ? 0.1 : 0.2);
}

export function rtcBaselineRepeatWorkloadIds(
  metrics: readonly PersistedMetric[],
  executionContext: 'local' | 'distributed',
  workloadOrder: readonly RtcBaselineWorkloadId[],
) {
  const noisy = new Set(
    metrics
      .filter((metric) => requiresRtcBaselineRepeat(metric, executionContext))
      .map((metric) => metric.workloadId),
  );
  return workloadOrder.filter((workloadId) => noisy.has(workloadId));
}

export function rtcBaselineTriggeredWorkloads(value: {
  environment: RtcBaselineEnvironmentDto;
  manifest: Pick<RtcBaselineCaptureManifestDto, 'workloadIds'>;
  summary: { metricSummaries: readonly PersistedMetric[] };
}) {
  const context = value.environment.observation?.host.executionContext;
  if (context === undefined) return [];
  return rtcBaselineRepeatWorkloadIds(
    value.summary.metricSummaries,
    context,
    value.manifest.workloadIds,
  );
}

export function evaluateRtcBaselineRepeatOutcome(
  primary: { coefficientOfVariation: number },
  repeat: { coefficientOfVariation: number },
  executionContext: 'local' | 'distributed',
) {
  const threshold = executionContext === 'local' ? 10 : 20;
  if (
    requiresRtcBaselineRepeat(primary, executionContext) &&
    requiresRtcBaselineRepeat(repeat, executionContext)
  ) {
    return {
      outcome: 'inconclusive' as const,
      issues: [
        {
          path: '$.repeat.coefficientOfVariation',
          code: 'repeat-still-noisy',
          message: `Controlled repeat coefficient of variation remains above ${threshold}%.`,
        },
      ],
    };
  }
  return { outcome: 'conclusive' as const, issues: [] };
}

function persistedMetricKey(metric: PersistedMetric) {
  return [metric.caseId, metric.inputKey, metric.metric, metric.unit].join('\0');
}

export function evaluateRtcBaselineWorkloadRepeatOutcome(
  input: RtcBaselineWorkloadRepeatEvaluationInput,
): RtcBaselineResult<RtcBaselineWorkloadRepeatEvaluation> {
  const primary = input.primaryMetrics.filter(({ workloadId }) => workloadId === input.workloadId);
  const triggering = primary.filter((metric) =>
    requiresRtcBaselineRepeat(metric, input.executionContext),
  );
  const repeats = new Map(
    input.repeatMetrics
      .filter(({ workloadId }) => workloadId === input.workloadId)
      .map((metric) => [persistedMetricKey(metric), metric]),
  );
  const missing = triggering.flatMap((metric) => {
    if (repeats.has(persistedMetricKey(metric))) return [];
    const key = [metric.caseId, metric.inputKey, metric.metric, metric.unit].join('/');
    return [
      {
        path: '$.repeatMetrics',
        code: 'missing-repeat-metric',
        message: `Controlled repeat is missing ${key}.`,
      },
    ];
  });
  if (missing.length > 0) return { ok: false, issues: missing };
  const stillNoisy = triggering.some(
    (metric) =>
      evaluateRtcBaselineRepeatOutcome(
        metric,
        repeats.get(persistedMetricKey(metric))!,
        input.executionContext,
      ).outcome === 'inconclusive',
  );
  return { ok: true, value: { repeatRequired: triggering.length > 0, stillNoisy } };
}

export function partitionRtcBaselineMetricObservations(
  observations: readonly RtcBaselineMetricObservation[],
) {
  const issues: Array<{ path: string; code: string; message: string }> = [];
  const partitions = new Map<
    string,
    { grouping: RtcBaselineMetricGrouping; values: number[]; sampleIds: string[] }
  >();
  observations.forEach((observation, index) => {
    const key = metricIdentityFields.map((field) => observation.grouping[field]).join('\0');
    const partition = partitions.get(key);
    if (!partition) {
      partitions.set(key, {
        grouping: observation.grouping,
        values: [observation.value],
        sampleIds: [observation.sampleId],
      });
      return;
    }
    for (const field of provenanceFields) {
      if (observation.grouping[field] !== partition.grouping[field]) {
        issues.push({
          path: `$.observations[${index}].grouping.${field}`,
          code: 'mixed-grouping-field',
          message:
            `Metric cohort mixes ${field}: ` +
            `${partition.grouping[field]} versus ${observation.grouping[field]}.`,
        });
      }
    }
    partition.values.push(observation.value);
    partition.sampleIds.push(observation.sampleId);
  });
  return issues.length > 0
    ? { ok: false as const, issues }
    : { ok: true as const, value: [...partitions.values()] };
}

export function compareRtcBaselinePairedCohorts(
  baseline: { grouping: RtcBaselineMetricGrouping; values: readonly number[] },
  candidate: { grouping: RtcBaselineMetricGrouping; values: readonly number[] },
) {
  if (
    baseline.grouping.headCommit === candidate.grouping.headCommit &&
    baseline.grouping.headTree === candidate.grouping.headTree
  ) {
    return {
      ok: false as const,
      issues: [
        {
          path: '$.candidate.grouping.headCommit',
          code: 'same-git-anchor',
          message: 'Paired comparison requires distinct Git commit and tree identity.',
        },
      ],
    };
  }
  for (const field of nonGitFields) {
    if (baseline.grouping[field] !== candidate.grouping[field]) {
      return {
        ok: false as const,
        issues: [
          {
            path: `$.candidate.grouping.${field}`,
            code: 'paired-grouping-mismatch',
            message: `Paired comparison differs by non-Git grouping field ${field}.`,
          },
        ],
      };
    }
  }
  const baselineSummary = computeRtcBaselineMetricSummary(baseline.values);
  const candidateSummary = computeRtcBaselineMetricSummary(candidate.values);
  const absoluteMedianChange = candidateSummary.median - baselineSummary.median;
  return {
    ok: true as const,
    value: {
      baseline: baselineSummary,
      candidate: candidateSummary,
      absoluteMedianChange,
      relativeMedianChange:
        baselineSummary.median === 0
          ? { kind: 'undefined-zero-baseline' as const }
          : { kind: 'defined' as const, value: absoluteMedianChange / baselineSummary.median },
    },
  };
}

function persistedGrouping(
  environment: PersistedEnvironment,
  metric: PersistedMetric,
): RtcBaselineMetricGrouping {
  const configuration = environment.observation.resolvedConfiguration;
  const database = configuration.find((entry) => entry.field === 'databaseProvider');
  return {
    headCommit: environment.observation.git.headCommit,
    headTree: environment.observation.git.headTree,
    environmentId: environment.environmentId,
    provider: environment.observation.host.executionContext,
    browserBuild: environment.observation.runtime.chromium,
    databaseMode: String(database?.value ?? 'none'),
    configurationIdentity: JSON.stringify(configuration),
    workloadId: metric.workloadId,
    caseId: metric.caseId,
    inputKey: metric.inputKey,
    metric: metric.metric,
    unit: metric.unit,
  };
}

function persistedSummary(metric: PersistedMetric): RtcBaselineMetricSummary {
  const { count, minimum, median, maximum, mad, coefficientOfVariation } = metric;
  return { count, minimum, median, maximum, mad, coefficientOfVariation };
}

export function compareRtcBaselinePersistedMetrics(input: {
  baselineEnvironment: PersistedEnvironment;
  candidateEnvironment: PersistedEnvironment;
  baselineMetrics: readonly PersistedMetric[];
  candidateMetrics: readonly PersistedMetric[];
  workloadId: RtcBaselineWorkloadId;
}) {
  const baseline = input.baselineMetrics.filter((entry) => entry.workloadId === input.workloadId);
  const candidates = input.candidateMetrics.filter(
    (entry) => entry.workloadId === input.workloadId,
  );
  const candidateByKey = new Map(candidates.map((entry) => [persistedMetricKey(entry), entry]));
  if (
    baseline.length === 0 ||
    candidates.length !== baseline.length ||
    baseline.some((entry) => !candidateByKey.has(persistedMetricKey(entry)))
  ) {
    return {
      ok: false as const,
      issues: [
        {
          path: '$.workloadId',
          code: 'missing-comparable-metric',
          message: `No comparable metric exists for ${input.workloadId}.`,
        },
      ],
    };
  }
  const comparisons: RtcBaselinePersistedMetricComparison[] = [];
  for (const baselineMetric of baseline) {
    const candidateMetric = candidateByKey.get(persistedMetricKey(baselineMetric))!;
    const compared = compareRtcBaselinePairedCohorts(
      {
        grouping: persistedGrouping(input.baselineEnvironment, baselineMetric),
        values: [baselineMetric.median],
      },
      {
        grouping: persistedGrouping(input.candidateEnvironment, candidateMetric),
        values: [candidateMetric.median],
      },
    );
    if (!compared.ok) return compared;
    comparisons.push({
      ...compared.value,
      baseline: persistedSummary(baselineMetric),
      candidate: persistedSummary(candidateMetric),
    });
  }
  return { ok: true as const, value: comparisons };
}
