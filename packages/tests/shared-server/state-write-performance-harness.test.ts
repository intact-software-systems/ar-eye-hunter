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

const INTENT_KINDS: Record<string, readonly string[]> = {
  'profile-instance': [
    'client-snapshot:profile',
    'client-event:profile',
    'client-snapshot:instance',
    'client-event:instance',
  ],
  membership: ['group-snapshot', 'group-event', 'topology-publication'],
  'presence-connect': ['group-snapshot', 'group-event', 'topology-publication'],
  'presence-heartbeat': [],
  'presence-disconnect': ['group-snapshot', 'group-event', 'topology-publication'],
  config: ['group-snapshot', 'group-event', 'topology-publication'],
  'topology-source': ['topology-publication'],
};

describe('API-v1 state-write performance artifact contract', () => {
  it('accepts coherent baseline raw samples, summaries, durable linkage, sources, and stack use', () => {
    expect(validateStateWriteArtifact(validArtifact())).toEqual([]);
  });

  it('rejects setup, authentication, or HTTP time in mutation latency', () => {
    const artifact = validArtifact();
    artifact.measurement.mutationTimingExcludes = ['http'];

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('mutationTimingExcludes'),
    ]));
  });

  it('rejects missing metric-source disclosures', () => {
    const artifact = validArtifact();
    delete artifact.measurement.counterSources.lockWait;
    delete artifact.measurement.counterSources.computeTiming;
    delete artifact.measurement.counterSources.attempts;

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('counterSources.lockWait'),
      expect.stringContaining('counterSources.computeTiming'),
      expect.stringContaining('counterSources.attempts'),
    ]));
  });

  it('requires exactly three measured runs and all 700 command latency tails per run', () => {
    const missingRun = validArtifact();
    missingRun.workloads[2].samples.pop();
    const missingTail = validArtifact();
    missingTail.workloads[0].samples[0].latencySamplesMs.pop();

    expect(validateStateWriteArtifact(missingRun)).toEqual(expect.arrayContaining([
      expect.stringContaining('samples must contain exactly measurement.measuredRuns entries'),
    ]));
    expect(validateStateWriteArtifact(missingTail)).toEqual(expect.arrayContaining([
      expect.stringContaining('must contain exactly 700 command latencies'),
    ]));
  });

  it('rejects favorable summaries that disagree with raw latency, throughput, outcomes, SQL, or transaction samples', () => {
    const artifact = validArtifact();
    artifact.workloads[0].summary.latencyMs.p99 = 0;
    artifact.workloads[0].summary.throughputPerSecond *= 2;
    artifact.workloads[0].summary.outcomes.attempts = 1;
    artifact.workloads[0].summary.sql.statements = 1;
    artifact.workloads[0].summary.postgres.transactionDurationMs = 1;

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('summary.latencyMs.p99 does not match raw samples'),
      expect.stringContaining('summary.throughputPerSecond does not match raw samples'),
      expect.stringContaining('summary.outcomes.attempts does not match raw samples'),
      expect.stringContaining('summary.sql.statements does not match sample median'),
      expect.stringContaining(
        'summary.postgres.transactionDurationMs does not match sample median',
      ),
    ]));
  });

  it('rejects an exhausted terminal hidden behind an accepted command status', () => {
    const artifact = validArtifact();
    artifact.workloads[1].samples[0].attemptObservations[0].outcome = 'exhausted';

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('status does not match its coherent terminal attempt outcome'),
      expect.stringContaining('outcomes.exhausted does not match attempt observations'),
    ]));
  });

  it('derives attempts and conflicts from raw timing-sink observations', () => {
    const artifact = validArtifact();
    artifact.workloads[1].samples[0].attemptObservations.push({
      commandId: artifact.workloads[1].samples[0].commands[0].commandId,
      operationId: 'profile',
      attempt: 2,
      outcome: 'conflicted',
      terminal: false,
      source: 'client-state-service.cas-attempt',
    });

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('outcomes.attempts does not match attempt observations'),
      expect.stringContaining('outcomes.conflicted does not match attempt observations'),
      expect.stringContaining('attemptsPerAcceptedMutation does not match attempt observations'),
    ]));
  });

  it('rejects a run where both independent stacks did not execute commands', () => {
    const artifact = validArtifact();
    for (const command of artifact.workloads[0].samples[0].commands) {
      command.stackIndex = 0;
    }
    artifact.workloads[0].samples[0].stackCommandCounts = [700, 0];

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('both independent service stacks must execute commands'),
    ]));
  });

  it('rejects missing, duplicate, or incorrectly linked durable receipts and outbox intents', () => {
    const missingReceipt = validArtifact();
    missingReceipt.workloads[0].samples[0].durable.receiptCommandIds.pop();
    const duplicateIntent = validArtifact();
    const intents = duplicateIntent.workloads[0].samples[0].durable.outboxIntents;
    intents[1].intentId = intents[0].intentId;
    const wrongKind = validArtifact();
    wrongKind.workloads[0].samples[0].durable.outboxIntents[0].intentKind = 'topology-publication';

    expect(validateStateWriteArtifact(missingReceipt)).toEqual(expect.arrayContaining([
      expect.stringContaining('durable receipts must match accepted command IDs exactly'),
    ]));
    expect(validateStateWriteArtifact(duplicateIntent)).toEqual(expect.arrayContaining([
      expect.stringContaining('durable outbox intent IDs must be unique'),
    ]));
    expect(validateStateWriteArtifact(wrongKind)).toEqual(expect.arrayContaining([
      expect.stringContaining('durable outbox intents do not match the mutation contract'),
    ]));
  });

  it('rejects zero durable receipts or intents hidden behind favorable correctness summaries', () => {
    const artifact = validArtifact();
    artifact.workloads[2].samples[0].durable.receiptCommandIds = [];
    artifact.workloads[2].samples[0].durable.outboxIntents = [];

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('durable receipts must match accepted command IDs exactly'),
      expect.stringContaining('durable outbox intents do not match the mutation contract'),
      expect.stringContaining('correctness.receiptCount does not match durable records'),
      expect.stringContaining('correctness.outboxIntentCount does not match durable records'),
    ]));
  });

  it('makes the Task 10 presence-split declaration and evidence non-bypassable', () => {
    const baseline = validArtifact();
    const omitted = validArtifact({ candidate: true });
    delete omitted.features;
    const falseCandidate = validArtifact({ candidate: true });
    falseCandidate.features.presenceSplitFromGroupAggregate = false;
    falseCandidate.features.governance = 'pre-remediation-baseline';

    expect(compareStateWriteArtifacts(baseline, omitted)).toEqual(expect.arrayContaining([
      expect.stringContaining('candidate must declare presenceSplitFromGroupAggregate=true'),
    ]));
    expect(compareStateWriteArtifacts(baseline, falseCandidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('candidate must declare presenceSplitFromGroupAggregate=true'),
    ]));
  });

  it('requires shared throughput to improve after the mandated presence split', () => {
    const baseline = validArtifact();
    const candidate = validArtifact({ candidate: true });
    setDurations(candidate.workloads[1], 100);

    expect(compareStateWriteArtifacts(baseline, candidate)).toContain(
      'shared throughput must improve after presence is split from the group aggregate',
    );
  });

  it('enforces uncontended tail-latency and shared/hot throughput budgets from coherent raw data', () => {
    const baseline = validArtifact();
    const candidate = validArtifact({ candidate: true });
    setLatencies(candidate.workloads[0], 8);
    setDurations(candidate.workloads[1], 110);
    setDurations(candidate.workloads[2], 110);

    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('uncontended latency p95'),
      expect.stringContaining('uncontended latency p99'),
      expect.stringContaining('shared throughput regressed'),
      expect.stringContaining('hot throughput regressed'),
    ]));
  });

  it('allows only reasoned median resource increases', () => {
    const baseline = validArtifact();
    const candidate = validArtifact({ candidate: true });
    for (const sample of candidate.workloads[1].samples) {
      sample.sql.statements += 1;
    }
    refreshSummary(candidate.workloads[1]);

    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('median sql.statements increased without a recorded reason'),
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

  it('requires DBW linkage for baseline durable failures without relaxing the candidate', () => {
    const baseline = validArtifact();
    const candidate = validArtifact({ candidate: true });
    removeReceiptAndRefresh(baseline.workloads[2], false);

    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('baseline correctness already fails'),
      expect.stringContaining('no DBW finding linkage'),
    ]));

    for (const sample of baseline.workloads[2].samples) {
      sample.correctness.dbwFindings = ['DBW-EXAMPLE'];
    }
    refreshSummary(baseline.workloads[2]);
    removeReceiptAndRefresh(candidate.workloads[2], true);
    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('candidate correctness failed'),
    ]));
  });

  it('never lets a candidate DBW tag waive exact durable command and intent linkage', () => {
    const baseline = validArtifact();
    const candidate = validArtifact({ candidate: true });
    const sampleValue = candidate.workloads[1].samples[0];
    sampleValue.durable.receiptCommandIds[0] = 'bogus-unique-command';
    sampleValue.durable.outboxIntents[0].commandId = 'bogus-unique-command';
    sampleValue.correctness.dbwFindings = ['DBW-ARBITRARY-WAIVER'];
    refreshSummary(candidate.workloads[1]);

    expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('candidate'),
      expect.stringContaining('durable receipts must match accepted command IDs exactly'),
      expect.stringContaining('durable.outboxIntents[0] must link'),
    ]));

    const intentIdCandidate = validArtifact({ candidate: true });
    intentIdCandidate.workloads[1].samples[0].durable.outboxIntents[0].intentId =
      'bogus-unique-intent';
    intentIdCandidate.workloads[1].samples[0].correctness.dbwFindings = [
      'DBW-ARBITRARY-WAIVER',
    ];
    refreshSummary(intentIdCandidate.workloads[1]);
    expect(compareStateWriteArtifacts(baseline, intentIdCandidate)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('candidate'),
        expect.stringContaining('durable outbox intents do not match the mutation contract'),
      ]),
    );
  });

  it('rejects all-conflicted attempt histories with no terminal command outcome', () => {
    const artifact = validArtifact();
    const sampleValue = artifact.workloads[0].samples[0];
    const command = sampleValue.commands[100];
    sampleValue.attemptObservations = sampleValue.attemptObservations.filter(
      (entry: any) => entry.commandId !== command.commandId,
    );
    sampleValue.attemptObservations.push({
      commandId: command.commandId,
      operationId: 'command',
      attempt: 1,
      outcome: 'conflicted',
      terminal: false,
      source: 'group-state-service.cas-attempt',
    });
    refreshSampleOutcomes(sampleValue);
    refreshSummary(artifact.workloads[0]);

    expect(validateStateWriteArtifact(artifact)).toEqual(expect.arrayContaining([
      expect.stringContaining('exactly one terminal outcome'),
    ]));
  });

  it('accepts coherent hot baseline exhaustion and enforces the candidate hot ceiling', () => {
    const baseline = validArtifact();
    makeCommandExhausted(baseline.workloads[2].samples[0], 699);
    refreshSummary(baseline.workloads[2]);
    expect(validateStateWriteArtifact(baseline)).toEqual([]);

    const allowedCandidate = validArtifact({ candidate: true });
    makeCommandExhausted(allowedCandidate.workloads[2].samples[0], 699);
    refreshSummary(allowedCandidate.workloads[2]);
    expect(compareStateWriteArtifacts(baseline, allowedCandidate)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('hot retry exhaustion exceeded baseline')]),
    );

    const rejectedCandidate = structuredClone(allowedCandidate);
    makeCommandExhausted(rejectedCandidate.workloads[2].samples[1], 699);
    refreshSummary(rejectedCandidate.workloads[2]);
    expect(compareStateWriteArtifacts(baseline, rejectedCandidate)).toEqual(
      expect.arrayContaining([expect.stringContaining('hot retry exhaustion exceeded baseline')]),
    );
  });

  it('selects both service stacks deterministically and rejects fractional or NaN CLI counts', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: unknown[]) => unknown>;

    expect(bench.selectServiceStack).toBeTypeOf('function');
    expect(Array.from({ length: 100 }, (_, index) => bench.selectServiceStack(index, 2)))
      .toEqual(Array.from({ length: 100 }, (_, index) => index % 2));
    expect(bench.parseBenchmarkOptions).toBeTypeOf('function');
    expect(() => bench.parseBenchmarkOptions(['--runs=3.5'])).toThrow(/integer/);
    expect(() => bench.parseBenchmarkOptions(['--runs=NaN'])).toThrow(/integer/);
    expect(() => bench.parseBenchmarkOptions(['--warmup=1.5'])).toThrow(/integer/);
    expect(() => bench.parseBenchmarkOptions(['--concurrency=10.5'])).toThrow(/integer/);
    for (const value of ['9007199254740992', '1e308']) {
      expect(() => bench.parseBenchmarkOptions([`--warmup=${value}`])).toThrow(
        /safe integer|at most/,
      );
      expect(() => bench.parseBenchmarkOptions([`--runs=${value}`])).toThrow(
        /safe integer|at most/,
      );
      expect(() => bench.parseBenchmarkOptions([`--concurrency=${value}`])).toThrow(
        /safe integer|at most/,
      );
    }
    expect(() => bench.parseBenchmarkOptions(['--runs=0'])).toThrow(/integer/);
    expect(() => bench.parseBenchmarkOptions(['--concurrency=-1'])).toThrow(/integer/);
  });

  it('returns descriptive errors instead of throwing for malformed JSON-like derivation inputs', () => {
    const mutations: Array<[string, (artifact: any) => void]> = [
      ['unsupported command kind', (artifact) => {
        artifact.workloads[0].samples[0].commands[0].kind = 'unsupported-kind';
      }],
      ['missing command kind', (artifact) => {
        delete artifact.workloads[0].samples[0].commands[0].kind;
      }],
      ['null sample', (artifact) => {
        artifact.workloads[0].samples[0] = null;
      }],
      ['missing commands array', (artifact) => {
        delete artifact.workloads[0].samples[0].commands;
      }],
      ['null raw command', (artifact) => {
        artifact.workloads[0].samples[0].commands[0] = null;
      }],
      ['missing attempt observations', (artifact) => {
        delete artifact.workloads[0].samples[0].attemptObservations;
      }],
      ['null attempt observation', (artifact) => {
        artifact.workloads[0].samples[0].attemptObservations[0] = null;
      }],
      ['missing durable evidence', (artifact) => {
        delete artifact.workloads[0].samples[0].durable;
      }],
    ];

    for (const [label, mutate] of mutations) {
      const malformed = validArtifact();
      mutate(malformed);

      expect(() => validateStateWriteArtifact(malformed), label).not.toThrow();
      expect(validateStateWriteArtifact(malformed), label).not.toEqual([]);
      expect(() => compareStateWriteArtifacts(validArtifact(), malformed), label).not.toThrow();
      expect(compareStateWriteArtifacts(validArtifact(), malformed), label).toEqual(
        expect.arrayContaining([expect.stringContaining('candidate:')]),
      );
      expect(() => compareStateWriteArtifacts(malformed, validArtifact({ candidate: true })), label)
        .not.toThrow();
      expect(compareStateWriteArtifacts(malformed, validArtifact({ candidate: true })), label)
        .toEqual(expect.arrayContaining([expect.stringContaining('baseline:')]));
    }
  });
});

function validArtifact(options: { candidate?: boolean } = {}): any {
  const workloads = [
    workload('uncontended', 100),
    workload('shared', 5, options.candidate ? 90 : 100),
    workload('hot', 1),
  ];
  return {
    schemaVersion: STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
    gitCommit: 'edf4a529d065dae58d6a9ec3df0af6f6d5486065',
    backend: 'postgres',
    generatedAt: '2026-07-18T00:00:00.000Z',
    measurement: {
      warmupRuns: 1,
      measuredRuns: 3,
      concurrency: 10,
      mutationTimingExcludes: ['setup', 'authentication', 'http'],
      tailSamplesDiscarded: false,
      counterSources: counterSources(),
    },
    features: options.candidate
      ? {
        presenceSplitFromGroupAggregate: true,
        governance: 'task10-post-remediation-candidate',
        evidence: 'presence state stored independently from the group aggregate',
      }
      : {
        presenceSplitFromGroupAggregate: false,
        governance: 'pre-remediation-baseline',
        evidence: 'Task 0B baseline recorded before Task 1',
      },
    regressionReasons: [],
    workloads,
  };
}

function workload(name: string, groups: number, durationMs = 100): any {
  const samples = Array.from({ length: 3 }, (_, runIndex) => sample(runIndex, durationMs));
  const value = {
    name,
    scale: { clients: 100, groups, concurrency: 10 },
    mutationMix: [...MUTATION_MIX],
    warmupRuns: 1,
    measuredRuns: 3,
    samples,
    summary: {},
  };
  refreshSummary(value);
  return value;
}

function sample(runIndex: number, durationMs: number): any {
  const commands = MUTATION_MIX.flatMap((kind) =>
    Array.from({ length: 100 }, (_, ordinal) => ({
      commandId: `run-${runIndex}:${kind}:${ordinal}`,
      kind,
      latencyMs: ordinal % 7 + 1,
      stackIndex: ordinal % 2,
      status: 'accepted',
    }))
  );
  const attemptObservations = commands.flatMap((command) => {
    const sources = command.kind === 'profile-instance'
      ? ['client-state-service.upsertPrincipal', 'client-state-service.upsertInstance']
      : [`${command.kind}.production-operation`];
    return sources.map((source) => ({
      commandId: command.commandId,
      operationId: source.includes('upsertPrincipal')
        ? 'profile'
        : source.includes('upsertInstance')
        ? 'instance'
        : 'command',
      attempt: 1,
      outcome: 'accepted',
      terminal: true,
      source,
    }));
  });
  const receiptCommandIds = commands.map((command) => command.commandId);
  const outboxIntents = commands.flatMap((command) =>
    INTENT_KINDS[command.kind].map((intentKind, index) => ({
      intentId: `${command.commandId}:intent:${index}`,
      commandId: command.commandId,
      intentKind,
    }))
  );
  const latencySamplesMs = commands.map((command) => command.latencyMs);
  return {
    runIndex,
    durationMs,
    throughputPerSecond: commands.length / (durationMs / 1_000),
    latencySamplesMs,
    commands,
    attemptObservations,
    stackCommandCounts: [350, 350],
    durable: { receiptCommandIds, outboxIntents },
    latencyMs: percentileSummary(latencySamplesMs),
    outcomes: {
      accepted: 700,
      conflicted: 0,
      exhausted: 0,
      attempts: 800,
      attemptsPerAcceptedMutation: 800 / 700,
    },
    sql: { statements: 20, rowsRead: 10, serializedResultBytes: 1000 },
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
      compute: 0,
      validate: 0,
      write: 40,
      transaction: 80,
      outbox: 10,
    },
    correctness: {
      acceptedCommandCount: 700,
      receiptCount: 700,
      effectfulCommandCount: 600,
      requiredOutboxIntentCount: 1700,
      outboxIntentCount: 1700,
      dbwFindings: [],
    },
  };
}

function refreshSummary(workloadValue: any): void {
  const samples = workloadValue.samples;
  const latencySamples = samples.flatMap((entry: any) => entry.latencySamplesMs);
  const accepted = sum(
    samples.map((entry: any) =>
      entry.commands.filter((command: any) => command.status === 'accepted').length
    ),
  );
  const attempts = sum(samples.map((entry: any) => entry.attemptObservations.length));
  workloadValue.summary = {
    latencyMs: percentileSummary(latencySamples),
    throughputPerSecond: accepted / (sum(samples.map((entry: any) => entry.durationMs)) / 1_000),
    outcomes: {
      accepted,
      conflicted: sum(
        samples.map((entry: any) =>
          entry.attemptObservations.filter((attempt: any) => attempt.outcome === 'conflicted')
            .length
        ),
      ),
      exhausted: sum(
        samples.map((entry: any) =>
          entry.commands.filter((command: any) => command.status === 'exhausted').length
        ),
      ),
      attempts,
      attemptsPerAcceptedMutation: attempts / accepted,
    },
    sql: medianObject(samples.map((entry: any) => entry.sql)),
    postgres: medianObject(samples.map((entry: any) => entry.postgres)),
    timingsMs: medianObject(samples.map((entry: any) => entry.timingsMs)),
    correctness: {
      acceptedCommandCount: accepted,
      receiptCount: sum(samples.map((entry: any) => entry.correctness.receiptCount)),
      effectfulCommandCount: sum(
        samples.map((entry: any) => entry.correctness.effectfulCommandCount),
      ),
      requiredOutboxIntentCount: sum(
        samples.map((entry: any) => entry.correctness.requiredOutboxIntentCount),
      ),
      outboxIntentCount: sum(samples.map((entry: any) => entry.correctness.outboxIntentCount)),
      dbwFindings: [...new Set(samples.flatMap((entry: any) => entry.correctness.dbwFindings))],
    },
  };
}

function refreshSampleOutcomes(sampleValue: any): void {
  const accepted =
    sampleValue.commands.filter((command: any) => command.status === 'accepted').length;
  const attempts = sampleValue.attemptObservations.length;
  sampleValue.outcomes = {
    accepted,
    conflicted: sampleValue.attemptObservations.filter(
      (attempt: any) => attempt.outcome === 'conflicted',
    ).length,
    exhausted: sampleValue.commands.filter((command: any) => command.status === 'exhausted').length,
    attempts,
    attemptsPerAcceptedMutation: attempts / accepted,
  };
}

function makeCommandExhausted(sampleValue: any, commandIndex: number): void {
  const command = sampleValue.commands[commandIndex];
  command.status = 'exhausted';
  sampleValue.attemptObservations = sampleValue.attemptObservations.filter(
    (entry: any) => entry.commandId !== command.commandId,
  );
  sampleValue.attemptObservations.push({
    commandId: command.commandId,
    operationId: 'command',
    attempt: 1,
    outcome: 'exhausted',
    terminal: true,
    source: 'group-topology-management-service.retry-budget',
  });
  sampleValue.durable.receiptCommandIds = sampleValue.durable.receiptCommandIds.filter(
    (commandId: string) => commandId !== command.commandId,
  );
  sampleValue.durable.outboxIntents = sampleValue.durable.outboxIntents.filter(
    (intent: any) => intent.commandId !== command.commandId,
  );
  sampleValue.correctness = {
    ...sampleValue.correctness,
    acceptedCommandCount: sampleValue.correctness.acceptedCommandCount - 1,
    receiptCount: sampleValue.correctness.receiptCount - 1,
    effectfulCommandCount: sampleValue.correctness.effectfulCommandCount - 1,
    requiredOutboxIntentCount: sampleValue.correctness.requiredOutboxIntentCount - 1,
    outboxIntentCount: sampleValue.correctness.outboxIntentCount - 1,
  };
  refreshSampleOutcomes(sampleValue);
  sampleValue.throughputPerSecond = sampleValue.outcomes.accepted /
    (sampleValue.durationMs / 1_000);
}

function setDurations(workloadValue: any, durationMs: number): void {
  for (const sampleValue of workloadValue.samples) {
    sampleValue.durationMs = durationMs;
    sampleValue.throughputPerSecond = 700 / (durationMs / 1_000);
  }
  refreshSummary(workloadValue);
}

function setLatencies(workloadValue: any, latencyMs: number): void {
  for (const sampleValue of workloadValue.samples) {
    for (const command of sampleValue.commands) {
      command.latencyMs = latencyMs;
    }
    sampleValue.latencySamplesMs = sampleValue.commands.map((command: any) => command.latencyMs);
    sampleValue.latencyMs = percentileSummary(sampleValue.latencySamplesMs);
  }
  refreshSummary(workloadValue);
}

function removeReceiptAndRefresh(workloadValue: any, linkFinding: boolean): void {
  for (const sampleValue of workloadValue.samples) {
    sampleValue.durable.receiptCommandIds.pop();
    sampleValue.correctness.receiptCount -= 1;
    sampleValue.correctness.dbwFindings = linkFinding ? ['DBW-EXAMPLE'] : [];
  }
  refreshSummary(workloadValue);
}

function percentileSummary(values: number[]): { p50: number; p95: number; p99: number } {
  return {
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function medianObject(values: Record<string, number>[]): Record<string, number> {
  return Object.fromEntries(
    Object.keys(values[0]).map((key) => [key, median(values.map((value) => value[key]))]),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function counterSources(): Record<string, string> {
  return {
    sql: 'thin postgres.js wrapper',
    rowsRead: 'returned rows from read-classified SQL',
    serializedResultBytes: 'UTF-8 JSON bytes returned by SQL',
    transactionDuration: 'postgres.js begin wall duration',
    lockWait: '5ms pg_stat_activity Lock sampling',
    cpu: 'benchmark process user plus system CPU',
    sharedBuffers: 'DB-wide pg_stat_database delta',
    wal: 'cluster pg_current_wal_lsn delta',
    readTiming: 'read-classified production repository SQL',
    computeTiming: 'production timing-sink compute observations; zero if unavailable',
    validateTiming: 'production timing-sink validate observations; zero if unavailable',
    writeTiming: 'write-classified production repository SQL including receipts',
    outboxTiming: 'resource_inbox repository SQL only',
    attempts: 'production service/timing-sink attempt observations',
    receipts: 'persisted resource_inbox_results rows queried after the phase',
    outboxIntents: 'persisted resource_inbox rows queried after the phase',
  };
}
