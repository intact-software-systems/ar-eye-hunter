import { describe, expect, it } from 'vitest';

import {
  GROUP_TOPOLOGY_CONFLICT_REASON,
  GROUP_TOPOLOGY_CONFLICT_REASON_SCHEMA,
} from '../../../scripts/perf/pool-group-topology-state-write-position-balanced-results.mjs';

const APPROVED_PR_C_BASE_COMMIT = '1e5f5e55e6ff94c016bfe2cc11af92952a30e32f';
const CANDIDATE_COMMIT = '74a62eb22583216e8c6651de069209d7e1a8ca67';
const CANDIDATE_TREE = '7f971bcf84aa494265992d17e3c9b99227bd8122';
const CANDIDATE_IDENTITY = { commit: CANDIDATE_COMMIT, tree: CANDIDATE_TREE } as const;

describe('API-v1 state-write topology regression reasons', { timeout: 30_000 }, () => {
  it('binds precommitted topology conflict reasons before measurement', async () => {
    const bench = await import('../../../scripts/perf/api-v1-state-write-concurrency-bench.ts');
    const artifactOwner =
      await import('../../../scripts/perf/state-write/api-v1-state-write-benchmark-artifact.ts');
    const input = createConflictReasonInput();
    const parseReasons = (text: string | undefined) =>
      bench.parseGroupTopologyRegressionReasons(text, CANDIDATE_IDENTITY);
    expect(parseReasons(undefined)).toEqual([]);
    expect(parseReasons(JSON.stringify(input))).toEqual(input.reasons);
    expect(
      bench.parseBenchmarkOptions(['--regression-reasons-file=tmp/perf/topology-reasons.json']),
    ).toMatchObject({ regressionReasonsFile: 'tmp/perf/topology-reasons.json' });
    const createArtifact = (regressionReasons: readonly unknown[]) =>
      artifactOwner.createStateWriteBenchmarkArtifact({
        generatedAt: '2026-08-09T00:00:00.000Z',
        gitIdentity: CANDIDATE_IDENTITY,
        options: bench.parseBenchmarkOptions([]),
        regressionReasons,
        workloads: [{ name: 'sentinel-workload' }],
      });
    expect(createArtifact(parseReasons(JSON.stringify(input))).regressionReasons).toEqual(
      input.reasons,
    );
    expect(createArtifact([])).toMatchObject({ regressionReasons: [] });
    expect(createArtifact([])).not.toHaveProperty('features');
    const artifactBytes = new TextEncoder().encode(
      `${JSON.stringify(
        createArtifact([
          { workload: 'shared', metric: 'sql.statements', reason: 'precommitted reason' },
        ]),
        null,
        2,
      )}\n`,
    );
    const artifactDigest = await crypto.subtle.digest('SHA-256', artifactBytes);
    expect(toHex(artifactDigest)).toBe(
      '36b2810baac9613e69c4152eb60e66e548bea94636aead2e5b3b35fd1f1b55e3',
    );
    expect(() =>
      bench.parseBenchmarkOptions(['--regression-reasons-file=tmp/perf/../topology-reasons.json']),
    ).toThrow(/must remain under tmp\/perf/);
    for (const mutate of conflictReasonFailures()) {
      const malformed = structuredClone(input);
      mutate(malformed);
      expect(() => parseReasons(JSON.stringify(malformed))).toThrow(/conflict reason/);
    }
  });

  it('selects RTC durable-append reasons without contaminating other captures', async () => {
    const bench = await import('../../../scripts/perf/api-v1-state-write-concurrency-bench.ts');
    const rtcOptions = bench.parseBenchmarkOptions([
      '--regression-reason-profile=rtc-topology-durable-append',
    ]);
    expect(rtcOptions).toMatchObject({
      regressionReasonProfile: 'rtc-topology-durable-append',
    });
    expect(
      bench.selectStateWriteRegressionReasons(rtcOptions.regressionReasonProfile, []),
    ).toHaveLength(12);

    const ordinaryOptions = bench.parseBenchmarkOptions([]);
    expect(
      bench.selectStateWriteRegressionReasons(ordinaryOptions.regressionReasonProfile, []),
    ).toEqual([]);

    const groupTopologyOptions = bench.parseBenchmarkOptions([
      '--regression-reasons-file=tmp/perf/topology-reasons.json',
    ]);
    const groupTopologyReasons = createConflictReasonInput().reasons;
    expect(
      bench.selectStateWriteRegressionReasons(
        groupTopologyOptions.regressionReasonProfile,
        groupTopologyReasons,
      ),
    ).toEqual(groupTopologyReasons);

    expect(() =>
      bench.parseBenchmarkOptions([
        '--regression-reason-profile=rtc-topology-durable-append',
        '--regression-reasons-file=tmp/perf/topology-reasons.json',
      ]),
    ).toThrow(/cannot be combined/);
    expect(() => bench.parseBenchmarkOptions(['--regression-reason-profile=unapproved'])).toThrow(
      /Unsupported state-write regression reason profile/,
    );
  });
});

function createConflictReasonInput(): any {
  const metrics = [
    'sql.statements',
    'sql.rowsRead',
    'sql.serializedResultBytes',
    'postgres.transactionDurationMs',
  ];
  return {
    schemaVersion: GROUP_TOPOLOGY_CONFLICT_REASON_SCHEMA,
    baseCommit: APPROVED_PR_C_BASE_COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    reasons: ['uncontended', 'shared', 'hot'].flatMap((workload) =>
      metrics.map((metric) => ({ workload, metric, reason: GROUP_TOPOLOGY_CONFLICT_REASON })),
    ),
  };
}

function conflictReasonFailures(): readonly ((input: any) => void)[] {
  return [
    (input) => (input.extra = true),
    (input) => (input.baseCommit = CANDIDATE_COMMIT),
    (input) => (input.candidateCommit = APPROVED_PR_C_BASE_COMMIT),
    (input) => (input.candidateTree = APPROVED_PR_C_BASE_COMMIT),
    (input) => input.reasons.pop(),
    (input) => (input.reasons[0].metric = 'sql.unsupported'),
    (input) => (input.reasons[0].reason = 'written after measurement'),
    (input) => ([input.reasons[0], input.reasons[1]] = [input.reasons[1], input.reasons[0]]),
  ];
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
