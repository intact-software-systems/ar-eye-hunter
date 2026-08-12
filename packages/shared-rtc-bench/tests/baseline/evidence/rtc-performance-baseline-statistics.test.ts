import { describe, expect, it } from 'vitest';

import {
  compareRtcBaselinePairedCohorts,
  computeRtcBaselineMetricSummary,
  partitionRtcBaselineMetricObservations,
  evaluateRtcBaselineRepeatOutcome,
  evaluateRtcBaselineWorkloadRepeatOutcome,
  requiresRtcBaselineRepeat,
} from '../../../baseline/evidence/rtc-baseline-statistics.ts';

const grouping = {
  headCommit: '0123456789abcdef0123456789abcdef01234567',
  headTree: 'abcdef0123456789abcdef0123456789abcdef01',
  environmentId: 'E1-local' as const,
  provider: 'local',
  browserBuild: 'none',
  databaseMode: 'none',
  configurationIdentity: 'innerRuns=5/default',
  workloadId: 'RTC-B01' as const,
  caseId: 'peer-connection-diagnostics-burst',
  inputKey: 'pairs-500',
  metric: 'durationMs',
  unit: 'ms',
};

describe('RTC baseline statistics', () => {
  it('recomputes raw count, minimum, median, maximum, MAD, and population CV', () => {
    expect(computeRtcBaselineMetricSummary([8, 10, 12])).toEqual({
      count: 3,
      minimum: 8,
      median: 10,
      maximum: 12,
      mad: 2,
      coefficientOfVariation: 0.16329931618554522,
    });
  });

  it('uses a strict greater-than-ten-percent local repeat boundary', () => {
    expect(requiresRtcBaselineRepeat({ coefficientOfVariation: 0.1 }, 'local')).toBe(false);
    expect(requiresRtcBaselineRepeat({ coefficientOfVariation: 0.1000001 }, 'local')).toBe(true);
    expect(requiresRtcBaselineRepeat({ coefficientOfVariation: 0.2 }, 'distributed')).toBe(false);
    expect(requiresRtcBaselineRepeat({ coefficientOfVariation: 0.200001 }, 'distributed')).toBe(
      true,
    );
  });

  it('rejects a repeat that omits a triggering metric while retaining another metric', () => {
    const summary = {
      count: 1,
      minimum: 10,
      median: 10,
      maximum: 10,
      mad: 0,
    };
    const noisy = {
      ...summary,
      workloadId: 'RTC-B01' as const,
      caseId: 'case',
      inputKey: 'input',
      metric: 'durationMs',
      unit: 'ms',
      coefficientOfVariation: 0.3,
    };
    const stable = { ...noisy, metric: 'heapBytes', unit: 'bytes', coefficientOfVariation: 0 };
    expect(
      evaluateRtcBaselineWorkloadRepeatOutcome({
        primaryMetrics: [noisy, stable],
        repeatMetrics: [stable],
        workloadId: 'RTC-B01',
        executionContext: 'local',
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.repeatMetrics',
          code: 'missing-repeat-metric',
          message: 'Controlled repeat is missing case/input/durationMs/ms.',
        },
      ],
    });
  });

  it('partitions distinct logical metrics while retaining encounter order', () => {
    const result = partitionRtcBaselineMetricObservations([
      { grouping, sampleId: 'duration-1', value: 10 },
      {
        grouping: { ...grouping, caseId: 'heap-case', metric: 'heapBytes', unit: 'bytes' },
        sampleId: 'heap-1',
        value: 1024,
      },
      { grouping, sampleId: 'duration-2', value: 12 },
    ]);
    expect(
      result.ok
        ? result.value.map(({ grouping: value, values, sampleIds }) => ({
            identity: [value.caseId, value.metric, value.unit],
            values,
            sampleIds,
          }))
        : result,
    ).toEqual([
      {
        identity: ['peer-connection-diagnostics-burst', 'durationMs', 'ms'],
        values: [10, 12],
        sampleIds: ['duration-1', 'duration-2'],
      },
      {
        identity: ['heap-case', 'heapBytes', 'bytes'],
        values: [1024],
        sampleIds: ['heap-1'],
      },
    ]);
  });

  it('compares distinct Git anchors without pooling and makes zero relative change JSON-safe', () => {
    const candidate = {
      ...grouping,
      headCommit: '1111111111111111111111111111111111111111',
      headTree: '2222222222222222222222222222222222222222',
    };
    expect(
      compareRtcBaselinePairedCohorts(
        { grouping, values: [0, 0, 0] },
        { grouping: candidate, values: [1, 1, 1] },
      ),
    ).toEqual({
      ok: true,
      value: {
        baseline: {
          count: 3,
          minimum: 0,
          median: 0,
          maximum: 0,
          mad: 0,
          coefficientOfVariation: 0,
        },
        candidate: {
          count: 3,
          minimum: 1,
          median: 1,
          maximum: 1,
          mad: 0,
          coefficientOfVariation: 0,
        },
        absoluteMedianChange: 1,
        relativeMedianChange: { kind: 'undefined-zero-baseline' },
      },
    });
    const defined = compareRtcBaselinePairedCohorts(
      { grouping, values: [8] },
      { grouping: candidate, values: [10] },
    );
    expect(defined.ok ? defined.value.relativeMedianChange : null).toEqual({
      kind: 'defined',
      value: 0.25,
    });
  });

  it('rejects a controlled repeat that remains above the local noise boundary', () => {
    expect(
      evaluateRtcBaselineRepeatOutcome(
        { coefficientOfVariation: 0.11 },
        { coefficientOfVariation: 0.100001 },
        'local',
      ),
    ).toEqual({
      outcome: 'inconclusive',
      issues: [
        {
          path: '$.repeat.coefficientOfVariation',
          code: 'repeat-still-noisy',
          message: 'Controlled repeat coefficient of variation remains above 10%.',
        },
      ],
    });
  });

  it.each([
    [
      'headCommit',
      'f'.repeat(40),
      {
        path: '$.observations[1].grouping.headCommit',
        code: 'mixed-grouping-field',
        message:
          'Metric cohort mixes headCommit: 0123456789abcdef0123456789abcdef01234567 versus ffffffffffffffffffffffffffffffffffffffff.',
      },
    ],
    [
      'headTree',
      'e'.repeat(40),
      {
        path: '$.observations[1].grouping.headTree',
        code: 'mixed-grouping-field',
        message:
          'Metric cohort mixes headTree: abcdef0123456789abcdef0123456789abcdef01 versus eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.',
      },
    ],
    [
      'environmentId',
      'E2-browser',
      {
        path: '$.observations[1].grouping.environmentId',
        code: 'mixed-grouping-field',
        message: 'Metric cohort mixes environmentId: E1-local versus E2-browser.',
      },
    ],
    [
      'provider',
      'ci',
      {
        path: '$.observations[1].grouping.provider',
        code: 'mixed-grouping-field',
        message: 'Metric cohort mixes provider: local versus ci.',
      },
    ],
    [
      'browserBuild',
      'chromium-139',
      {
        path: '$.observations[1].grouping.browserBuild',
        code: 'mixed-grouping-field',
        message: 'Metric cohort mixes browserBuild: none versus chromium-139.',
      },
    ],
    [
      'databaseMode',
      'postgres',
      {
        path: '$.observations[1].grouping.databaseMode',
        code: 'mixed-grouping-field',
        message: 'Metric cohort mixes databaseMode: none versus postgres.',
      },
    ],
    [
      'configurationIdentity',
      'innerRuns=6/cli',
      {
        path: '$.observations[1].grouping.configurationIdentity',
        code: 'mixed-grouping-field',
        message:
          'Metric cohort mixes configurationIdentity: innerRuns=5/default versus innerRuns=6/cli.',
      },
    ],
  ] as const)('rejects a cohort mixed by %s', (field, changed, expectedIssue) => {
    expect(
      partitionRtcBaselineMetricObservations([
        { grouping, sampleId: 'sample-1', value: 10 },
        { grouping: { ...grouping, [field]: changed }, sampleId: 'sample-2', value: 12 },
      ]),
    ).toEqual({
      ok: false,
      issues: [expectedIssue],
    });
  });

  it('requires distinct Git identity for paired comparison', () => {
    expect(
      compareRtcBaselinePairedCohorts(
        { grouping, values: [10, 10, 10] },
        { grouping, values: [9, 9, 9] },
      ),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.candidate.grouping.headCommit',
          code: 'same-git-anchor',
          message: 'Paired comparison requires distinct Git commit and tree identity.',
        },
      ],
    });
  });

  it.each([
    [
      'environmentId',
      'E2-browser',
      {
        path: '$.candidate.grouping.environmentId',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field environmentId.',
      },
    ],
    [
      'provider',
      'ci',
      {
        path: '$.candidate.grouping.provider',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field provider.',
      },
    ],
    [
      'browserBuild',
      'chromium-139',
      {
        path: '$.candidate.grouping.browserBuild',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field browserBuild.',
      },
    ],
    [
      'databaseMode',
      'postgres',
      {
        path: '$.candidate.grouping.databaseMode',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field databaseMode.',
      },
    ],
    [
      'configurationIdentity',
      'innerRuns=6/cli',
      {
        path: '$.candidate.grouping.configurationIdentity',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field configurationIdentity.',
      },
    ],
    [
      'workloadId',
      'RTC-B02',
      {
        path: '$.candidate.grouping.workloadId',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field workloadId.',
      },
    ],
    [
      'caseId',
      'other-case',
      {
        path: '$.candidate.grouping.caseId',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field caseId.',
      },
    ],
    [
      'inputKey',
      'other-input',
      {
        path: '$.candidate.grouping.inputKey',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field inputKey.',
      },
    ],
    [
      'metric',
      'heapBytes',
      {
        path: '$.candidate.grouping.metric',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field metric.',
      },
    ],
    [
      'unit',
      'bytes',
      {
        path: '$.candidate.grouping.unit',
        code: 'paired-grouping-mismatch',
        message: 'Paired comparison differs by non-Git grouping field unit.',
      },
    ],
  ] as const)('rejects paired comparison non-Git mismatch %s', (field, changed, expectedIssue) => {
    const candidate = {
      ...grouping,
      headCommit: '1111111111111111111111111111111111111111',
      headTree: '2222222222222222222222222222222222222222',
      [field]: changed,
    };
    const result = compareRtcBaselinePairedCohorts(
      { grouping, values: [10, 10, 10] },
      { grouping: candidate, values: [9, 9, 9] },
    );
    expect(result).toEqual({
      ok: false,
      issues: [expectedIssue],
    });
  });
});
