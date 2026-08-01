import { createHash } from 'node:crypto';
import { access, link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateStateWriteArtifact } from '../../../scripts/perf/compare-api-v1-state-write-results.mjs';
import { poolApiV1StateWriteResults } from '../../../scripts/perf/pool-api-v1-state-write-results.mjs';
import { writeApiV1StateWritePooledResults } from '../../../scripts/perf/write-api-v1-state-write-pooled-results.mjs';
import { createStateWritePerformanceArtifact } from './state-write-performance-artifact-fixture.ts';

const APPROVED_BASE_COMMIT = '52d973bb71dda2100455e8585a0a8f98d177bd13';
const CANDIDATE_COMMIT = 'c8b842cb5156ef231f68dd711700ae66ffda844c';
const ENVIRONMENT = `${[
  'image_ref=postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171',
  'image_id=sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171',
  'repo_digest=postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171',
  'platform=linux',
  'image_architecture=arm64',
  'image_os=linux',
  'entrypoint=docker-entrypoint.sh',
  'command=postgres -c autovacuum=off',
  'shm_size=268435456',
  'memory=4294967296',
  'memory_swap=4294967296',
  'nano_cpus=4000000000',
  'cpu_period=0',
  'cpu_quota=0',
  'cpu_set=',
  'server_version=16.14 (Debian 16.14-1.pgdg13+1)',
  'autovacuum=off',
  'track_counts=on',
  'shared_buffers=16384',
  'work_mem=4096',
  'maintenance_work_mem=65536',
  'effective_cache_size=524288',
  'random_page_cost=4',
  'effective_io_concurrency=1',
  'synchronous_commit=on',
  'fsync=on',
  'full_page_writes=on',
  'max_wal_size=1024',
  'checkpoint_timeout=300',
  'jit=on',
  'max_parallel_workers_per_gather=2',
  'host_architecture=arm64',
  'node=v26.5.1',
  'npm=11.17.0',
  'deno=2.9.4 aarch64-apple-darwin',
  'deno_v8=15.0.245.2-rusty',
  'deno_typescript=6.0.3',
  'docker=29.6.2 dfc4efb',
  'docker_compose=5.3.1',
  'fresh_container=true',
  'container_overlap_count=0',
  'benchmark_process_overlap_count=0',
  'preflight_app_data_store_rows=0',
  'preflight_client_state_events_rows=0',
  'preflight_group_state_events_rows=0',
  'preflight_resource_inbox_rows=0',
  'preflight_resource_inbox_results_rows=0',
  'preflight_runtime_state_store_rows=0',
  'preflight_automatic_maintenance_count=0',
  'postflight_automatic_maintenance_count=0',
].join('\n')}\n`;

describe('API-v1 state-write order-balanced pooling', { timeout: 30_000 }, () => {
  it('pools A-B-B-A sources into validated 18-run artifacts without losing raw samples', () => {
    const input = createPoolingInput();
    const pooled = poolApiV1StateWriteResults(input);

    expect(validateStateWriteArtifact(pooled.approvedBase)).toEqual([]);
    expect(validateStateWriteArtifact(pooled.candidate)).toEqual([]);
    expect(pooled.approvedBase.measurement.measuredRuns).toBe(18);
    expect(pooled.candidate.measurement.measuredRuns).toBe(18);
    expect(pooled.manifest.positions.map(({ position, role }) => ({ position, role }))).toEqual([
      { position: 1, role: 'approved-base' },
      { position: 2, role: 'candidate' },
      { position: 3, role: 'candidate' },
      { position: 4, role: 'approved-base' },
    ]);
    expect(pooled.manifest.environmentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(pooled.manifest.positions.map((position) => position.artifactSha256)).size).toBe(
      4,
    );

    const sources = parseSources(input);
    expectSamplesPreserved(
      pooled.approvedBase,
      sources.approvedBaseFirst,
      sources.approvedBaseSecond,
    );
    expectSamplesPreserved(pooled.candidate, sources.candidateFirst, sources.candidateSecond);
  });

  it('rejects a source that the unchanged artifact validator rejects', () => {
    const input = createPoolingInput();
    const artifact = JSON.parse(input.sources.candidateFirst.artifactText);
    artifact.workloads[0].samples[0].durableEvidence.receipts.shift();
    input.sources.candidateFirst.artifactText = JSON.stringify(artifact);

    expect(() => poolApiV1StateWriteResults(input)).toThrow(
      /position 2 artifact validation failed/,
    );
  });

  it('rejects reused artifacts, mismatched environments, wrong commits, and non-A-B-B-A time order', () => {
    const reused = createPoolingInput();
    reused.sources.candidateSecond.artifactText = reused.sources.candidateFirst.artifactText;
    expect(() => poolApiV1StateWriteResults(reused)).toThrow(/artifact hashes must be unique/);

    const environmentMismatch = createPoolingInput();
    environmentMismatch.sources.approvedBaseSecond.environmentText =
      environmentMismatch.sources.approvedBaseSecond.environmentText.replace(
        'server_version=16.14',
        'server_version=16.13',
      );
    expect(() => poolApiV1StateWriteResults(environmentMismatch)).toThrow(
      /environment records must match byte-for-byte/,
    );

    const wrongCommit = createPoolingInput();
    wrongCommit.expectedCandidateCommit = APPROVED_BASE_COMMIT;
    expect(() => poolApiV1StateWriteResults(wrongCommit)).toThrow(/candidate commit/);

    const wrongOrder = createPoolingInput();
    const candidateSecond = JSON.parse(wrongOrder.sources.candidateSecond.artifactText);
    candidateSecond.generatedAt = '2026-08-01T00:01:30.000Z';
    wrongOrder.sources.candidateSecond.artifactText = JSON.stringify(candidateSecond);
    expect(() => poolApiV1StateWriteResults(wrongOrder)).toThrow(
      /generatedAt values must increase in A-B-B-A order/,
    );
  });

  it('rejects byte-identical text that is not the required PostgreSQL environment record', () => {
    const input = createPoolingInput();
    for (const source of Object.values(input.sources)) {
      source.environmentText = 'not-postgres\n';
    }

    expect(() => poolApiV1StateWriteResults(input)).toThrow(
      /environment record fields must match the governed schema/,
    );
  });

  it('rejects incompatible same-role metadata and duplicate raw command identities', () => {
    const metadataMismatch = createPoolingInput();
    const approvedBaseSecond = JSON.parse(metadataMismatch.sources.approvedBaseSecond.artifactText);
    approvedBaseSecond.features.evidence = 'different evidence owner';
    metadataMismatch.sources.approvedBaseSecond.artifactText = JSON.stringify(approvedBaseSecond);
    expect(() => poolApiV1StateWriteResults(metadataMismatch)).toThrow(
      /approved-base artifact metadata must match/,
    );

    const unknownMetadata = createPoolingInput();
    const sourceWithUnknownMetadata = JSON.parse(
      unknownMetadata.sources.approvedBaseSecond.artifactText,
    );
    sourceWithUnknownMetadata.uncheckedMetadata = 'must not be dropped';
    unknownMetadata.sources.approvedBaseSecond.artifactText =
      JSON.stringify(sourceWithUnknownMetadata);
    expect(() => poolApiV1StateWriteResults(unknownMetadata)).toThrow(
      /artifact fields must match the governed schema/,
    );

    const duplicateCommands = createPoolingInput();
    const candidateSecond = JSON.parse(duplicateCommands.sources.candidateSecond.artifactText);
    const candidateFirst = JSON.parse(duplicateCommands.sources.candidateFirst.artifactText);
    candidateSecond.workloads = candidateFirst.workloads;
    candidateSecond.generatedAt = '2026-08-01T00:03:00.000Z';
    duplicateCommands.sources.candidateSecond.artifactText = JSON.stringify(candidateSecond);
    expect(() => poolApiV1StateWriteResults(duplicateCommands)).toThrow(
      /raw command IDs must be unique across pooled sources/,
    );
  });

  it('writes both validated pooled artifacts and their exact output hashes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rallar-state-write-pooling-'));
    try {
      const input = createPoolingInput();
      const expected = poolApiV1StateWriteResults(input);
      const paths = await writeSourceFiles(directory, input);
      const approvedBaseOut = join(directory, 'approved-base-pooled.json');
      const candidateOut = join(directory, 'candidate-pooled.json');
      const manifestOut = join(directory, 'manifest.json');
      await writeApiV1StateWritePooledResults(
        toWriterArguments(paths, { approvedBaseOut, candidateOut, manifestOut }),
      );

      const approvedBaseText = await readFile(approvedBaseOut, 'utf8');
      const candidateText = await readFile(candidateOut, 'utf8');
      const manifest = JSON.parse(await readFile(manifestOut, 'utf8'));
      expect(approvedBaseText).toBe(`${JSON.stringify(expected.approvedBase)}\n`);
      expect(candidateText).toBe(`${JSON.stringify(expected.candidate)}\n`);
      expect(validateStateWriteArtifact(JSON.parse(approvedBaseText))).toEqual([]);
      expect(validateStateWriteArtifact(JSON.parse(candidateText))).toEqual([]);
      expect(manifest.outputs).toEqual({
        approvedBase: { path: approvedBaseOut, sha256: sha256(approvedBaseText) },
        candidate: { path: candidateOut, sha256: sha256(candidateText) },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects aliased evidence paths before writing any pooled output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rallar-state-write-pooling-alias-'));
    try {
      const paths = await writeSourceFiles(directory, createPoolingInput());
      const aliasedOut = join(directory, 'aliased.json');
      const manifestOut = join(directory, 'manifest.json');
      await expect(
        writeApiV1StateWritePooledResults(
          toWriterArguments(paths, {
            approvedBaseOut: aliasedOut,
            candidateOut: aliasedOut,
            manifestOut,
          }),
        ),
      ).rejects.toThrow(/source, environment, output, and manifest paths must be distinct/);
      await expect(access(aliasedOut)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['symbolic', 'hard'])('rejects %s-link evidence aliases', async (linkKind) => {
    const directory = await mkdtemp(join(tmpdir(), `rallar-state-write-pooling-${linkKind}-`));
    try {
      const paths = await writeSourceFiles(directory, createPoolingInput());
      const sourcePath = paths.approvedBaseFirst.artifact;
      const sourceBefore = await readFile(sourcePath, 'utf8');
      const aliasedOut = join(directory, 'aliased.json');
      if (linkKind === 'symbolic') {
        await symlink(sourcePath, aliasedOut);
      } else {
        await link(sourcePath, aliasedOut);
      }
      await expect(
        writeApiV1StateWritePooledResults(
          toWriterArguments(paths, {
            approvedBaseOut: aliasedOut,
            candidateOut: join(directory, 'candidate.json'),
            manifestOut: join(directory, 'manifest.json'),
          }),
        ),
      ).rejects.toThrow(/source, environment, output, and manifest paths must be distinct/);
      expect(await readFile(sourcePath, 'utf8')).toBe(sourceBefore);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

interface PoolingSourceText {
  artifactText: string;
  environmentText: string;
  sourceName: string;
}

interface PoolingInput {
  expectedApprovedBaseCommit: string;
  expectedCandidateCommit: string;
  sources: {
    approvedBaseFirst: PoolingSourceText;
    candidateFirst: PoolingSourceText;
    candidateSecond: PoolingSourceText;
    approvedBaseSecond: PoolingSourceText;
  };
}

function createPoolingInput(): PoolingInput {
  return {
    expectedApprovedBaseCommit: APPROVED_BASE_COMMIT,
    expectedCandidateCommit: CANDIDATE_COMMIT,
    sources: {
      approvedBaseFirst: createSource({
        candidate: true,
        artifactId: 'a1',
        gitCommit: APPROVED_BASE_COMMIT,
        time: '00:01:00',
      }),
      candidateFirst: createSource({
        candidate: true,
        artifactId: 'b2',
        gitCommit: CANDIDATE_COMMIT,
        time: '00:02:00',
      }),
      candidateSecond: createSource({
        candidate: true,
        artifactId: 'b3',
        gitCommit: CANDIDATE_COMMIT,
        time: '00:03:00',
      }),
      approvedBaseSecond: createSource({
        candidate: true,
        artifactId: 'a4',
        gitCommit: APPROVED_BASE_COMMIT,
        time: '00:04:00',
      }),
    },
  };
}

interface CreateSourceInput {
  readonly candidate: boolean;
  readonly artifactId: string;
  readonly gitCommit: string;
  readonly time: string;
}

function createSource(input: CreateSourceInput): PoolingSourceText {
  const { candidate, artifactId, gitCommit, time } = input;
  return {
    artifactText: JSON.stringify(
      createStateWritePerformanceArtifact(candidate, {
        artifactId,
        generatedAt: `2026-08-01T${time}.000Z`,
        gitCommit,
        measuredRuns: 9,
      }),
    ),
    environmentText: ENVIRONMENT,
    sourceName: `${artifactId}.json`,
  };
}

function parseSources(input: PoolingInput): Record<string, any> {
  return Object.fromEntries(
    Object.entries(input.sources).map(([name, source]) => [name, JSON.parse(source.artifactText)]),
  );
}

function expectSamplesPreserved(pooled: any, first: any, second: any): void {
  for (const pooledWorkload of pooled.workloads) {
    const sourceSamples = [first, second].flatMap(
      (artifact) =>
        artifact.workloads.find((workload: any) => workload.name === pooledWorkload.name).samples,
    );
    expect(pooledWorkload.samples.map(withoutRunIndex)).toEqual(sourceSamples.map(withoutRunIndex));
    expect(pooledWorkload.samples.map((sample: any) => sample.runIndex)).toEqual(
      Array.from({ length: 18 }, (_, index) => index),
    );
  }
}

function withoutRunIndex(sample: any): any {
  const { runIndex: _runIndex, ...preserved } = sample;
  return preserved;
}

async function writeSourceFiles(
  directory: string,
  input: PoolingInput,
): Promise<Record<string, { artifact: string; environment: string }>> {
  const entries = await Promise.all(
    Object.entries(input.sources).map(async ([key, source]) => {
      const artifact = join(directory, `${key}.json`);
      const environment = join(directory, `${key}.environment.txt`);
      await Promise.all([
        writeFile(artifact, source.artifactText),
        writeFile(environment, source.environmentText),
      ]);
      return [key, { artifact, environment }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

interface WriterOutputPaths {
  readonly approvedBaseOut: string;
  readonly candidateOut: string;
  readonly manifestOut: string;
}

function toWriterArguments(
  paths: Record<string, { artifact: string; environment: string }>,
  output: WriterOutputPaths,
): string[] {
  return [
    `--expected-approved-base-commit=${APPROVED_BASE_COMMIT}`,
    `--expected-candidate-commit=${CANDIDATE_COMMIT}`,
    `--approved-base-first=${paths.approvedBaseFirst.artifact}`,
    `--candidate-first=${paths.candidateFirst.artifact}`,
    `--candidate-second=${paths.candidateSecond.artifact}`,
    `--approved-base-second=${paths.approvedBaseSecond.artifact}`,
    `--approved-base-first-environment=${paths.approvedBaseFirst.environment}`,
    `--candidate-first-environment=${paths.candidateFirst.environment}`,
    `--candidate-second-environment=${paths.candidateSecond.environment}`,
    `--approved-base-second-environment=${paths.approvedBaseSecond.environment}`,
    `--approved-base-out=${output.approvedBaseOut}`,
    `--candidate-out=${output.candidateOut}`,
    `--manifest-out=${output.manifestOut}`,
  ];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
