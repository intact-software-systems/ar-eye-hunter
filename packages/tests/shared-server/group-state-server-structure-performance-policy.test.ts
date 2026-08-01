import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  applyGroupStateServerStructurePerformancePolicy,
  compareGroupStateServerStructurePerformance,
  validateGroupStateServerStructureEvidence,
} from '../../../scripts/perf/compare-group-state-server-structure-performance.mjs';
import {
  createStateWritePerformanceArtifact,
  refreshStateWritePerformanceWorkload,
} from './state-write-performance-artifact-fixture.ts';

interface ResourceMetricInput {
  readonly artifact: any;
  readonly workloadName: string;
  readonly owner: string;
  readonly metric: string;
}

interface SetResourceAdverseRatioInput extends ResourceMetricInput {
  readonly ratio: number;
}

interface SetResourceValueInput extends ResourceMetricInput {
  readonly value: number;
}

describe('group-state server structure performance policy', { timeout: 120_000 }, () => {
  it.each([
    ['uncontended', 'sql', 'statements'],
    ['shared', 'sql', 'rowsRead'],
    ['hot', 'sql', 'serializedResultBytes'],
    ['shared', 'postgres', 'transactionDurationMs'],
  ])('accepts exactly 1.5 percent adverse %s %s.%s movement', (workload, owner, metric) => {
    const { baseline, candidate } = createArtifactPair();
    setResourceAdverseRatio({
      artifact: candidate,
      workloadName: workload,
      owner,
      metric,
      ratio: 0.015,
    });

    expect(compareGroupStateServerStructurePerformance(baseline, candidate)).toEqual([]);
  });

  it('rejects adverse movement greater than 1.5 percent', () => {
    const throughput = createArtifactPair();
    setThroughputAdverseRatio(throughput.candidate, 'shared', 0.015_001);
    expect(
      compareGroupStateServerStructurePerformance(throughput.baseline, throughput.candidate),
    ).toEqual(expect.arrayContaining([expect.stringContaining('shared throughput')]));

    const resource = createArtifactPair();
    setResourceAdverseRatio({
      artifact: resource.candidate,
      workloadName: 'shared',
      owner: 'sql',
      metric: 'statements',
      ratio: 0.015_001,
    });
    expect(
      compareGroupStateServerStructurePerformance(resource.baseline, resource.candidate),
    ).toEqual(expect.arrayContaining([expect.stringContaining('sql.statements')]));
  });

  it('accepts the exact boundary and rejects its next adverse floating-point value', () => {
    expect(evaluateSharedThroughput(0.985)).toEqual([]);
    expect(evaluateSharedThroughput(adjacentFloat(0.985, -1n))).not.toEqual([]);
    expect(evaluateSharedRows(1.015)).toEqual([]);
    expect(evaluateSharedRows(adjacentFloat(1.015, 1n))).not.toEqual([]);
  });

  it('accepts improvements larger than the equivalence band', () => {
    const { baseline, candidate } = createArtifactPair();
    setThroughputAdverseRatio(candidate, 'shared', -0.2);
    setResourceAdverseRatio({
      artifact: candidate,
      workloadName: 'hot',
      owner: 'sql',
      metric: 'serializedResultBytes',
      ratio: -0.2,
    });

    expect(compareGroupStateServerStructurePerformance(baseline, candidate)).toEqual([]);
  });

  it('retains the 5 percent uncontended-tail and 10 percent hot-throughput limits', () => {
    const pair = createArtifactPair();
    const tailError = 'uncontended latency p95 remains a global finding';
    pair.baseline.workloads[2].summary.throughputPerSecond = 1;
    pair.candidate.workloads[2].summary.throughputPerSecond = 0.9;
    expect(evaluatePolicy(pair, [hotThroughputError(0.9), tailError])).toEqual([tailError]);
    const belowHotBoundary = adjacentFloat(0.9, -1n);
    pair.candidate.workloads[2].summary.throughputPerSecond = belowHotBoundary;
    expect(evaluatePolicy(pair, [hotThroughputError(belowHotBoundary), tailError])).not.toEqual([
      tailError,
    ]);
  });

  it('fails closed when a zero baseline resource becomes nonzero', () => {
    const { baseline, candidate } = createArtifactPair();
    setResourceValue({
      artifact: baseline,
      workloadName: 'shared',
      owner: 'sql',
      metric: 'rowsRead',
      value: 0,
    });
    setResourceValue({
      artifact: candidate,
      workloadName: 'shared',
      owner: 'sql',
      metric: 'rowsRead',
      value: 1,
    });

    expect(compareGroupStateServerStructurePerformance(baseline, candidate)).toEqual(
      expect.arrayContaining([expect.stringContaining('zero baseline')]),
    );
  });

  it('preserves correctness failures regardless of performance movement', () => {
    const { baseline, candidate } = createArtifactPair();
    candidate.workloads[0].samples[0].durableEvidence.receipts.shift();

    expect(compareGroupStateServerStructurePerformance(baseline, candidate)).toEqual(
      expect.arrayContaining([expect.stringContaining('candidate:')]),
    );
  });

  it('rejects missing or unknown pooled A-B-B-A metadata', () => {
    const { baseline, candidate } = createArtifactPair();
    delete baseline.aggregation;
    expect(compareGroupStateServerStructurePerformance(baseline, candidate)).toEqual(
      expect.arrayContaining([expect.stringContaining('pooled A-B-B-A')]),
    );
    baseline.aggregation = createAggregation('approved-base', 'a', 'b');
    baseline.aggregation.unexpected = true;
    expect(compareGroupStateServerStructurePerformance(baseline, candidate)).toEqual(
      expect.arrayContaining([expect.stringContaining('exact pooled A-B-B-A metadata')]),
    );
  });

  it('binds the pooled outputs to the exact governed manifest hash', () => {
    const baselineText = 'baseline\n';
    const candidateText = 'candidate\n';
    const manifestText = `${JSON.stringify({
      schemaVersion: 'rallar.api-v1.state-write.order-balanced-abba.v1',
      outputs: {
        approvedBase: { sha256: sha256(baselineText) },
        candidate: { sha256: sha256(candidateText) },
      },
    })}\n`;
    const evidence = {
      baselineText,
      candidateText,
      manifestText,
      expectedManifestSha256: sha256(manifestText),
    };

    expect(validateGroupStateServerStructureEvidence(evidence)).toEqual([]);
    expect(
      validateGroupStateServerStructureEvidence({
        ...evidence,
        candidateText: `${candidateText}tampered`,
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('candidate output hash')]));
    expect(
      validateGroupStateServerStructureEvidence({
        ...evidence,
        expectedManifestSha256: '0'.repeat(64),
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('manifest hash')]));
    expect(() => validateGroupStateServerStructureEvidence(undefined)).not.toThrow();
    expect(validateGroupStateServerStructureEvidence(undefined)).not.toEqual([]);
  });

  it('fails closed on a newly introduced global-comparator finding', () => {
    const { baseline, candidate } = createArtifactPair();
    const errors = applyGroupStateServerStructurePerformancePolicy({
      baseline,
      candidate,
      globalErrors: [
        'shared throughput must improve after presence is split from the group aggregate',
        'future comparator finding',
      ],
    });

    expect(errors).toEqual(['future comparator finding']);
  });

  it('accepts above-band cost only with reconciled raw conflict-depth evidence', () => {
    const { baseline, candidate } = createArtifactPair();
    candidate.regressionReasons.push(conflictRegressionReason());
    addConflicts(findWorkload(candidate, 'hot'), 17);
    setResourceValue({
      artifact: candidate,
      workloadName: 'hot',
      owner: 'sql',
      metric: 'statements',
      value: 20.4,
    });

    expect(compareGroupStateServerStructurePerformance(baseline, candidate)).toEqual([]);
  });

  it('rejects prose, missing attempts, and concentrated conflict depth independently', () => {
    const proseOnly = createAboveBandConflictPolicy();
    expect(applyGroupStateServerStructurePerformancePolicy(proseOnly)).not.toEqual([]);

    const missingAttempts = createAboveBandConflictPolicy();
    for (const sample of missingAttempts.candidate.workloads[2].samples) {
      sample.outcomes = { ...sample.outcomes, conflicted: 17 };
    }
    expect(applyGroupStateServerStructurePerformancePolicy(missingAttempts)).not.toEqual([]);

    const concentrated = createAboveBandConflictPolicy();
    concentrated.candidate.workloads[2].samples[0].outcomes = {
      ...concentrated.candidate.workloads[2].samples[0].outcomes,
      conflicted: 600,
      attempts: 1400,
    };
    expect(applyGroupStateServerStructurePerformancePolicy(concentrated)).not.toEqual([]);

    for (const [baselineValue, candidateValue] of [
      [1e307, 1.02e307],
      [Number.MIN_VALUE, Number.MIN_VALUE * 2],
    ]) {
      expectExtremeConflictCostRejected(baselineValue, candidateValue);
    }
  });
});

function createArtifactPair() {
  const baseline = createStateWritePerformanceArtifact(false, {
    artifactId: 'baseline',
    measuredRuns: 18,
  });
  const candidate = createStateWritePerformanceArtifact(true, {
    artifactId: 'candidate',
    measuredRuns: 18,
  });
  baseline.aggregation = createAggregation('approved-base', 'a', 'b');
  candidate.aggregation = createAggregation('candidate', 'c', 'd');
  return { baseline, candidate };
}

function createAggregation(role: string, first: string, second: string) {
  return {
    protocol: 'rallar.api-v1.state-write.order-balanced-abba.v1',
    role,
    environmentSha256: 'e'.repeat(64),
    sourceArtifactSha256: [first.repeat(64), second.repeat(64)],
  };
}

function createAboveBandConflictPolicy() {
  const { baseline, candidate } = createArtifactPair();
  candidate.regressionReasons.push(conflictRegressionReason());
  baseline.workloads[2].summary.sql.statements = 20;
  candidate.workloads[2].summary.sql.statements = 20.4;
  for (const sample of candidate.workloads[2].samples) {
    sample.sql.statements = 20.4;
  }
  return {
    baseline,
    candidate,
    globalErrors: [sharedImprovementError()],
  };
}

function conflictRegressionReason() {
  return {
    workload: 'hot',
    metric: 'sql.statements',
    reason: 'Measured conflict depth accounts for this increase.',
  };
}

function expectExtremeConflictCostRejected(baselineValue: number, candidateValue: number): void {
  const policy = createAboveBandConflictPolicy();
  for (const sample of policy.baseline.workloads[2].samples) {
    sample.sql.statements = baselineValue;
  }
  for (const sample of policy.candidate.workloads[2].samples) {
    sample.sql.statements = candidateValue;
    sample.outcomes = { ...sample.outcomes, conflicted: 1, attempts: 801 };
  }
  policy.baseline.workloads[2].summary.sql.statements = baselineValue;
  policy.candidate.workloads[2].summary.sql.statements = candidateValue;
  expect(applyGroupStateServerStructurePerformancePolicy(policy)).not.toEqual([]);
}

function addConflicts(workload: any, count: number): void {
  for (const sample of workload.samples) {
    for (const entry of sample.durableEvidence.appInbox.slice(0, count)) {
      entry.attempts = 2;
      const index = sample.attemptObservations.findIndex(
        (attempt: any) =>
          attempt.commandId === entry.commandId && attempt.operationId === entry.operationId,
      );
      const accepted = { ...sample.attemptObservations[index], attempt: 2 };
      const conflicted = {
        ...accepted,
        attempt: 1,
        outcome: 'conflicted',
        terminal: false,
        retryDelayMs: 1,
        failure: { kind: 'retryable', code: 'runtime-state-write-conflict', name: 'Error' },
      };
      sample.attemptObservations.splice(index, 1, conflicted, accepted);
    }
  }
  refreshStateWritePerformanceWorkload(workload);
}

function setThroughputAdverseRatio(artifact: any, workloadName: string, ratio: number): void {
  const workload = findWorkload(artifact, workloadName);
  for (const sample of workload.samples) {
    sample.durationMs = 100 / (1 - ratio);
    sample.throughputPerSecond = 700 / (sample.durationMs / 1000);
  }
  refreshStateWritePerformanceWorkload(workload);
}

function setResourceAdverseRatio(input: SetResourceAdverseRatioInput): void {
  const workload = findWorkload(input.artifact, input.workloadName);
  const baselineValue = workload.samples[0][input.owner][input.metric];
  setResourceValue({ ...input, value: baselineValue * (1 + input.ratio) });
}

function setResourceValue(input: SetResourceValueInput): void {
  const workload = findWorkload(input.artifact, input.workloadName);
  for (const sample of workload.samples) {
    sample[input.owner][input.metric] = input.value;
  }
  refreshStateWritePerformanceWorkload(workload);
}

function findWorkload(artifact: any, workloadName: string): any {
  return artifact.workloads.find((workload: any) => workload.name === workloadName);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sharedImprovementError(): string {
  return 'shared throughput must improve after presence is split from the group aggregate';
}

function evaluatePolicy(pair: ReturnType<typeof createArtifactPair>, errors: string[]): string[] {
  return applyGroupStateServerStructurePerformancePolicy({ ...pair, globalErrors: errors });
}

function hotThroughputError(candidate: number): string {
  return `hot throughput regressed: baseline=1, candidate=${candidate}`;
}

function evaluateSharedThroughput(candidateThroughput: number): string[] {
  const pair = createArtifactPair();
  pair.baseline.workloads[1].summary.throughputPerSecond = 1;
  pair.candidate.workloads[1].summary.throughputPerSecond = candidateThroughput;
  return applyGroupStateServerStructurePerformancePolicy({
    ...pair,
    globalErrors: [
      `shared throughput regressed: baseline=1, candidate=${candidateThroughput}`,
      sharedImprovementError(),
    ],
  });
}

function evaluateSharedRows(candidateRows: number): string[] {
  const pair = createArtifactPair();
  pair.baseline.workloads[1].summary.sql.rowsRead = 1;
  pair.candidate.workloads[1].summary.sql.rowsRead = candidateRows;
  return applyGroupStateServerStructurePerformancePolicy({
    ...pair,
    globalErrors: [resourceRegressionError(candidateRows)],
  });
}

function resourceRegressionError(candidate: number): string {
  return (
    'shared median sql.rowsRead increased without a recorded reason: ' +
    `baseline=1, candidate=${candidate}`
  );
}

function adjacentFloat(value: number, direction: bigint): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + direction);
  return view.getFloat64(0);
}
