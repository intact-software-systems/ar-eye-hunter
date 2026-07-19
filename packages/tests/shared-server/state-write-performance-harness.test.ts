import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  compareStateWriteArtifacts,
  STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
  validateStateWriteArtifact,
} from '../../../scripts/perf/compare-api-v1-state-write-results.mjs';
import {
  RuntimeStateRetryExhaustedError,
  RuntimeStateWriteConflictError,
} from '../../shared-server/runtime-state/optimistic-runtime-state-write.ts';

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
  it('does not create benchmark-only receipt or outbox evidence after production calls', () => {
    const source = readFileSync(
      new URL('../../../scripts/perf/api-v1-state-write-concurrency-bench.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('ResourceInboxRepository');
    expect(source).not.toContain('ResourceInboxResultsRepository');
    expect(source).not.toContain('STATE_WRITE_BENCH_RECEIPT');
    expect(source).not.toContain('STATE_WRITE_BENCH_OUTBOX');
  });

  it('derives multi-conflict acceptance and exhaustion histories from production timing', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;
    expect(bench.deriveProductionAttemptObservations).toBeTypeOf('function');
    const commands = [
      {
        commandId: 'run:profile-instance:0',
        kind: 'profile-instance',
        latencyMs: 1,
        stackIndex: 0,
        status: 'accepted',
      },
      {
        commandId: 'run:membership:0',
        kind: 'membership',
        latencyMs: 1,
        stackIndex: 1,
        status: 'exhausted',
      },
    ];
    const conflict = (requestId: string, attempt: number, component: string) => ({
      component,
      operation: 'mutation.conflict',
      requestId,
      status: 'ok',
      durationMs: 0,
      details: { attempt, conflict: true },
    });
    const events = [
      conflict('run:profile-instance:0-profile', 0, 'client-state-service'),
      conflict('run:profile-instance:0-profile', 1, 'client-state-service'),
      {
        component: 'client-state-service',
        operation: 'mutation.write',
        requestId: 'run:profile-instance:0-profile',
        status: 'ok',
        durationMs: 1,
        details: { attempt: 2, phase: 'write' },
      },
      {
        component: 'client-state-service',
        operation: 'mutation.write',
        requestId: 'run:profile-instance:0-instance',
        status: 'ok',
        durationMs: 1,
        details: { attempt: 0, phase: 'write' },
      },
      conflict('run:membership:0', 0, 'group-state-service'),
      conflict('run:membership:0', 1, 'group-state-service'),
    ];

    expect(bench.deriveProductionAttemptObservations(events, commands)).toEqual([
      {
        commandId: 'run:profile-instance:0',
        operationId: 'profile',
        attempt: 0,
        outcome: 'conflicted',
        terminal: false,
        source: 'client-state-service.mutation.conflict',
      },
      {
        commandId: 'run:profile-instance:0',
        operationId: 'profile',
        attempt: 1,
        outcome: 'conflicted',
        terminal: false,
        source: 'client-state-service.mutation.conflict',
      },
      {
        commandId: 'run:profile-instance:0',
        operationId: 'profile',
        attempt: 2,
        outcome: 'accepted',
        terminal: true,
        source: 'client-state-service.mutation.write',
      },
      {
        commandId: 'run:profile-instance:0',
        operationId: 'instance',
        attempt: 0,
        outcome: 'accepted',
        terminal: true,
        source: 'client-state-service.mutation.write',
      },
      {
        commandId: 'run:membership:0',
        operationId: 'command',
        attempt: 0,
        outcome: 'conflicted',
        terminal: false,
        source: 'group-state-service.mutation.conflict',
      },
      {
        commandId: 'run:membership:0',
        operationId: 'command',
        attempt: 1,
        outcome: 'exhausted',
        terminal: true,
        source: 'group-state-service.mutation.conflict',
      },
    ]);
  });

  it('keeps explicit prerequisite exhaustion distinct from a production retry exhaustion', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;
    const command = {
      commandId: 'run:presence-heartbeat:0',
      kind: 'presence-heartbeat',
      latencyMs: 1,
      stackIndex: 0,
      status: 'exhausted',
    };
    const prerequisiteEvent = {
      component: 'state-write-command-envelope',
      operation: 'prerequisite-exhausted:membership',
      requestId: command.commandId,
      status: 'error',
      durationMs: 0,
      details: { outcome: 'exhausted', prerequisite: 'membership' },
    };

    expect(bench.deriveProductionAttemptObservations([prerequisiteEvent], [command])).toEqual([
      {
        commandId: command.commandId,
        operationId: 'command',
        attempt: 1,
        outcome: 'exhausted',
        terminal: true,
        source: 'state-write-command-envelope.prerequisite-exhausted:membership',
      },
    ]);
  });

  it('classifies the production outbox namespace from bound SQL values', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;

    expect(bench.classifyBenchmarkSql(
      'insert into runtime_state_store values ($1, $2)',
      ['state-mutation:outbox', 'record-1'],
    )).toBe('outbox');
    expect(bench.classifyBenchmarkSql(
      'insert into runtime_state_store values ($1, $2)',
      ['group-state:groups', 'group-1'],
    )).toBe('write');
  });

  it('retains a real profile effect when the composite raw command exhausts later', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;
    expect(bench.projectProductionOutboxEvidence).toBeTypeOf('function');
    const command = {
      commandId: 'run:profile-instance:0',
      kind: 'profile-instance',
      latencyMs: 1,
      stackIndex: 0,
      status: 'exhausted',
    };
    expect(bench.projectProductionOutboxEvidence([command], [{
      outboxId: 'real-profile-outbox',
      commandId: `${command.commandId}-profile`,
      effects: ['client-state-sync'],
    }])).toEqual([{
      intentId: 'real-profile-outbox:client-state-sync',
      commandId: command.commandId,
      intentKind: 'client-state-sync',
    }]);
  });

  it('does not count an ID-matching but contract-incomplete production receipt', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;
    expect(bench.isValidProductionReceipt).toBeTypeOf('function');
    expect(bench.isValidProductionReceipt({
      requestId: 'request-1',
      receipt: { commandId: 'request-1' },
    }, 'request-1')).toBe(false);
  });

  it('keeps immutable legacy durability valid but requires production effects for candidates', () => {
    expect(validateStateWriteArtifact(validArtifact())).toEqual([]);

    const productionCandidate = validArtifact({ candidate: true });
    expect(validateStateWriteArtifact(productionCandidate)).toEqual([]);

    const legacyShapedCandidate = validArtifact();
    legacyShapedCandidate.features = {
      presenceSplitFromGroupAggregate: true,
      governance: 'task10-post-remediation-candidate',
      evidence: 'candidate metadata with impermissible legacy-shaped durability',
    };
    expect(validateStateWriteArtifact(legacyShapedCandidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('production durable contract'),
    ]));
  });

  it('waives only the exact non-candidate topology diagnostic gap', () => {
    const diagnostic = validArtifact({ candidate: true });
    diagnostic.features = {
      presenceSplitFromGroupAggregate: false,
      governance: 'task4-production-evidence-diagnostic',
      evidence: 'Production evidence with Task 5 topology persistence still pending',
    };
    for (const workloadValue of diagnostic.workloads) {
      for (const sampleValue of workloadValue.samples) {
        const topologyIds = new Set(sampleValue.commands
          .filter((command: any) => command.kind === 'topology-source')
          .map((command: any) => command.commandId));
        sampleValue.durable.receiptCommandIds = sampleValue.durable.receiptCommandIds.filter(
          (commandId: string) => !topologyIds.has(commandId),
        );
        sampleValue.durable.outboxIntents = sampleValue.durable.outboxIntents.filter(
          (intent: any) => !topologyIds.has(intent.commandId),
        );
        sampleValue.correctness.receiptCount = sampleValue.durable.receiptCommandIds.length;
        sampleValue.correctness.outboxIntentCount = sampleValue.durable.outboxIntents.length;
        sampleValue.correctness.dbwFindings = ['DBW-06', 'DBW-12'];
        for (const observation of sampleValue.attemptObservations) {
          if (topologyIds.has(observation.commandId)) {
            observation.source = 'production-return:topology-config';
          }
        }
      }
      refreshSummary(workloadValue);
    }
    expect(validateStateWriteArtifact(diagnostic)).toEqual([]);

    const unrelatedGap = structuredClone(diagnostic);
    const sampleValue = unrelatedGap.workloads[0].samples[0];
    sampleValue.durable.receiptCommandIds.shift();
    sampleValue.correctness.receiptCount = sampleValue.durable.receiptCommandIds.length;
    refreshSummary(unrelatedGap.workloads[0]);
    expect(validateStateWriteArtifact(unrelatedGap)).toEqual(expect.arrayContaining([
      expect.stringContaining('durable receipts must match accepted command IDs exactly'),
    ]));

    const mislabeledCandidate = structuredClone(diagnostic);
    mislabeledCandidate.features = {
      presenceSplitFromGroupAggregate: true,
      governance: 'task10-post-remediation-candidate',
      evidence: 'A candidate cannot retain the Task 4 topology diagnostic gap',
    };
    expect(validateStateWriteArtifact(mislabeledCandidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('production attempt source is not a production mutation timing event'),
      expect.stringContaining('durable receipts must match accepted command IDs exactly'),
      expect.stringContaining('production durable contract'),
    ]));

    const extraFinding = structuredClone(diagnostic);
    extraFinding.workloads[0].samples[0].correctness.dbwFindings.push('DBW-EXTRA');
    refreshSummary(extraFinding.workloads[0]);
    expect(validateStateWriteArtifact(extraFinding)).toEqual(expect.arrayContaining([
      expect.stringContaining('durable receipts must match accepted command IDs exactly'),
    ]));
  });
  it('accepts coherent baseline raw samples, summaries, durable linkage, sources, and stack use', () => {
    expect(validateStateWriteArtifact(validArtifact())).toEqual([]);
  });

  it('accepts legacy and production-faithful timing exclusions and rejects omission', () => {
    const productionFaithful = validArtifact();
    productionFaithful.measurement.mutationTimingExcludes = [
      'setup',
      'auth-session insertion',
      'http',
    ];
    expect(validateStateWriteArtifact(productionFaithful)).toEqual([]);

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
      expect.stringContaining('durable.outboxIntents[0] must contain'),
    ]));

    const intentIdCandidate = validArtifact({ candidate: true });
    intentIdCandidate.workloads[1].samples[0].durable.outboxIntents[0].intentId =
      intentIdCandidate.workloads[1].samples[0].durable.outboxIntents[1].intentId;
    intentIdCandidate.workloads[1].samples[0].correctness.dbwFindings = [
      'DBW-ARBITRARY-WAIVER',
    ];
    refreshSummary(intentIdCandidate.workloads[1]);
    expect(compareStateWriteArtifacts(baseline, intentIdCandidate)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('candidate'),
        expect.stringContaining('durable outbox intent IDs must be unique'),
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

  it('rejects zero-conflict production exhaustion but permits an explicit prerequisite terminal', () => {
    const invalid = validArtifact();
    makeCommandExhausted(invalid.workloads[2].samples[0], 699);
    const commandId = invalid.workloads[2].samples[0].commands[699].commandId;
    invalid.workloads[2].samples[0].attemptObservations =
      invalid.workloads[2].samples[0].attemptObservations.filter(
        (entry: any) => entry.commandId !== commandId || entry.outcome === 'exhausted',
      );
    invalid.workloads[2].samples[0].attemptObservations.find(
      (entry: any) => entry.commandId === commandId,
    ).attempt = 1;
    refreshSampleOutcomes(invalid.workloads[2].samples[0]);
    refreshSummary(invalid.workloads[2]);
    expect(validateStateWriteArtifact(invalid)).toEqual(expect.arrayContaining([
      expect.stringContaining('preceding production mutation.conflict observation'),
    ]));

    const prerequisite = validArtifact();
    makeCommandExhausted(prerequisite.workloads[2].samples[0], 100);
    makeCommandExhausted(prerequisite.workloads[2].samples[0], 200);
    const prerequisiteSample = prerequisite.workloads[2].samples[0];
    const prerequisiteId = prerequisiteSample.commands[200].commandId;
    prerequisiteSample.attemptObservations = prerequisiteSample.attemptObservations.filter(
      (entry: any) => entry.commandId !== prerequisiteId,
    );
    prerequisiteSample.attemptObservations.push({
      commandId: prerequisiteId,
      operationId: 'command',
      attempt: 1,
      outcome: 'exhausted',
      terminal: true,
      source: 'state-write-command-envelope.prerequisite-exhausted:membership',
    });
    refreshSampleOutcomes(prerequisiteSample);
    refreshSummary(prerequisite.workloads[2]);
    expect(validateStateWriteArtifact(prerequisite)).toEqual([]);
  });

  it('permits only exact causal command and prerequisite pairs', () => {
    const invalid = validArtifact({ candidate: true });
    const invalidSample = invalid.workloads[2].samples[0];
    makeCommandExhausted(invalidSample, 100);
    const invalidId = invalidSample.commands[100].commandId;
    invalidSample.attemptObservations = invalidSample.attemptObservations.filter(
      (entry: any) => entry.commandId !== invalidId,
    );
    invalidSample.attemptObservations.push({
      commandId: invalidId,
      operationId: 'command',
      attempt: 1,
      outcome: 'exhausted',
      terminal: true,
      source: 'state-write-command-envelope.prerequisite-exhausted:membership',
    });
    refreshSampleOutcomes(invalidSample);
    refreshSummary(invalid.workloads[2]);
    expect(validateStateWriteArtifact(invalid)).toEqual(expect.arrayContaining([
      expect.stringContaining('invalid prerequisite-exhausted command pair'),
    ]));

    const valid = validArtifact({ candidate: true });
    const validSample = valid.workloads[2].samples[0];
    makeCommandExhausted(validSample, 100);
    makeCommandExhausted(validSample, 200);
    const validId = validSample.commands[200].commandId;
    validSample.attemptObservations = validSample.attemptObservations.filter(
      (entry: any) => entry.commandId !== validId,
    );
    validSample.attemptObservations.push({
      commandId: validId,
      operationId: 'command',
      attempt: 1,
      outcome: 'exhausted',
      terminal: true,
      source: 'state-write-command-envelope.prerequisite-exhausted:membership',
    });
    refreshSampleOutcomes(validSample);
    refreshSummary(valid.workloads[2]);
    expect(validateStateWriteArtifact(valid)).toEqual([]);

    const acceptedSpoof = validArtifact({ candidate: true });
    const acceptedObservation = acceptedSpoof.workloads[0].samples[0]
      .attemptObservations.find((entry: any) => entry.operationId === 'command');
    acceptedObservation.attempt = 1;
    acceptedObservation.source =
      'state-write-command-envelope.prerequisite-exhausted:membership';
    expect(validateStateWriteArtifact(acceptedSpoof)).toEqual(expect.arrayContaining([
      expect.stringContaining('production attempt source is not a production mutation timing event'),
    ]));

    const wrongService = validArtifact({ candidate: true });
    const membershipObservation = wrongService.workloads[0].samples[0]
      .attemptObservations.find((entry: any) =>
        entry.commandId.includes(':membership:')
      );
    membershipObservation.source = 'client-state-service.mutation.write';
    expect(validateStateWriteArtifact(wrongService)).toEqual(expect.arrayContaining([
      expect.stringContaining('production attempt source is not a production mutation timing event'),
    ]));
  });

  it('requires prerequisite terminals to link to a same-client real production exhaustion', () => {
    const setPrerequisite = (
      sampleValue: any,
      commandIndex: number,
      prerequisite: 'membership' | 'presence-connect',
    ) => {
      const command = sampleValue.commands[commandIndex];
      makeCommandExhausted(sampleValue, commandIndex);
      sampleValue.attemptObservations = sampleValue.attemptObservations.filter(
        (entry: any) => entry.commandId !== command.commandId,
      );
      sampleValue.attemptObservations.push({
        commandId: command.commandId,
        operationId: 'command',
        attempt: 1,
        outcome: 'exhausted',
        terminal: true,
        source: `state-write-command-envelope.prerequisite-exhausted:${prerequisite}`,
      });
      refreshSampleOutcomes(sampleValue);
    };
    const validateHot = (artifact: any) => {
      refreshSummary(artifact.workloads[2]);
      return validateStateWriteArtifact(artifact);
    };

    const orphan = validArtifact({ candidate: true });
    const orphanSample = orphan.workloads[2].samples[0];
    setPrerequisite(orphanSample, 200, 'membership');
    orphanSample.commands[200].commandId = 'run-0:presence-connect:999';
    orphanSample.attemptObservations.find(
      (entry: any) => entry.commandId === 'run-0:presence-connect:0',
    ).commandId = 'run-0:presence-connect:999';
    expect.soft(validateHot(orphan)).toEqual(expect.arrayContaining([
      expect.stringContaining('missing same-client prerequisite command'),
    ]));

    const acceptedPrerequisite = validArtifact({ candidate: true });
    const acceptedSample = acceptedPrerequisite.workloads[2].samples[0];
    setPrerequisite(acceptedSample, 200, 'membership');
    expect.soft(validateHot(acceptedPrerequisite)).toEqual(expect.arrayContaining([
      expect.stringContaining('prerequisite command must be production-exhausted'),
    ]));

    const differentClient = validArtifact({ candidate: true });
    const differentSample = differentClient.workloads[2].samples[0];
    makeCommandExhausted(differentSample, 100);
    setPrerequisite(differentSample, 201, 'membership');
    expect.soft(validateHot(differentClient)).toEqual(expect.arrayContaining([
      expect.stringContaining('prerequisite command must be production-exhausted'),
    ]));

    const syntheticChain = validArtifact({ candidate: true });
    const chainSample = syntheticChain.workloads[2].samples[0];
    setPrerequisite(chainSample, 200, 'membership');
    setPrerequisite(chainSample, 300, 'presence-connect');
    expect.soft(validateHot(syntheticChain)).toEqual(expect.arrayContaining([
      expect.stringContaining('prerequisite command must end in production conflict exhaustion'),
    ]));

    const reordered = validArtifact({ candidate: true });
    const reorderedSample = reordered.workloads[2].samples[0];
    makeCommandExhausted(reorderedSample, 100);
    setPrerequisite(reorderedSample, 200, 'membership');
    const dependentIndex = reorderedSample.commands.findIndex(
      (command: any) => command.commandId === 'run-0:presence-connect:0',
    );
    const [dependent] = reorderedSample.commands.splice(dependentIndex, 1);
    const prerequisiteIndex = reorderedSample.commands.findIndex(
      (command: any) => command.commandId === 'run-0:membership:0',
    );
    reorderedSample.commands.splice(prerequisiteIndex, 0, dependent);
    reorderedSample.latencySamplesMs = reorderedSample.commands.map(
      (command: any) => command.latencyMs,
    );
    expect.soft(validateHot(reordered)).toEqual(expect.arrayContaining([
      expect.stringContaining('prerequisite command must precede dependent command'),
    ]));

    const swappedIdentity = validArtifact({ candidate: true });
    const swappedSample = swappedIdentity.workloads[2].samples[0];
    makeCommandExhausted(swappedSample, 100);
    makeCommandExhausted(swappedSample, 101);
    setPrerequisite(swappedSample, 200, 'membership');
    const firstMembershipId = swappedSample.commands[100].commandId;
    const secondMembershipId = swappedSample.commands[101].commandId;
    swappedSample.commands[100].commandId = secondMembershipId;
    swappedSample.commands[101].commandId = firstMembershipId;
    for (const observation of swappedSample.attemptObservations) {
      if (observation.commandId === firstMembershipId) {
        observation.commandId = secondMembershipId;
      } else if (observation.commandId === secondMembershipId) {
        observation.commandId = firstMembershipId;
      }
    }
    expect.soft(validateHot(swappedIdentity)).toEqual(expect.arrayContaining([
      expect.stringContaining('command ID must encode its canonical raw client slot'),
    ]));

    const validMembership = validArtifact({ candidate: true });
    const validMembershipSample = validMembership.workloads[2].samples[0];
    makeCommandExhausted(validMembershipSample, 100);
    setPrerequisite(validMembershipSample, 200, 'membership');
    expect(validateHot(validMembership)).toEqual([]);

    const validConnect = validArtifact({ candidate: true });
    const validConnectSample = validConnect.workloads[2].samples[0];
    makeCommandExhausted(validConnectSample, 200);
    setPrerequisite(validConnectSample, 300, 'presence-connect');
    expect(validateHot(validConnect)).toEqual([]);
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

  it('rejects any shared-workload retry exhaustion', () => {
    const candidate = validArtifact({ candidate: true });
    makeCommandExhausted(candidate.workloads[1].samples[0], 100);
    refreshSummary(candidate.workloads[1]);

    expect(compareStateWriteArtifacts(validArtifact(), candidate)).toEqual(
      expect.arrayContaining([expect.stringContaining('shared retry exhaustion must remain zero')]),
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

  it('creates deterministic scope-isolated benchmark authority sessions', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;

    expect(bench.createBenchmarkAuthSession).toBeTypeOf('function');
    const scope = { applicationId: 'benchmark-run-a', workspaceId: 'state-write-bench' };
    const session = bench.createBenchmarkAuthSession(scope, 'client-7', 'client-session-7');

    expect(session).toEqual({
      clientId: 'client-7',
      username: 'client-7',
      sessionId: 'benchmark-run-a:state-write-bench:client-7:client-session-7',
      accessToken:
        'state-write-benchmark:benchmark-run-a:state-write-bench:client-7:client-session-7',
      issuedAtEpochMs: 1_700_000_000_000,
      expiresAtEpochMs: 4_102_444_800_000,
    });
    expect(bench.createBenchmarkAuthSession(scope, 'client-7', 'client-session-7'))
      .toEqual(session);
    expect(
      bench.createBenchmarkAuthSession(
        { ...scope, applicationId: 'benchmark-run-b' },
        'client-7',
        'client-session-7',
      ).sessionId,
    ).not.toBe(session.sessionId);

    const delimiterLeft = bench.createBenchmarkAuthSession(
      { applicationId: 'a:b', workspaceId: 'c' },
      'principal:x',
      'session:y',
    );
    const delimiterRight = bench.createBenchmarkAuthSession(
      { applicationId: 'a', workspaceId: 'b:c' },
      'principal:x',
      'session:y',
    );
    const percentLookalike = bench.createBenchmarkAuthSession(
      { applicationId: 'a%3Ab', workspaceId: 'c' },
      'principal:x',
      'session:y',
    );
    const differentPrincipal = bench.createBenchmarkAuthSession(
      { applicationId: 'a:b', workspaceId: 'c' },
      'principal:z',
      'session:y',
    );
    expect(
      new Set([
        delimiterLeft.sessionId,
        delimiterRight.sessionId,
        percentLookalike.sessionId,
        differentPrincipal.sessionId,
      ]),
    ).toHaveLength(4);
    expect(
      new Set([
        delimiterLeft.accessToken,
        delimiterRight.accessToken,
        percentLookalike.accessToken,
      ]),
    ).toHaveLength(3);
  });

  it('preserves transaction savepoints through SQL instrumentation', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;
    expect(bench.createInstrumentedSql).toBeTypeOf('function');

    let savepointCalls = 0;
    const transaction = Object.assign(
      async () => [{ value: 'nested-result' }],
      {
        begin: async (fn: (sql: unknown) => Promise<unknown>) => await fn(transaction),
        savepoint: async (fn: (sql: unknown) => Promise<unknown>) => {
          savepointCalls += 1;
          return await fn(transaction);
        },
      },
    );
    const root = Object.assign(
      async () => [],
      { begin: async (fn: (sql: unknown) => Promise<unknown>) => await fn(transaction) },
    );
    const context = {
      sql: {
        statements: 0,
        rowsRead: 0,
        serializedResultBytes: 0,
        readMs: 0,
        writeMs: 0,
        outboxSqlMs: 0,
        transactionDurationMs: 0,
      },
      timingEvents: [],
    };
    const instrumented = bench.createInstrumentedSql(root, context, () => {});

    await expect(instrumented.begin(async (sql: any) => {
      expect(sql).not.toBe(transaction);
      expect(sql.savepoint).toBeTypeOf('function');
      return await sql.savepoint(async (nested: any) => {
        expect(nested).not.toBe(transaction);
        return await nested`select 1`;
      });
    })).resolves.toEqual([{ value: 'nested-result' }]);
    expect(savepointCalls).toBe(1);
    expect(context.sql.statements).toBe(1);

    const failure = new Error('savepoint callback failed');
    await expect(instrumented.begin(async (sql: any) =>
      await sql.savepoint(async () => {
        throw failure;
      })
    )).rejects.toBe(failure);
    expect(savepointCalls).toBe(2);
  });

  it('drains in-flight concurrent work before propagating the initiating error', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;
    expect(bench.mapWithConcurrency).toBeTypeOf('function');

    const initiatingError = new Error('initiating command failure');
    const laterError = new Error('later in-flight failure');
    let inFlightSettled = false;
    const invoked: number[] = [];
    await expect(bench.mapWithConcurrency([0, 1, 2], 2, async (value: number) => {
      invoked.push(value);
      if (value === 1) {
        throw initiatingError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlightSettled = true;
      throw laterError;
    })).rejects.toBe(initiatingError);
    expect(inFlightSettled).toBe(true);
    expect(invoked).toEqual([0, 1]);
  });

  it('awaits failure cleanup before preserving the initiating error', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;
    expect(bench.rethrowAfterCleanup).toBeTypeOf('function');

    const initiatingError = new Error('command failed');
    let stopped = false;
    await expect(bench.rethrowAfterCleanup(initiatingError, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stopped = true;
    })).rejects.toBe(initiatingError);
    expect(stopped).toBe(true);

    const cleanupError = new Error('sampler stop failed');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(bench.rethrowAfterCleanup(initiatingError, async () => {
      throw cleanupError;
    })).rejects.toBe(initiatingError);
    expect(errorLog).toHaveBeenCalledWith(
      'State-write benchmark cleanup failed after command failure',
      cleanupError,
    );
    errorLog.mockRestore();
  });

  it('classifies only typed production retry exhaustion as an exhausted command', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;
    expect(bench.isBenchmarkRetryExhaustion).toBeTypeOf('function');

    expect(bench.isBenchmarkRetryExhaustion(
      new RuntimeStateRetryExhaustedError(new RuntimeStateWriteConflictError()),
    )).toBe(true);
    expect(bench.isBenchmarkRetryExhaustion(new Error('unrelated failure'))).toBe(false);
  });

  it('cascades only causal exhausted prerequisites without invoking invalid dependents', async () => {
    const bench = await import(
      '../../../scripts/perf/api-v1-state-write-concurrency-bench.ts'
    ) as Record<string, (...args: any[]) => any>;
    expect(bench.resolveBenchmarkCommandTerminal).toBeTypeOf('function');
    const exhaustion = () =>
      new RuntimeStateRetryExhaustedError(new RuntimeStateWriteConflictError());

    const membershipTerminals = new Set<string>();
    await expect(bench.resolveBenchmarkCommandTerminal(
      'membership',
      membershipTerminals,
      async () => {
        throw exhaustion();
      },
    )).resolves.toEqual({ status: 'exhausted', source: 'production' });
    let dependentCalls = 0;
    for (const kind of ['presence-connect', 'presence-heartbeat', 'presence-disconnect']) {
      await expect(bench.resolveBenchmarkCommandTerminal(
        kind,
        membershipTerminals,
        async () => {
          dependentCalls += 1;
        },
      )).resolves.toEqual({
        status: 'exhausted',
        source: 'prerequisite',
        prerequisite: 'membership',
      });
    }
    expect(dependentCalls).toBe(0);

    const connectTerminals = new Set<string>();
    await bench.resolveBenchmarkCommandTerminal('presence-connect', connectTerminals, async () => {
      throw exhaustion();
    });
    for (const kind of ['presence-heartbeat', 'presence-disconnect']) {
      await expect(bench.resolveBenchmarkCommandTerminal(
        kind,
        connectTerminals,
        async () => {
          dependentCalls += 1;
        },
      )).resolves.toMatchObject({ prerequisite: 'presence-connect' });
    }
    expect(dependentCalls).toBe(0);

    const heartbeatTerminals = new Set<string>();
    await bench.resolveBenchmarkCommandTerminal(
      'presence-heartbeat',
      heartbeatTerminals,
      async () => {
        throw exhaustion();
      },
    );
    await expect(bench.resolveBenchmarkCommandTerminal(
      'presence-disconnect',
      heartbeatTerminals,
      async () => {
        dependentCalls += 1;
      },
    )).resolves.toEqual({ status: 'accepted', source: 'production' });
    expect(dependentCalls).toBe(1);

    await expect(bench.resolveBenchmarkCommandTerminal(
      'membership',
      new Set(),
      async () => {
        throw new Error('generic failure');
      },
    )).rejects.toThrow('generic failure');
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

  it('never lets DBW baseline retention waive malformed durable records or finding IDs', () => {
    const malformedDurable: Array<[string, (sample: any) => void]> = [
      ['null receipt', (sample) => {
        sample.durable.receiptCommandIds[0] = null;
      }],
      ['empty receipt', (sample) => {
        sample.durable.receiptCommandIds[0] = '';
      }],
      ['null outbox record', (sample) => {
        sample.durable.outboxIntents[0] = null;
      }],
      ['empty outbox fields', (sample) => {
        sample.durable.outboxIntents[0] = { intentId: '', commandId: '', intentKind: '' };
      }],
      ['unknown outbox command', (sample) => {
        sample.durable.outboxIntents[0].commandId = 'unknown-command';
      }],
    ];

    for (const [label, mutate] of malformedDurable) {
      const malformed = validArtifact();
      const sampleValue = malformed.workloads[0].samples[0];
      mutate(sampleValue);
      sampleValue.correctness.dbwFindings = ['DBW-MALFORMED'];
      refreshSummary(malformed.workloads[0]);

      expect(validateStateWriteArtifact(malformed), label).not.toEqual([]);
      expect(compareStateWriteArtifacts(malformed, validArtifact({ candidate: true })), label)
        .toEqual(expect.arrayContaining([expect.stringContaining('baseline:')]));
      expect(compareStateWriteArtifacts(validArtifact(), malformed), label).toEqual(
        expect.arrayContaining([expect.stringContaining('candidate:')]),
      );
    }

    for (const finding of [null, '', 'NOT-A-DBW-FINDING', 42, 'DBW_']) {
      const malformed = validArtifact();
      malformed.workloads[0].samples[0].correctness.dbwFindings = [finding];
      refreshSummary(malformed.workloads[0]);
      expect(validateStateWriteArtifact(malformed), String(finding)).toEqual(
        expect.arrayContaining([expect.stringContaining('dbwFindings[0]')]),
      );
    }
  });

  it('rejects malformed regression reasons and never lets them authorize a resource increase', () => {
    const malformedReasons = [
      null,
      [],
      {},
      { workload: 'unsupported', metric: 'sql.statements', reason: 'A substantive explanation' },
      { workload: 'shared', metric: 'unsupported.metric', reason: 'A substantive explanation' },
      { workload: 'shared', metric: 'sql.statements', reason: '' },
      { workload: 'shared', metric: 'sql.statements', reason: 'short' },
      {
        workload: 'shared',
        metric: 'sql.statements',
        reason: 'A substantive explanation',
        unexpected: true,
      },
    ];

    for (const [index, reason] of malformedReasons.entries()) {
      const candidate = validArtifact({ candidate: true });
      for (const sampleValue of candidate.workloads[1].samples) {
        sampleValue.sql.statements += 1;
      }
      refreshSummary(candidate.workloads[1]);
      candidate.regressionReasons = [reason];

      expect(validateStateWriteArtifact(candidate), String(index)).toEqual(
        expect.arrayContaining([expect.stringContaining('regressionReasons[0]')]),
      );
      expect(compareStateWriteArtifacts(validArtifact(), candidate), String(index)).toEqual(
        expect.arrayContaining([expect.stringContaining('candidate: regressionReasons[0]')]),
      );
    }
  });

  it('rejects sparse contract arrays before validation or derivation can skip their holes', () => {
    const mutations: Array<[string, (artifact: any) => void]> = [
      ['workload samples', (artifact) => {
        delete artifact.workloads[0].samples[0];
      }],
      ['commands', (artifact) => {
        delete artifact.workloads[0].samples[0].commands[0];
      }],
      ['attempt observations', (artifact) => {
        delete artifact.workloads[0].samples[0].attemptObservations[0];
      }],
      ['latency samples', (artifact) => {
        delete artifact.workloads[0].samples[0].latencySamplesMs[0];
      }],
      ['receipts', (artifact) => {
        const sampleValue = artifact.workloads[0].samples[0];
        delete sampleValue.durable.receiptCommandIds[0];
        sampleValue.correctness.dbwFindings = ['DBW-SPARSE-RECEIPT'];
        refreshSummary(artifact.workloads[0]);
      }],
      ['outbox intents', (artifact) => {
        const sampleValue = artifact.workloads[0].samples[0];
        delete sampleValue.durable.outboxIntents[0];
        sampleValue.correctness.dbwFindings = ['DBW-SPARSE-OUTBOX'];
        refreshSummary(artifact.workloads[0]);
      }],
    ];

    for (const [label, mutate] of mutations) {
      const malformed = validArtifact();
      mutate(malformed);
      expect(validateStateWriteArtifact(malformed), label).toEqual(
        expect.arrayContaining([expect.stringContaining('dense array')]),
      );
      expect(() => compareStateWriteArtifacts(malformed, validArtifact({ candidate: true })), label)
        .not.toThrow();
      expect(compareStateWriteArtifacts(malformed, validArtifact({ candidate: true })), label)
        .toEqual(expect.arrayContaining([expect.stringContaining('baseline:')]));
      expect(compareStateWriteArtifacts(validArtifact(), malformed), label).toEqual(
        expect.arrayContaining([expect.stringContaining('candidate:')]),
      );
    }
  });

  it('rejects sparse stack counts and whitespace-padded regression explanations', async () => {
    const sparseStacks = validArtifact({ candidate: true });
    delete sparseStacks.workloads[0].samples[0].stackCommandCounts[0];
    expect(validateStateWriteArtifact(sparseStacks)).toEqual(expect.arrayContaining([
      expect.stringContaining('stackCommandCounts must be a dense array'),
    ]));
    expect(compareStateWriteArtifacts(validArtifact(), sparseStacks)).toEqual(
      expect.arrayContaining([expect.stringContaining('candidate:')]),
    );

    const comparator = await import('../../../scripts/perf/compare-api-v1-state-write-results.mjs');
    expect(comparator.isSubstantiveRegressionReason).toBeTypeOf('function');
    expect(comparator.isSubstantiveRegressionReason('a        b')).toBe(false);
    expect(comparator.isSubstantiveRegressionReason('Measured query-plan change')).toBe(true);
    const candidate = validArtifact({ candidate: true });
    for (const sampleValue of candidate.workloads[1].samples) {
      sampleValue.sql.statements += 1;
    }
    refreshSummary(candidate.workloads[1]);
    candidate.regressionReasons = [{
      workload: 'shared',
      metric: 'sql.statements',
      reason: 'a        b',
    }];
    expect(validateStateWriteArtifact(candidate)).toEqual(expect.arrayContaining([
      expect.stringContaining('regressionReasons[0].reason'),
    ]));
    expect(compareStateWriteArtifacts(validArtifact(), candidate)).toEqual(
      expect.arrayContaining([expect.stringContaining('candidate: regressionReasons[0].reason')]),
    );
  });
});

function validArtifact(options: { candidate?: boolean } = {}): any {
  const workloads = [
    workload('uncontended', 100),
    workload('shared', 5, options.candidate ? 90 : 100),
    workload('hot', 1),
  ];
  const artifact = {
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
  if (options.candidate) convertToProductionDurability(artifact);
  return artifact;
}

function convertToProductionDurability(artifact: any): void {
  const effects: Record<string, readonly string[]> = {
    'profile-instance': ['client-state-sync', 'client-state-sync'],
    membership: ['group-state-sync', 'group-presence-summary'],
    'presence-connect': ['group-state-sync', 'group-presence-summary'],
    'presence-heartbeat': ['group-state-sync', 'group-presence-summary'],
    'presence-disconnect': ['group-state-sync', 'group-presence-summary'],
    config: ['group-state-sync', 'group-presence-summary'],
    'topology-source': ['rtc-topology-recompute'],
  };
  for (const workloadValue of artifact.workloads) {
    for (const sampleValue of workloadValue.samples) {
      const commandsById = new Map(sampleValue.commands.map((command: any) => [
        command.commandId,
        command,
      ]));
      for (const observation of sampleValue.attemptObservations) {
        const command = commandsById.get(observation.commandId) as any;
        observation.attempt = 0;
        observation.source = command.kind === 'profile-instance'
          ? 'client-state-service.mutation.write'
          : command.kind === 'topology-source'
          ? 'group-topology-config-service.mutation.write'
          : 'group-state-service.mutation.write';
      }
      sampleValue.durable.outboxIntents = sampleValue.commands.flatMap((command: any) =>
        effects[command.kind].map((intentKind, index) => ({
          intentId: `${command.commandId}:production:${index}`,
          commandId: command.commandId,
          intentKind,
        }))
      );
      sampleValue.correctness.requiredOutboxIntentCount =
        sampleValue.durable.outboxIntents.length;
      sampleValue.correctness.outboxIntentCount = sampleValue.durable.outboxIntents.length;
      sampleValue.correctness.effectfulCommandCount = sampleValue.commands.length;
    }
    refreshSummary(workloadValue);
  }
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
  const serviceComponent = command.kind === 'profile-instance'
    ? 'client-state-service'
    : command.kind === 'topology-source'
    ? 'group-topology-config-service'
    : 'group-state-service';
  const firstAttempt = sampleValue.attemptObservations.find(
    (entry: any) => entry.commandId === command.commandId,
  )?.attempt ?? 1;
  const intentCount = sampleValue.durable.outboxIntents.filter(
    (intent: any) => intent.commandId === command.commandId,
  ).length;
  command.status = 'exhausted';
  sampleValue.attemptObservations = sampleValue.attemptObservations.filter(
    (entry: any) => entry.commandId !== command.commandId,
  );
  sampleValue.attemptObservations.push({
    commandId: command.commandId,
    operationId: 'command',
    attempt: firstAttempt,
    outcome: 'conflicted',
    terminal: false,
    source: `${serviceComponent}.mutation.conflict`,
  }, {
    commandId: command.commandId,
    operationId: 'command',
    attempt: firstAttempt + 1,
    outcome: 'exhausted',
    terminal: true,
    source: `${serviceComponent}.mutation.conflict`,
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
    effectfulCommandCount: sampleValue.correctness.effectfulCommandCount -
      (intentCount > 0 ? 1 : 0),
    requiredOutboxIntentCount: sampleValue.correctness.requiredOutboxIntentCount - intentCount,
    outboxIntentCount: sampleValue.correctness.outboxIntentCount - intentCount,
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
