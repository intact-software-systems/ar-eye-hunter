import { describe, expect, it } from 'vitest';
import {
  compareStateWriteArtifacts,
  STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
  validateStateWriteArtifact,
} from '../../../scripts/perf/compare-api-v1-state-write-results.mjs';

const MUTATION_MIX = [
  'profile-instance',
  'membership',
  'presence-connect',
  'presence-heartbeat',
  'presence-disconnect',
  'config',
  'topology-source',
] as const;

describe('API-v1 state-write performance artifact contract', () => {
  it('accepts the exact workloads, scale, repetitions, raw samples, metrics, and correctness counters', () => {
    expect(validateStateWriteArtifact(validArtifact())).toEqual([]);
  });

  it('rejects setup, authentication, or HTTP time in mutation latency', () => {
    const artifact = validArtifact();
    artifact.measurement.mutationTimingExcludes = ['http'];

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('mutationTimingExcludes'),
    ]));
  });

  it('rejects omitted conflict and retry-exhaustion metrics', () => {
    const artifact = validArtifact();
    delete (artifact.workloads[0]!.summary.outcomes as { conflicted?: number }).conflicted;
    delete (artifact.workloads[0]!.samples[0]!.outcomes as { exhausted?: number }).exhausted;

    const errors = validateStateWriteArtifact(artifact);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('conflicted'),
      expect.stringContaining('exhausted'),
    ]));
  });

  it('rejects missing phase, PostgreSQL, SQL, receipt, or outbox metrics', () => {
    const artifact = validArtifact();
    delete (artifact.workloads[1]!.summary.timingsMs as { validate?: number }).validate;
    delete (artifact.workloads[1]!.summary.postgres as { walBytes?: number }).walBytes;
    delete (artifact.workloads[1]!.summary.sql as { rowsRead?: number }).rowsRead;
    delete (artifact.workloads[1]!.summary.correctness as { receiptCount?: number }).receiptCount;
    delete (artifact.workloads[1]!.summary.correctness as { outboxIntentCount?: number })
      .outboxIntentCount;

    const errors = validateStateWriteArtifact(artifact);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('timingsMs.validate'),
      expect.stringContaining('postgres.walBytes'),
      expect.stringContaining('sql.rowsRead'),
      expect.stringContaining('correctness.receiptCount'),
      expect.stringContaining('correctness.outboxIntentCount'),
    ]));
  });

  it('requires every measured run and latency sample so tail observations cannot be discarded', () => {
    const artifact = validArtifact();
    artifact.workloads[2]!.samples.pop();

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('samples must contain exactly measurement.measuredRuns entries'),
    ]));
  });

  it('enforces uncontended tail-latency and shared/hot throughput budgets', () => {
    const baseline = validArtifact();
    const candidate = validArtifact();
    candidate.workloads[0].summary.latencyMs.p95 = 7.36;
    candidate.workloads[0].summary.latencyMs.p99 = 7.36;
    candidate.workloads[1].summary.throughputPerSecond = 6_999;
    candidate.workloads[2].summary.throughputPerSecond = 6_999;

    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('uncontended latency p95'),
      expect.stringContaining('uncontended latency p99'),
      expect.stringContaining('shared throughput regressed'),
      expect.stringContaining('hot throughput regressed'),
    ]));
  });

  it('requires shared throughput to improve after the presence split', () => {
    const baseline = validArtifact();
    const candidate = validArtifact();
    candidate.features = { presenceSplitFromGroupAggregate: true };

    expect(compareStateWriteArtifacts(baseline, candidate)).toContain(
      'shared throughput must improve after presence is split from the group aggregate',
    );
  });

  it('allows only reasoned median resource increases and enforces retry exhaustion', () => {
    const baseline = validArtifact();
    const candidate = validArtifact();
    for (const sample of candidate.workloads[1].samples) {
      sample.sql.statements += 1;
    }
    candidate.workloads[0].summary.outcomes.exhausted = 1;
    candidate.workloads[1].summary.outcomes.exhausted = 1;
    candidate.workloads[2].summary.outcomes.exhausted = 1;

    const errors = compareStateWriteArtifacts(baseline, candidate);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('median sql.statements increased without a recorded reason'),
      expect.stringContaining('uncontended retry exhaustion must remain zero'),
      expect.stringContaining('shared retry exhaustion must remain zero'),
      expect.stringContaining('hot retry exhaustion exceeded baseline'),
    ]));

    candidate.regressionReasons = [{
      workload: 'shared',
      metric: 'sql.statements',
      reason: 'Recorded measurement-method change',
    }];
    expect(compareStateWriteArtifacts(baseline, candidate)).not.toEqual(expect.arrayContaining([
      expect.stringContaining('median sql.statements increased without a recorded reason'),
    ]));
  });

  it('requires DBW linkage for baseline correctness failures without relaxing the candidate', () => {
    const baseline = validArtifact();
    const candidate = validArtifact();
    baseline.workloads[2].summary.correctness.receiptCount -= 1;

    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('baseline correctness already fails'),
      expect.stringContaining('no DBW finding linkage'),
    ]));

    baseline.workloads[2].summary.correctness.dbwFindings = ['DBW-EXAMPLE'];
    candidate.workloads[2].summary.correctness.receiptCount -= 1;
    candidate.workloads[2].summary.correctness.dbwFindings = ['DBW-EXAMPLE'];
    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('candidate correctness failed'),
    ]));
  });
});

function validArtifact(): any {
  return {
    schemaVersion: STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
    gitCommit: 'a76c6ee012345678901234567890123456789012',
    backend: 'postgres',
    generatedAt: '2026-07-18T00:00:00.000Z',
    measurement: {
      warmupRuns: 1,
      measuredRuns: 3,
      concurrency: 10,
      mutationTimingExcludes: ['setup', 'authentication', 'http'],
      tailSamplesDiscarded: false,
    },
    workloads: [
      workload('uncontended', 100),
      workload('shared', 5),
      workload('hot', 1),
    ],
  };
}

function workload(name: string, groups: number): any {
  const samples = Array.from({ length: 3 }, (_, runIndex) => sample(runIndex));
  return {
    name,
    scale: { clients: 100, groups, concurrency: 10 },
    mutationMix: [...MUTATION_MIX],
    warmupRuns: 1,
    measuredRuns: 3,
    samples,
    summary: metrics(samples.flatMap((entry) => entry.latencySamplesMs)),
  };
}

function sample(runIndex: number): any {
  return {
    runIndex,
    durationMs: 100,
    throughputPerSecond: 7000,
    latencySamplesMs: [1, 2, 3, 4, 5, 6, 7],
    ...metrics([1, 2, 3, 4, 5, 6, 7]),
  };
}

function metrics(latencySamplesMs: number[]): any {
  return {
    latencyMs: { p50: 4, p95: 7, p99: 7 },
    throughputPerSecond: 7000,
    outcomes: {
      accepted: latencySamplesMs.length,
      conflicted: 0,
      exhausted: 0,
      attempts: latencySamplesMs.length,
      attemptsPerAcceptedMutation: 1,
    },
    sql: {
      statements: 20,
      rowsRead: 10,
      serializedResultBytes: 1000,
    },
    postgres: {
      transactionDurationMs: 80,
      lockWaitMs: 0,
      cpuTimeMs: 30,
      sharedBufferHits: 100,
      sharedBufferReads: 2,
      walBytes: 4096,
    },
    timingsMs: {
      read: 20,
      compute: 5,
      validate: 5,
      write: 40,
      transaction: 80,
      outbox: 10,
    },
    correctness: {
      acceptedCommandCount: latencySamplesMs.length,
      receiptCount: latencySamplesMs.length,
      effectfulCommandCount: latencySamplesMs.length,
      requiredOutboxIntentCount: latencySamplesMs.length * 2,
      outboxIntentCount: latencySamplesMs.length * 2,
      dbwFindings: [],
    },
  };
}
