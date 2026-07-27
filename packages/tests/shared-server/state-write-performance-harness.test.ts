import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareStateWriteArtifacts,
  PRODUCTION_STATE_WRITE_MUTATION_CONTRACT,
  STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
  validateStateWriteArtifact,
} from '../../../scripts/perf/compare-api-v1-state-write-results.mjs';
import { binding, durableResult, swapCompleteDurableResults } from './state-write-performance-result-fixture.ts';

const MIX = [
  'profile-instance',
  'membership',
  'presence-connect',
  'presence-heartbeat',
  'presence-disconnect',
  'config',
  'topology-source',
] as const;

describe('API-v1 state-write final durable evidence', () => {
  it('accepts a complete AppInbox/ResourceInbox candidate and legacy baseline', () => {
    const candidate = artifact(true);
    expect(candidate.measurement.counterSources.outbox).toBe('resource_inbox');
    expect(candidate.measurement.counterSources.attempts)
      .toBe('resource_inbox.release.telemetry+app_inbox.ri_attempts reconciliation');
    expect(candidate.workloads[0].samples[0].durableEvidence.intermediateMutationIntents)
      .toEqual([]);
    expect(candidate.workloads[0].samples[0].correctness.atomicCompletionFailures).toBe(0);
    expect(validateStateWriteArtifact(artifact(false))).toEqual([]);
    expect(validateStateWriteArtifact(candidate)).toEqual([]);
  });

  it('rejects intermediate intents and service-local attempt evidence', () => {
    const candidate = artifact(true);
    const sample = candidate.workloads[0].samples[0];
    sample.durableEvidence.intermediateMutationIntents.push({ intentId: 'forbidden' });
    sample.attemptObservations[0].source = 'group-state-service.mutation.conflict';
    expect(validateStateWriteArtifact(candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('intermediateMutationIntents must be exactly empty'),
      expect.stringContaining('production ResourceInbox release telemetry'),
    ]));
  });

  it('rejects missing same-observation completion components', () => {
    for (const mutate of [
      (sample: any) => sample.durableEvidence.appInbox.shift(),
      (sample: any) => sample.durableEvidence.receipts.shift(),
      (sample: any) => sample.durableEvidence.resourceOutbox.shift(),
    ]) {
      const candidate = artifact(true);
      mutate(candidate.workloads[0].samples[0]);
      refresh(candidate.workloads[0]);
      expect(validateStateWriteArtifact(candidate)).not.toEqual([]);
    }
  });

  it('rejects malformed retry delay, due age, lane, and transaction evidence', () => {
    for (const field of ['retryDelayMs', 'dueAgeMs', 'transactionDurationMs'] as const) {
      const candidate = artifact(true);
      candidate.workloads[0].samples[0].durableEvidence.appInbox[0][field] = -1;
      expect(validateStateWriteArtifact(candidate)).toEqual(expect.arrayContaining([
        expect.stringContaining('appInbox[0] is malformed'),
      ]));
    }
    const lane = artifact(true);
    lane.workloads[0].samples[0].durableEvidence.appInbox[0].selectedLane = 'unknown';
    expect(validateStateWriteArtifact(lane)).not.toEqual([]);
  });

  it('rejects invented retry history and zero-delay nonterminal conflicts', () => {
    const invented = artifact(true);
    const inventedSample = invented.workloads[0].samples[0];
    inventedSample.attemptObservations.splice(1, 0, {
      ...inventedSample.attemptObservations[0], attempt: 2,
    });
    expect(validateStateWriteArtifact(invented)).toEqual(expect.arrayContaining([
      expect.stringContaining('must reconcile exactly to durable AppInbox attempts'),
    ]));

    const zeroDelay = artifact(true);
    const sample = zeroDelay.workloads[0].samples[0];
    const first = sample.attemptObservations[0];
    first.outcome = 'conflicted';
    first.terminal = false;
    first.retryDelayMs = 0;
    sample.attemptObservations.splice(1, 0, {
      ...first, attempt: 2, outcome: 'accepted', terminal: true,
    });
    sample.durableEvidence.appInbox[0].attempts = 2;
    expect(validateStateWriteArtifact(zeroDelay)).toEqual(expect.arrayContaining([
      expect.stringContaining('nonterminal retryDelayMs must be positive'),
    ]));
  });

  it('distinguishes typed transient retries from optimistic conflicts', () => {
    const candidate = artifact(true);
    const sample = candidate.workloads[0].samples[0];
    const first = sample.attemptObservations[0];
    first.outcome = 'transient-retry';
    first.terminal = false;
    first.retryDelayMs = 2;
    first.failure = { kind: 'retryable', code: 'ECONNRESET', name: 'Error' };
    sample.attemptObservations.splice(1, 0, {
      ...first, attempt: 2, outcome: 'accepted', terminal: true,
      failure: { kind: 'none' },
    });
    sample.durableEvidence.appInbox[0].attempts = 2;
    refresh(candidate.workloads[0]);
    expect(validateStateWriteArtifact(candidate)).toEqual([]);

    first.outcome = 'conflicted';
    expect(validateStateWriteArtifact(candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('only recognized optimistic conflicts'),
    ]));
  });

  it('rejects malformed durable results and receipt/effect identity mismatches', () => {
    const malformed = artifact(true);
    delete malformed.workloads[0].samples[0].durableEvidence.appInbox[0].durableResult;
    expect(validateStateWriteArtifact(malformed)).toEqual(expect.arrayContaining([
      expect.stringContaining('persisted durable result is malformed'),
    ]));

    const mismatched = artifact(true);
    mismatched.workloads[0].samples[0].durableEvidence.receipts[0].outboxIds = ['invented-effect'];
    expect(validateStateWriteArtifact(mismatched)).toEqual(expect.arrayContaining([
      expect.stringContaining('receipt outbox IDs must match exact ResourceInbox effects'),
    ]));

    const embeddedTamper = artifact(true);
    const embedded = embeddedTamper.workloads[0].samples[0].durableEvidence.appInbox
      .find((entry: any) => entry.commandType.startsWith('GROUP_PRESENCE_'));
    embedded.durableResult.outboxIds = ['invented-embedded-effect'];
    expect(validateStateWriteArtifact(embeddedTamper)).toEqual(expect.arrayContaining([
      expect.stringContaining('embedded result receipt must match authoritative receipt and effects'),
    ]));

    const arbitraryKey = artifact(true);
    const client = arbitraryKey.workloads[0].samples[0].durableEvidence.appInbox
      .find((entry: any) => entry.commandType.startsWith('CLIENT_'));
    client.durableResult.unreceipted = true;
    expect(validateStateWriteArtifact(arbitraryKey)).toEqual(expect.arrayContaining([
      expect.stringContaining('persisted durable result is malformed'),
    ]));
    for (const prefix of ['CLIENT_', 'GROUP_']) {
      const swapped = artifact(true);
      swapCompleteDurableResults(swapped, prefix);
      expect(validateStateWriteArtifact(swapped)).not.toEqual([]);
    }
  });

  it('is total over malformed nested candidate evidence', () => {
    for (const mutate of [
      (candidate: any) => candidate.workloads[0].samples[0].durableEvidence = null,
      (candidate: any) => delete candidate.workloads[0].samples[0].durableEvidence.appInbox[0],
      (candidate: any) => candidate.workloads[0].samples[0].durableEvidence.receipts[0] = null,
      (candidate: any) => candidate.workloads[0].samples[0].durableEvidence.resourceOutbox[0] = null,
    ]) {
      const candidate = artifact(true);
      mutate(candidate);
      expect(() => validateStateWriteArtifact(candidate)).not.toThrow();
      expect(validateStateWriteArtifact(candidate)).not.toEqual([]);
      expect(() => compareStateWriteArtifacts(artifact(false), candidate)).not.toThrow();
    }
  });

  it('preserves scale, retry-exhaustion, latency, throughput, and resource gates', () => {
    const baseline = artifact(false);
    const candidate = artifact(true);
    candidate.workloads[0].scale.clients = 99;
    candidate.workloads[0].summary.latencyMs.p95 *= 2;
    candidate.workloads[1].summary.throughputPerSecond = 1;
    candidate.workloads[1].summary.outcomes.exhausted = 1;
    candidate.workloads[1].summary.sql.statements += 1;
    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('scale.clients must equal 100'),
      expect.stringContaining('summary.latencyMs.p95 does not match raw samples'),
      expect.stringContaining('summary.throughputPerSecond does not match raw samples'),
      expect.stringContaining('summary.outcomes.exhausted does not match raw samples'),
      expect.stringContaining('summary.sql.statements does not match sample median'),
    ]));
  });

  it('keeps setup and evidence reads outside measured mutation timing', async () => {
    const bench = await import('../../../scripts/perf/api-v1-state-write-concurrency-bench.ts');
    expect(bench.classifyBenchmarkSql('select * from resource_inbox', [])).toBe('read');
    expect(bench.readResourceEffectKind({
      ri_resource_id: 'command:principal-state:event:revision=1',
      ri_topic_id: 'client-state.event', ri_type_id: 'WS_OUTBOX', ri_resource: '{}',
    })).toBe('principal-state:event');
    expect(bench.readAllCommandIds(JSON.stringify({
      payload: { resource: JSON.stringify({ data: { request: { requestId: 'nested-command' } } }) },
    }))).toContain('nested-command');
    expect(bench.readAllCommandIds(JSON.stringify({
      id: { msgId: 'raw-command:rtc-topology-recompute:group-revision:group=1;presence=0' },
      payload: { resource: JSON.stringify({ data: { event: { requestId: 'stale-command' } } }) },
    }))[0]).toBe('raw-command');
    expect(bench.readCanonicalEffectCommandId(JSON.stringify({
      id: { msgId: 'topology-command:rtc-topology-recompute:group-revision:group=1;presence=0' },
      payload: { resource: JSON.stringify({ data: { event: { requestId: 'config-command' } } }) },
    }))).toBe('topology-command');
    const topologyCommand = {
      kind: 'topology-source', commandId: 'topology-command', stackIndex: 0,
      latencyMs: 1, status: 'accepted',
    } as const;
    const topologyRecord = {
      resourceId: 'stored-effect',
      outboxId: 'topology-command:rtc-topology-recompute:group-revision:group=1;presence=0',
      typeId: 'APP_OUTBOX', topicId: 'app-outbox.rtc-topology',
      effectKind: 'rtc-topology-recompute', canonicalCommandId: 'topology-command',
      commandIds: ['topology-command', 'config-command'],
    } as const;
    expect(bench.projectProductionOutboxEvidence(
      [topologyCommand],
      [{ commandId: 'topology-command', receiptIds: ['topology-command'],
        outboxIds: [topologyRecord.outboxId], identityKind: 'logical-msg-id' }],
      [topologyRecord],
    )[0]).toMatchObject({
      commandId: 'topology-command', effectId: topologyRecord.outboxId,
      resourceId: 'stored-effect', outboxId: topologyRecord.outboxId,
    });
    expect(bench.projectProductionOutboxEvidence([topologyCommand], [], [topologyRecord])).toEqual([]);
    expect(bench.productionOutboxLookupIds(
      { kind: 'topology-source', commandId: 'bench:topology-source:7', stackIndex: 0, latencyMs: 1, status: 'accepted' },
      { applicationId: 'app', workspaceId: 'workspace' }, 5,
      ['bench:topology-source:7:rtc-topology-recompute:group-revision:group=1;presence=0'],
    )[0]).toMatch(/^bench-topology-source--[a-z0-9]+$/);
    expect(bench.parseBenchmarkOptions([
      '--backend=postgres', '--warmup=1', '--runs=3', '--concurrency=10',
      '--out=tmp/perf/candidate.json',
    ])).toEqual({
      backend: 'postgres', warmup: 1, runs: 3, concurrency: 10,
      out: 'tmp/perf/candidate.json',
    });
  });

  it('requires route recipes to assert durable AppInbox completion', () => {
    for (const recipePath of [
      'api-v1-state-write-convergence.json',
      'api-v1-state-medium-scale-churn.json',
      'api-v1-auth-session.json',
      'api-v1-admin-operations.json',
      'api-v1-crdt-app-inbox.json',
    ]) {
      const recipe = JSON.parse(readFileSync(new URL(
        `../../shared-test/black-box-runner/tests/api-v1/${recipePath}`,
        import.meta.url,
      ), 'utf8'));
      expect(recipe.steps.map((step: { name?: string }) => step.name), recipePath)
        .toContain('assertAtomicAppInboxCompletion');
    }
  });
});

function artifact(candidate: boolean): any {
  const workloads = [workload('uncontended', 100, candidate), workload('shared', 5, candidate), workload('hot', 1, candidate)];
  return {
    schemaVersion: STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
    gitCommit: '4a0232d7b49b94b713459549c7bbb715e7e4842c',
    backend: 'postgres',
    generatedAt: '2026-07-27T00:00:00.000Z',
    measurement: {
      warmupRuns: 1, measuredRuns: 3, concurrency: 10,
      mutationTimingExcludes: ['setup', 'auth-session insertion', 'http', 'evidence queries'],
      tailSamplesDiscarded: false,
      counterSources: sources(candidate),
    },
    features: candidate ? {
      presenceSplitFromGroupAggregate: true,
      governance: 'task10-post-remediation-candidate',
      evidence: 'AppInbox transactional completion and final ResourceInbox effects',
    } : {
      presenceSplitFromGroupAggregate: false,
      governance: 'pre-remediation-baseline',
      evidence: 'Task 0B baseline recorded before Task 1',
    },
    regressionReasons: [], workloads,
  };
}

function workload(name: string, groups: number, candidate: boolean): any {
  const samples = Array.from({ length: 3 }, (_, index) => sample(index, candidate));
  const value = {
    name,
    scale: { clients: 100, groups, concurrency: 10 },
    mutationMix: [...MIX], warmupRuns: 1, measuredRuns: 3, samples, summary: {},
  };
  refresh(value);
  return value;
}

function sample(runIndex: number, candidate: boolean): any {
  const commands = MIX.flatMap((kind) => Array.from({ length: 100 }, (_, ordinal) => ({
    commandId: `run-${runIndex}:${kind}:${ordinal}`,
    kind, latencyMs: ordinal % 7 + 1, stackIndex: ordinal % 2, status: 'accepted',
  })));
  const latencySamplesMs = commands.map((command) => command.latencyMs);
  const evidence = candidate ? finalEvidence(commands) : legacyEvidence(commands);
  const attemptObservations = candidate
    ? evidence.appInbox.flatMap((entry: any) => Array.from({ length: entry.attempts }, (_, index) => ({
      commandId: entry.commandId,
      operationId: entry.operationId,
      attempt: index + 1,
      outcome: index + 1 === entry.attempts ? 'accepted' : 'conflicted',
      terminal: index + 1 === entry.attempts,
      source: 'resource_inbox.release.telemetry', retryDelayMs: 0, dueAgeMs: 0, selectedLane: 'fast',
      failure: index + 1 === entry.attempts
        ? { kind: 'none' }
        : { kind: 'retryable', code: 'runtime-state-write-conflict', name: 'Error' },
    })))
    : commands.flatMap((command) => operations(command).map((operationId) => ({
      commandId: command.commandId, operationId, attempt: 1, outcome: 'accepted',
      terminal: true, source: `${command.kind}.production-operation`,
    })));
  const required = candidate ? evidence.resourceOutbox.length : evidence.outboxIntents.length;
  return {
    runIndex, durationMs: 100, throughputPerSecond: 7000,
    latencySamplesMs, latencyMs: percentiles(latencySamplesMs), commands, attemptObservations,
    stackCommandCounts: [350, 350],
    ...(candidate ? { durableEvidence: evidence } : { durable: evidence }),
    outcomes: { accepted: 700, conflicted: 0, transientRetries: 0, exhausted: 0,
      attempts: 800, attemptsPerAcceptedMutation: 800 / 700 },
    sql: { statements: 20, rowsRead: 10, serializedResultBytes: 1000 },
    postgres: { transactionDurationMs: 80, lockWaitMs: 0, cpuTimeMs: 30, sharedBufferHits: 100, sharedBufferReads: 2, walBytes: 4096 },
    timingsMs: { read: 20, compute: 0, validate: 0, write: 40, transaction: 80, outbox: 10 },
    correctness: {
      acceptedCommandCount: 700, receiptCount: 700,
      effectfulCommandCount: candidate ? 700 : 600,
      requiredOutboxIntentCount: required, outboxIntentCount: required,
      ...(candidate ? { atomicCompletionFailures: 0 } : {}), dbwFindings: [],
    },
  };
}

function finalEvidence(commands: any[]): any {
  const appInbox = commands.flatMap((command) => operations(command).map((operationId) => ({
    commandId: command.commandId, operationId,
    resourceId: `${command.commandId}:${operationId}`, topicId: 'app-inbox.state',
    status: 'COMPLETED', resultStatus: 'COMPLETED', attempts: 1,
    commandType: command.kind === 'profile-instance' ? 'CLIENT_INSTANCE_UPSERT' :
      command.kind === 'topology-source' ? 'TOPOLOGY_CONFIG_PUT' :
      command.kind.startsWith('presence-') ? 'GROUP_PRESENCE_CONNECT' : 'GROUP_MEMBER_UPSERT',
    durableResult: durableResult(command, operationId),
    retryDelayMs: 0, dueAgeMs: 0, selectedLane: 'fast', transactionDurationMs: 1,
  })));
  const receipts = commands.map((command) => ({
    commandId: command.commandId,
    receiptIds: command.kind === 'profile-instance'
      ? operations(command).map((operationId) => `${command.commandId}-${operationId}`)
      : [command.commandId],
    outboxIds: PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].map((_, index) => `${command.commandId}:effect:${index}`),
    identityKind: command.kind === 'topology-source' ? 'logical-msg-id' : 'physical-resource-id',
    resultBindings: operations(command).map((operationId) => binding(command, operationId)),
  }));
  const resourceOutbox = commands.flatMap((command) =>
    PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].map((effectKind, index) => ({
      effectId: `${command.commandId}:effect:${index}`,
      resourceId: `${command.commandId}:effect:${index}`,
      outboxId: `${command.commandId}:effect:${index}`,
      commandId: command.commandId, effectKind,
      typeId: effectKind.startsWith('principal-state') ? 'WS_OUTBOX' : 'APP_OUTBOX',
      topicId: effectKind,
    }))
  );
  return { appInbox, receipts, resourceOutbox, intermediateMutationIntents: [], atomicCompletionFailures: 0 };
}

function legacyEvidence(commands: any[]): any {
  const kinds: Record<string, string[]> = {
    'profile-instance': ['client-snapshot:profile', 'client-event:profile', 'client-snapshot:instance', 'client-event:instance'],
    membership: ['group-snapshot', 'group-event', 'topology-publication'],
    'presence-connect': ['group-snapshot', 'group-event', 'topology-publication'],
    'presence-heartbeat': [],
    'presence-disconnect': ['group-snapshot', 'group-event', 'topology-publication'],
    config: ['group-snapshot', 'group-event', 'topology-publication'],
    'topology-source': ['topology-publication'],
  };
  return {
    receiptCommandIds: commands.map((command) => command.commandId),
    outboxIntents: commands.flatMap((command) => kinds[command.kind].map((intentKind, index) => ({
      intentId: `${command.commandId}:intent:${index}`, commandId: command.commandId, intentKind,
    }))),
  };
}

function operations(command: any): string[] {
  return command.kind === 'profile-instance' ? ['profile', 'instance'] : ['command'];
}

function refresh(workloadValue: any): void {
  const samples = workloadValue.samples;
  const accepted = 700 * samples.length;
  for (const sampleValue of samples) {
    const attempts = sampleValue.attemptObservations.length;
    sampleValue.outcomes = {
      accepted: 700,
      conflicted: sampleValue.attemptObservations.filter(
        (entry: any) => entry.outcome === 'conflicted',
      ).length,
      transientRetries: sampleValue.attemptObservations.filter(
        (entry: any) => entry.outcome === 'transient-retry',
      ).length,
      exhausted: 0,
      attempts,
      attemptsPerAcceptedMutation: attempts / 700,
    };
  }
  const attemptCount = samples.reduce(
    (sum: number, entry: any) => sum + entry.attemptObservations.length,
    0,
  );
  const conflictCount = samples.reduce((sum: number, entry: any) => sum +
    entry.attemptObservations.filter((attempt: any) => attempt.outcome === 'conflicted').length, 0);
  const transientRetryCount = samples.reduce((sum: number, entry: any) => sum +
    entry.attemptObservations.filter(
      (attempt: any) => attempt.outcome === 'transient-retry',
    ).length, 0);
  workloadValue.summary = {
    latencyMs: percentiles(samples.flatMap((entry: any) => entry.latencySamplesMs)),
    throughputPerSecond: accepted / (samples.reduce((sum: number, entry: any) => sum + entry.durationMs, 0) / 1000),
    outcomes: { accepted, conflicted: conflictCount, transientRetries: transientRetryCount,
      exhausted: 0, attempts: attemptCount, attemptsPerAcceptedMutation: attemptCount / accepted },
    sql: { ...samples[0].sql }, postgres: { ...samples[0].postgres }, timingsMs: { ...samples[0].timingsMs },
    correctness: {
      acceptedCommandCount: accepted,
      receiptCount: samples.reduce((sum: number, entry: any) => sum + entry.correctness.receiptCount, 0),
      effectfulCommandCount: samples.reduce((sum: number, entry: any) => sum + entry.correctness.effectfulCommandCount, 0),
      requiredOutboxIntentCount: samples.reduce((sum: number, entry: any) => sum + entry.correctness.requiredOutboxIntentCount, 0),
      outboxIntentCount: samples.reduce((sum: number, entry: any) => sum + entry.correctness.outboxIntentCount, 0),
      ...(samples[0].correctness.atomicCompletionFailures === undefined ? {} : { atomicCompletionFailures: 0 }),
      dbwFindings: [],
    },
  };
}

function percentiles(values: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (ratio: number) => sorted[Math.ceil(sorted.length * ratio) - 1];
  return { p50: at(.5), p95: at(.95), p99: at(.99) };
}

function sources(candidate: boolean): Record<string, string> {
  return {
    sql: 'instrumented postgres.js', rowsRead: 'returned SQL rows', serializedResultBytes: 'JSON bytes',
    transactionDuration: 'AppInbox transaction wall duration', lockWait: 'pg_stat_activity', cpu: 'process CPU',
    sharedBuffers: 'pg_stat_database', wal: 'pg WAL LSN', readTiming: 'AppInbox read phase',
    computeTiming: 'AppInbox compute phase', validateTiming: 'AppInbox validate phase',
    writeTiming: 'AppInbox write phase', outboxTiming: 'ResourceInbox SQL',
    attempts: candidate
      ? 'resource_inbox.release.telemetry+app_inbox.ri_attempts reconciliation'
      : 'legacy service timing',
    receipts: 'same-observation mutation receipts', outboxIntents: 'legacy compatibility disclosure',
    ...(candidate ? { outbox: 'resource_inbox' } : {}),
  };
}
