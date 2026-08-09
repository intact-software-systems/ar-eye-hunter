import { STATE_WRITE_ARTIFACT_SCHEMA_VERSION } from '../compare-api-v1-state-write-results.mjs';

export interface BenchmarkGitIdentity {
  readonly commit: string;
  readonly tree: string;
}

interface StateWriteBenchmarkArtifactOptions {
  readonly backend: string;
  readonly warmup: number;
  readonly runs: number;
  readonly concurrency: number;
}

export interface StateWriteBenchmarkRegressionReason {
  readonly workload: string;
  readonly metric: string;
  readonly reason: string;
}

export interface StateWriteBenchmarkArtifactInput {
  readonly generatedAt: string;
  readonly gitIdentity: BenchmarkGitIdentity;
  readonly options: StateWriteBenchmarkArtifactOptions;
  readonly regressionReasons: readonly StateWriteBenchmarkRegressionReason[];
  readonly workloads: readonly object[];
}

export interface StateWriteBenchmarkArtifact {
  readonly schemaVersion: string;
  readonly gitCommit: string;
  readonly backend: string;
  readonly generatedAt: string;
  readonly measurement: Readonly<{
    warmupRuns: number;
    measuredRuns: number;
    concurrency: number;
    mutationTimingExcludes: readonly string[];
    tailSamplesDiscarded: boolean;
    counterSources: Readonly<Record<string, string>>;
  }>;
  readonly features: Readonly<{
    presenceSplitFromGroupAggregate: boolean;
    governance: string;
    evidence: string;
  }>;
  readonly regressionReasons: readonly StateWriteBenchmarkRegressionReason[];
  readonly workloads: readonly object[];
}

export async function readBenchmarkGitIdentity(): Promise<BenchmarkGitIdentity> {
  const command = new Deno.Command('git', {
    args: ['rev-parse', 'HEAD', 'HEAD^{tree}'],
    stdout: 'piped',
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error('Unable to resolve git commit and tree for benchmark artifact');
  }
  const [commit, tree] = new TextDecoder().decode(output.stdout).trim().split('\n');
  return { commit: commit!, tree: tree! };
}

export function createStateWriteBenchmarkArtifact(
  input: StateWriteBenchmarkArtifactInput,
): StateWriteBenchmarkArtifact {
  return {
    schemaVersion: STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
    gitCommit: input.gitIdentity.commit,
    backend: input.options.backend,
    generatedAt: input.generatedAt,
    measurement: {
      warmupRuns: input.options.warmup,
      measuredRuns: input.options.runs,
      concurrency: input.options.concurrency,
      mutationTimingExcludes: ['setup', 'auth-session insertion', 'http', 'evidence queries'],
      tailSamplesDiscarded: false,
      counterSources: {
        sql:
          'thin postgres.js wrapper around both independent service clients, ' +
          'including production auth-session lookup and revalidation',
        sharedBuffers: 'pg_stat_database immediately before and after each measured phase',
        wal: 'pg_current_wal_lsn immediately before and after each measured phase',
        lockWait: '5ms pg_stat_activity sampling of benchmark service backends waiting on Lock',
        cpu: 'benchmark process user plus system CPU time',
        rowsRead: 'row counts returned by the thin postgres.js wrapper',
        serializedResultBytes:
          'JSON byte length of values returned by the thin postgres.js wrapper',
        transactionDuration: 'wall-clock duration of production repository sql.begin calls',
        readTiming: 'read-classified production SQL duration from the postgres.js wrapper',
        computeTiming:
          'production timing-sink events explicitly labeled phase=compute; zero when unavailable',
        validateTiming:
          'production timing-sink events explicitly labeled phase=validate; zero when unavailable',
        writeTiming: 'production client/group/topology mutation.write timing-sink events',
        outboxTiming:
          'direct APP_OUTBOX/WS_OUTBOX resource_inbox SQL through the postgres.js wrapper',
        outbox: 'resource_inbox',
        attempts: 'resource_inbox.release.telemetry+app_inbox.ri_attempts reconciliation',
        receipts:
          'complete production client/group/topology idempotency receipts ' +
          'queried after the phase ' +
          'through uninstrumented repositories and projected only when every raw-command ' +
          'subreceipt is valid',
        outboxIntents: 'legacy counter name retained only for governed baseline compatibility',
      },
    },
    features: {
      presenceSplitFromGroupAggregate: true,
      governance: 'task10-post-remediation-candidate',
      evidence: 'Transactional AppInbox completion, receipts, and direct ResourceInbox effects',
    },
    regressionReasons: input.regressionReasons,
    workloads: input.workloads,
  };
}
