import { describe, expect, it } from 'vitest';
import {
  compareStateWriteArtifacts,
  validateStateWriteArtifact,
} from '../../../scripts/perf/compare-api-v1-state-write-results.mjs';
import {
  GROUP_TOPOLOGY_CONFLICT_REASON,
  GROUP_TOPOLOGY_CONFLICT_REASON_SCHEMA,
  GROUP_TOPOLOGY_PERFORMANCE_BASE_COMMIT,
} from '../../../scripts/perf/pool-group-topology-state-write-position-balanced-results.mjs';
import {
  createStateWritePerformanceArtifact,
  refreshStateWritePerformanceWorkload,
} from './state-write-performance-artifact-fixture.ts';
import { swapCompleteDurableResults } from './state-write-performance-result-fixture.ts';

const CANDIDATE_COMMIT = '74a62eb22583216e8c6651de069209d7e1a8ca67';
const CANDIDATE_TREE = '7f971bcf84aa494265992d17e3c9b99227bd8122';
describe('API-v1 state-write final durable evidence', { timeout: 30_000 }, () => {
  it('accepts a complete AppInbox/ResourceInbox candidate and legacy baseline', () => {
    const candidate = createStateWritePerformanceArtifact(true);
    expect(candidate.measurement.counterSources.outbox).toBe('resource_inbox');
    expect(candidate.measurement.counterSources.attempts).toBe(
      'resource_inbox.release.telemetry+app_inbox.ri_attempts reconciliation',
    );
    expect(candidate.workloads[0].samples[0].durableEvidence.intermediateMutationIntents).toEqual(
      [],
    );
    expect(candidate.workloads[0].samples[0].correctness.atomicCompletionFailures).toBe(0);
    expect(validateStateWriteArtifact(createStateWritePerformanceArtifact(false))).toEqual([]);
    expect(validateStateWriteArtifact(candidate)).toEqual([]);
  });

  it('rejects intermediate intents and service-local attempt evidence', () => {
    const candidate = createStateWritePerformanceArtifact(true);
    const sample = candidate.workloads[0].samples[0];
    sample.durableEvidence.intermediateMutationIntents.push({ intentId: 'forbidden' });
    sample.attemptObservations[0].source = 'group-state-service.mutation.conflict';
    expectStateWriteArtifactIssues(
      candidate,
      'intermediateMutationIntents must be exactly empty',
      'production ResourceInbox release telemetry',
    );
  });

  it('rejects missing same-observation completion components', () => {
    for (const mutate of [
      (sample: any) => sample.durableEvidence.appInbox.shift(),
      (sample: any) => sample.durableEvidence.receipts.shift(),
      (sample: any) => sample.durableEvidence.resourceOutbox.shift(),
    ]) {
      const candidate = createStateWritePerformanceArtifact(true);
      mutate(candidate.workloads[0].samples[0]);
      refreshStateWritePerformanceWorkload(candidate.workloads[0]);
      expect(validateStateWriteArtifact(candidate)).not.toEqual([]);
    }
  });

  it('rejects malformed retry delay, due age, lane, and transaction evidence', () => {
    for (const field of ['retryDelayMs', 'dueAgeMs', 'transactionDurationMs'] as const) {
      const candidate = createStateWritePerformanceArtifact(true);
      candidate.workloads[0].samples[0].durableEvidence.appInbox[0][field] = -1;
      expectStateWriteArtifactIssues(candidate, 'appInbox[0] is malformed');
    }
    const lane = createStateWritePerformanceArtifact(true);
    lane.workloads[0].samples[0].durableEvidence.appInbox[0].selectedLane = 'unknown';
    expect(validateStateWriteArtifact(lane)).not.toEqual([]);
  });

  it('rejects invented retry history and zero-delay nonterminal conflicts', () => {
    const invented = createStateWritePerformanceArtifact(true);
    const inventedSample = invented.workloads[0].samples[0];
    inventedSample.attemptObservations.splice(1, 0, {
      ...inventedSample.attemptObservations[0],
      attempt: 2,
    });
    expectStateWriteArtifactIssues(invented, 'must reconcile exactly to durable AppInbox attempts');
    const zeroDelay = createStateWritePerformanceArtifact(true);
    const sample = zeroDelay.workloads[0].samples[0];
    const first = sample.attemptObservations[0];
    first.outcome = 'conflicted';
    first.terminal = false;
    first.retryDelayMs = 0;
    sample.attemptObservations.splice(1, 0, {
      ...first,
      attempt: 2,
      outcome: 'accepted',
      terminal: true,
    });
    sample.durableEvidence.appInbox[0].attempts = 2;
    expectStateWriteArtifactIssues(zeroDelay, 'nonterminal retryDelayMs must be positive');
  });

  it('distinguishes typed transient retries from optimistic conflicts', () => {
    const candidate = createStateWritePerformanceArtifact(true);
    const sample = candidate.workloads[0].samples[0];
    const first = sample.attemptObservations[0];
    first.outcome = 'transient-retry';
    first.terminal = false;
    first.retryDelayMs = 2;
    first.failure = { kind: 'retryable', code: 'ECONNRESET', name: 'Error' };
    sample.attemptObservations.splice(1, 0, {
      ...first,
      attempt: 2,
      outcome: 'accepted',
      terminal: true,
      failure: { kind: 'none' },
    });
    sample.durableEvidence.appInbox[0].attempts = 2;
    refreshStateWritePerformanceWorkload(candidate.workloads[0]);
    expect(validateStateWriteArtifact(candidate)).toEqual([]);
    first.outcome = 'conflicted';
    expectStateWriteArtifactIssues(candidate, 'only recognized optimistic conflicts');
  });

  it('rejects malformed durable results and receipt/effect identity mismatches', () => {
    const malformed = createStateWritePerformanceArtifact(true);
    delete malformed.workloads[0].samples[0].durableEvidence.appInbox[0].durableResult;
    expectStateWriteArtifactIssues(malformed, 'persisted durable result is malformed');

    const mismatched = createStateWritePerformanceArtifact(true);
    mismatched.workloads[0].samples[0].durableEvidence.receipts[0].outboxIds = ['invented-effect'];
    expectStateWriteArtifactIssues(
      mismatched,
      'receipt outbox IDs must match exact ResourceInbox effects',
    );

    const embeddedTamper = createStateWritePerformanceArtifact(true);
    const embedded = embeddedTamper.workloads[0].samples[0].durableEvidence.appInbox.find(
      (entry: any) => entry.commandType.startsWith('GROUP_PRESENCE_'),
    );
    embedded.durableResult.outboxIds = ['invented-embedded-effect'];
    expectStateWriteArtifactIssues(
      embeddedTamper,
      'embedded result receipt must match authoritative receipt and effects',
    );

    const arbitraryKey = createStateWritePerformanceArtifact(true);
    const client = arbitraryKey.workloads[0].samples[0].durableEvidence.appInbox.find(
      (entry: any) => entry.commandType.startsWith('CLIENT_'),
    );
    client.durableResult.unreceipted = true;
    expectStateWriteArtifactIssues(arbitraryKey, 'persisted durable result is malformed');
    for (const prefix of ['CLIENT_', 'GROUP_']) {
      const swapped = createStateWritePerformanceArtifact(true);
      swapCompleteDurableResults(swapped, prefix);
      expect(validateStateWriteArtifact(swapped)).not.toEqual([]);
    }
    const missingTopologySibling = createStateWritePerformanceArtifact(true);
    const missingEntry =
      missingTopologySibling.workloads[0].samples[0].durableEvidence.appInbox.find(
        (entry: any) => entry.commandType === 'TOPOLOGY_CONFIG_PUT',
      );
    delete missingEntry.durableResult.config;
    expect(validateStateWriteArtifact(missingTopologySibling)).not.toEqual([]);
    const swappedTopologySibling = createStateWritePerformanceArtifact(true);
    const topologyEntries =
      swappedTopologySibling.workloads[0].samples[0].durableEvidence.appInbox.filter(
        (entry: any) => entry.commandType === 'TOPOLOGY_CONFIG_PUT',
      );
    [topologyEntries[0].durableResult.config, topologyEntries[1].durableResult.config] = [
      topologyEntries[1].durableResult.config,
      topologyEntries[0].durableResult.config,
    ];
    expect(validateStateWriteArtifact(swappedTopologySibling)).not.toEqual([]);
  });

  it('is total over malformed nested candidate evidence', () => {
    for (const mutate of [
      (candidate: any) => (candidate.workloads[0].samples[0].durableEvidence = null),
      (candidate: any) => delete candidate.workloads[0].samples[0].durableEvidence.appInbox[0],
      (candidate: any) => (candidate.workloads[0].samples[0].durableEvidence.receipts[0] = null),
      (candidate: any) =>
        (candidate.workloads[0].samples[0].durableEvidence.resourceOutbox[0] = null),
    ]) {
      const candidate = createStateWritePerformanceArtifact(true);
      mutate(candidate);
      expect(() => validateStateWriteArtifact(candidate)).not.toThrow();
      expect(validateStateWriteArtifact(candidate)).not.toEqual([]);
      expect(() =>
        compareStateWriteArtifacts(createStateWritePerformanceArtifact(false), candidate),
      ).not.toThrow();
    }
  });

  it('preserves scale, retry-exhaustion, latency, throughput, and resource gates', () => {
    const baseline = createStateWritePerformanceArtifact(false);
    const candidate = createStateWritePerformanceArtifact(true);
    candidate.workloads[0].scale.clients = 99;
    candidate.workloads[0].summary.latencyMs.p95 *= 2;
    candidate.workloads[1].summary.throughputPerSecond = 1;
    candidate.workloads[1].summary.outcomes.exhausted = 1;
    candidate.workloads[1].summary.sql.statements += 1;
    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('scale.clients must equal 100'),
        expect.stringContaining('summary.latencyMs.p95 does not match raw samples'),
        expect.stringContaining('summary.throughputPerSecond does not match raw samples'),
        expect.stringContaining('summary.outcomes.exhausted does not match raw samples'),
        expect.stringContaining('summary.sql.statements does not match sample median'),
      ]),
    );
  });

  it('keeps setup and evidence reads outside measured mutation timing', async () => {
    const bench = await import('../../../scripts/perf/api-v1-state-write-concurrency-bench.ts');
    expect(bench.classifyBenchmarkSql('select * from resource_inbox', [])).toBe('read');
    expect(
      bench.readResourceEffectKind({
        ri_resource_id: 'command:principal-state:event:revision=1',
        ri_topic_id: 'client-state.event',
        ri_type_id: 'WS_OUTBOX',
        ri_resource: '{}',
      }),
    ).toBe('principal-state:event');
    expect(
      bench.readAllCommandIds(
        JSON.stringify({
          payload: {
            resource: JSON.stringify({ data: { request: { requestId: 'nested-command' } } }),
          },
        }),
      ),
    ).toContain('nested-command');
    expect(
      bench.readAllCommandIds(
        JSON.stringify({
          id: { msgId: 'raw-command:rtc-topology-recompute:group-revision:group=1;presence=0' },
          payload: {
            resource: JSON.stringify({ data: { event: { requestId: 'stale-command' } } }),
          },
        }),
      )[0],
    ).toBe('raw-command');
    expect(
      bench.readCanonicalEffectCommandId(
        JSON.stringify({
          id: {
            msgId: 'topology-command:rtc-topology-recompute:group-revision:group=1;presence=0',
          },
          payload: {
            resource: JSON.stringify({ data: { event: { requestId: 'config-command' } } }),
          },
        }),
      ),
    ).toBe('topology-command');
    const topologyCommand = {
      kind: 'topology-source',
      commandId: 'topology-command',
      stackIndex: 0,
      latencyMs: 1,
      status: 'accepted',
    } as const;
    const topologyRecord = {
      resourceId: 'stored-effect',
      outboxId: 'topology-command:rtc-topology-recompute:group-revision:group=1;presence=0',
      typeId: 'APP_OUTBOX',
      topicId: 'app-outbox.rtc-topology',
      effectKind: 'rtc-topology-recompute',
      canonicalCommandId: 'topology-command',
      commandIds: ['topology-command', 'config-command'],
    } as const;
    expect(
      bench.projectProductionOutboxEvidence(
        [topologyCommand],
        [
          {
            commandId: 'topology-command',
            receiptIds: ['topology-command'],
            outboxIds: [topologyRecord.outboxId],
            identityKind: 'logical-msg-id',
          },
        ],
        [topologyRecord],
      )[0],
    ).toMatchObject({
      commandId: 'topology-command',
      effectId: topologyRecord.outboxId,
      resourceId: 'stored-effect',
      outboxId: topologyRecord.outboxId,
    });
    expect(bench.projectProductionOutboxEvidence([topologyCommand], [], [topologyRecord])).toEqual(
      [],
    );
    expect(
      bench.productionOutboxLookupIds(
        {
          kind: 'topology-source',
          commandId: 'bench:topology-source:7',
          stackIndex: 0,
          latencyMs: 1,
          status: 'accepted',
        },
        { applicationId: 'app', workspaceId: 'workspace' },
        5,
        ['bench:topology-source:7:rtc-topology-recompute:group-revision:group=1;presence=0'],
      )[0],
    ).toMatch(/^bench-topology-source--[a-z0-9]+$/);
    expect(
      bench.parseBenchmarkOptions([
        '--backend=postgres',
        '--warmup=1',
        '--runs=3',
        '--concurrency=10',
        '--out=tmp/perf/candidate.json',
      ]),
    ).toEqual({
      backend: 'postgres',
      warmup: 1,
      runs: 3,
      concurrency: 10,
      out: 'tmp/perf/candidate.json',
    });
  });

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
    expect(createArtifact([]).regressionReasons).toEqual([]);
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
    expect(
      Array.from(new Uint8Array(artifactDigest), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      ),
    ).toBe('70a977c657cd1d0ae850b291d19872a73932c6e46050855acfed3131741f70dd');
    expect(() =>
      bench.parseBenchmarkOptions(['--regression-reasons-file=tmp/perf/../topology-reasons.json']),
    ).toThrow(/must remain under tmp\/perf/);
    for (const mutate of conflictReasonFailures()) {
      const malformed = structuredClone(input);
      mutate(malformed);
      expect(() => parseReasons(JSON.stringify(malformed))).toThrow(/conflict reason/);
    }
  });
});
const CANDIDATE_IDENTITY = { commit: CANDIDATE_COMMIT, tree: CANDIDATE_TREE } as const;
function createConflictReasonInput(): any {
  const metrics = [
    'sql.statements',
    'sql.rowsRead',
    'sql.serializedResultBytes',
    'postgres.transactionDurationMs',
  ];
  return {
    schemaVersion: GROUP_TOPOLOGY_CONFLICT_REASON_SCHEMA,
    baseCommit: GROUP_TOPOLOGY_PERFORMANCE_BASE_COMMIT,
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
    (input) => (input.candidateCommit = GROUP_TOPOLOGY_PERFORMANCE_BASE_COMMIT),
    (input) => (input.candidateTree = GROUP_TOPOLOGY_PERFORMANCE_BASE_COMMIT),
    (input) => input.reasons.pop(),
    (input) => (input.reasons[0].metric = 'sql.unsupported'),
    (input) => (input.reasons[0].reason = 'written after measurement'),
    (input) => ([input.reasons[0], input.reasons[1]] = [input.reasons[1], input.reasons[0]]),
  ];
}

function expectStateWriteArtifactIssues(candidate: unknown, ...messages: readonly string[]): void {
  expect(validateStateWriteArtifact(candidate)).toEqual(
    expect.arrayContaining(messages.map((message) => expect.stringContaining(message))),
  );
}
