import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  GROUP_TOPOLOGY_CONFLICT_REASON,
  poolGroupTopologyStateWritePositionBalancedResults,
} from '../../../scripts/perf/pool-group-topology-state-write-position-balanced-results.mjs';
import { writeGroupTopologyStateWritePositionBalancedResults } from '../../../scripts/perf/write-group-topology-state-write-position-balanced-results.mjs';
import { createStateWritePerformanceArtifact } from './state-write-performance-artifact-fixture.ts';

const CANDIDATE_COMMIT = '74a62eb22583216e8c6651de069209d7e1a8ca67';
const APPROVED_PR_C_BASE_COMMIT = '1e5f5e55e6ff94c016bfe2cc11af92952a30e32f';
const FORMER_PR_B_BASE_COMMIT = 'cc98414867f22cc28f0137ef40a1887ab862f87d';
const HISTORICAL_PR_A_BASE_COMMIT = '20020977507c3104949da07d27b95e89d3b91c96';
const BASE_TREE = '324b2108c3a6754c2e9d85a4e00c5b8b936a67ea';
const CANDIDATE_TREE = '7f971bcf84aa494265992d17e3c9b99227bd8122';
const HASHES = {
  outerPooler: '1'.repeat(64),
  v1Pooler: '2'.repeat(64),
  globalComparator: '3'.repeat(64),
  childEvaluator: '4'.repeat(64),
} as const;
const OUTPUTS = {
  block1ApprovedBase: 'tmp/perf/block-1-base.json',
  block1Candidate: 'tmp/perf/block-1-candidate.json',
  block1Manifest: 'tmp/perf/block-1-manifest.json',
  block2ApprovedBase: 'tmp/perf/block-2-base.json',
  block2Candidate: 'tmp/perf/block-2-candidate.json',
  block2Manifest: 'tmp/perf/block-2-manifest.json',
  outerManifest: 'tmp/perf/outer-manifest.json',
} as const;
const MIRRORED_DESCRIPTORS = [
  { key: 'candidateThird', position: 1, role: 'candidate' },
  { key: 'approvedBaseThird', position: 2, role: 'approved-base' },
  { key: 'approvedBaseFourth', position: 3, role: 'approved-base' },
  { key: 'candidateFourth', position: 4, role: 'candidate' },
] as const;

describe('group-topology position-balanced state-write pooling', { timeout: 120_000 }, () => {
  it('keeps A-B-B-A and B-A-A-B as separate validated 18-sample evidence blocks', () => {
    const input = createInput();
    const pooled = poolGroupTopologyStateWritePositionBalancedResults(input);
    expect(pooled.manifest.schemaVersion).toBe(
      'rallar.group-topology.state-write-position-balanced-abba-baab.v1',
    );
    expect(pooled.manifest.positions.map(({ role }) => role)).toEqual([
      'approved-base',
      'candidate',
      'candidate',
      'approved-base',
      'candidate',
      'approved-base',
      'approved-base',
      'candidate',
    ]);
    expect(pooled.blocks.map(({ manifest }) => manifest.positions.map(({ role }) => role))).toEqual(
      [
        ['approved-base', 'candidate', 'candidate', 'approved-base'],
        ['candidate', 'approved-base', 'approved-base', 'candidate'],
      ],
    );
    for (const block of pooled.blocks) {
      expect(block.approvedBase.measurement.measuredRuns).toBe(18);
      expect(block.candidate.measurement.measuredRuns).toBe(18);
      expect(block.approvedBase.regressionReasons).toEqual([]);
      expect(block.candidate.regressionReasons).toEqual(createReasons());
    }
    expectPooledSources(pooled.blocks[0].approvedBase, input, [
      'approvedBaseFirst',
      'approvedBaseSecond',
    ]);
    expectPooledSources(pooled.blocks[0].candidate, input, ['candidateFirst', 'candidateSecond']);
    expectPooledSources(pooled.blocks[1].approvedBase, input, [
      'approvedBaseThird',
      'approvedBaseFourth',
    ]);
    expectPooledSources(pooled.blocks[1].candidate, input, ['candidateThird', 'candidateFourth']);
    expect(
      new Set(pooled.manifest.positions.map(({ artifactSha256 }) => artifactSha256)).size,
    ).toBe(8);
    expect(
      new Set(pooled.manifest.positions.map(({ environmentSha256 }) => environmentSha256)).size,
    ).toBe(1);
    expect(pooled.manifest.blocks[1].descriptors).toEqual(
      MIRRORED_DESCRIPTORS.map(({ key, position, role }, index) => ({
        key,
        localPosition: position,
        globalPosition: index + 5,
        role,
        sourcePath: input.sources[key].sourceName,
      })),
    );
  });

  it('fails closed without letting one valid block mask invalid mirrored evidence', () => {
    for (const [expected, mutate] of failures()) {
      const input = createInput();
      mutate(input);
      expect(() => poolGroupTopologyStateWritePositionBalancedResults(input)).toThrow(expected);
    }
  });

  it('writes four pooled artifacts and both inner manifests before the outer manifest', async () => {
    await mkdir('tmp/perf', { recursive: true });
    const directory = await mkdtemp('tmp/perf/rallar-topology-balanced-pooling-');
    try {
      const input = createInput();
      const argumentsInput = await writeCliEvidence(directory, input);
      await writeGroupTopologyStateWritePositionBalancedResults(argumentsInput);
      const outer = JSON.parse(await readFile(join(directory, 'outer-manifest.json'), 'utf8'));
      expect(outer.schemaVersion).toBe(
        'rallar.group-topology.state-write-position-balanced-abba-baab.v1',
      );
      for (const block of outer.blocks) {
        const manifestText = await readFile(block.innerManifest.path, 'utf8');
        expect(sha256(manifestText)).toBe(block.innerManifest.sha256);
        for (const output of Object.values(block.outputs) as any[]) {
          expect(sha256(await readFile(output.path, 'utf8'))).toBe(output.sha256);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['direct', 'hard', 'symbolic', 'symbolic-parent'])(
    'rejects %s evidence path aliases',
    async (kind) => {
      await mkdir('tmp/perf', { recursive: true });
      const directory = await mkdtemp('tmp/perf/rallar-topology-balanced-alias-');
      try {
        const argumentsInput = await writeCliEvidence(directory, createInput());
        const source = readArgumentPath(argumentsInput, 'approved-base-first');
        const sourceBefore = await readFile(source, 'utf8');
        const alias = kind === 'direct' ? source : join(directory, `${kind}-alias.json`);
        if (kind === 'hard') await link(source, alias);
        if (kind === 'symbolic') await symlink(resolve(source), alias);
        if (kind === 'symbolic-parent') {
          const realParent = join(directory, 'real-output');
          const aliasParent = join(directory, 'alias-output');
          await mkdir(realParent);
          await symlink(resolve(realParent), aliasParent, 'dir');
          replaceArgumentPath(
            argumentsInput,
            'block1-approved-base',
            join(realParent, 'pooled.json'),
          );
          replaceArgumentPath(argumentsInput, 'block1-candidate', join(aliasParent, 'pooled.json'));
        } else replaceArgumentPath(argumentsInput, 'block1-approved-base', alias);
        await expect(
          writeGroupTopologyStateWritePositionBalancedResults(argumentsInput),
        ).rejects.toThrow(/paths must be distinct/);
        expect(await readFile(source, 'utf8')).toBe(sourceBefore);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

function expectPooledSources(pooled: any, input: any, sourceKeys: readonly string[]): void {
  for (const [workloadIndex, workload] of pooled.workloads.entries()) {
    const sources = sourceKeys.flatMap(
      (key) => JSON.parse(input.sources[key].artifactText).workloads[workloadIndex].samples,
    );
    expect(workload.samples).toEqual(
      sources.map((sample, runIndex) => ({ ...structuredClone(sample), runIndex })),
    );
  }
}

function createInput(): any {
  return {
    expectedApprovedBaseCommit: APPROVED_PR_C_BASE_COMMIT,
    expectedApprovedBaseTree: BASE_TREE,
    expectedCandidateCommit: CANDIDATE_COMMIT,
    expectedCandidateTree: CANDIDATE_TREE,
    conflictReasonPath: 'tmp/perf/topology-conflict-reasons.json',
    conflictReasonText: JSON.stringify({
      schemaVersion: 'rallar.group-topology.state-write-conflict-reasons.v1',
      baseCommit: APPROVED_PR_C_BASE_COMMIT,
      candidateCommit: CANDIDATE_COMMIT,
      candidateTree: CANDIDATE_TREE,
      reasons: createReasons(),
    }),
    sources: Object.fromEntries(
      [
        ['approvedBaseFirst', false, 'a1', '00:01:00'],
        ['candidateFirst', true, 'b1', '00:02:00'],
        ['candidateSecond', true, 'b2', '00:03:00'],
        ['approvedBaseSecond', false, 'a2', '00:04:00'],
        ['candidateThird', true, 'b3', '00:05:00'],
        ['approvedBaseThird', false, 'a3', '00:06:00'],
        ['approvedBaseFourth', false, 'a4', '00:07:00'],
        ['candidateFourth', true, 'b4', '00:08:00'],
      ].map(([key, candidate, id, time]) => [key, createSource(candidate, id, time)]),
    ),
    outputs: { ...OUTPUTS },
    toolSha256: { ...HASHES },
  };
}

function createSource(candidate: boolean, artifactId: string, time: string): any {
  const artifact = createStateWritePerformanceArtifact({
    artifactId,
    generatedAt: `2026-08-01T${time}.000Z`,
    gitCommit: candidate ? CANDIDATE_COMMIT : APPROVED_PR_C_BASE_COMMIT,
    measuredRuns: 9,
  });
  artifact.regressionReasons = candidate ? createReasons() : [];
  return {
    artifactText: JSON.stringify(artifact),
    environmentText: ENVIRONMENT,
    sourceName: `tmp/perf/${artifactId}.json`,
    environmentName: `tmp/perf/${artifactId}.environment.txt`,
  };
}

function createReasons(): any[] {
  const metrics = [
    'sql.statements',
    'sql.rowsRead',
    'sql.serializedResultBytes',
    'postgres.transactionDurationMs',
  ];
  return ['uncontended', 'shared', 'hot'].flatMap((workload) =>
    metrics.map((metric) => ({ workload, metric, reason: GROUP_TOPOLOGY_CONFLICT_REASON })),
  );
}

const failures = (): readonly [RegExp, (input: any) => void][] => [
  ...measurementFailures(),
  ...protocolFailures(),
];

function measurementFailures(): readonly [RegExp, (input: any) => void][] {
  return [
    [
      /artifact hashes must be unique/,
      (input) => {
        input.sources.candidateFourth.artifactText = input.sources.candidateThird.artifactText;
      },
    ],
    [
      /environment records must match/,
      (input) => {
        input.sources.candidateFourth.environmentText += 'unexpected=true\n';
      },
    ],
    [
      /eight-position chronological order/,
      (input) => {
        const artifact = JSON.parse(input.sources.candidateThird.artifactText);
        artifact.generatedAt = '2026-08-01T00:03:30.000Z';
        input.sources.candidateThird.artifactText = JSON.stringify(artifact);
      },
    ],
    [
      /base positions must have empty regression reasons/,
      (input) => {
        const artifact = JSON.parse(input.sources.approvedBaseFirst.artifactText);
        artifact.regressionReasons = createReasons();
        input.sources.approvedBaseFirst.artifactText = JSON.stringify(artifact);
      },
    ],
    [
      /candidate positions must have precommitted regression reasons/,
      (input) => {
        const artifact = JSON.parse(input.sources.candidateThird.artifactText);
        artifact.regressionReasons = [];
        input.sources.candidateThird.artifactText = JSON.stringify(artifact);
      },
    ],
    [
      /raw command IDs must be unique across position-balanced blocks/,
      (input) => {
        const reused = JSON.parse(input.sources.candidateFirst.artifactText);
        reused.generatedAt = '2026-08-01T00:05:00.000Z';
        input.sources.candidateThird.artifactText = JSON.stringify(reused);
      },
    ],
  ];
}

function protocolFailures(): readonly [RegExp, (input: any) => void][] {
  return [
    [
      /approved base must equal the precommitted group-topology base/,
      (input) => {
        input.expectedApprovedBaseCommit = FORMER_PR_B_BASE_COMMIT;
      },
    ],
    [
      /approved base must equal the precommitted group-topology base/,
      (input) => {
        input.expectedApprovedBaseCommit = HISTORICAL_PR_A_BASE_COMMIT;
      },
    ],
    [
      /position 1 source path/,
      (input) => {
        input.sources.approvedBaseFirst.sourceName = '../outside.json';
      },
    ],
    [/identity is invalid/, (input) => (input.expectedCandidateTree = BASE_TREE)],
    [/output fields are invalid/, (input) => (input.outputs.extra = 'tmp/perf/extra.json')],
    [
      /paths must be distinct/,
      (input) => {
        input.outputs.block1ApprovedBase = input.sources.approvedBaseFirst.sourceName;
      },
    ],
    [/tool SHA-256/, (input) => (input.toolSha256.outerPooler = 'invalid')],
    [
      /candidate commit must equal/,
      (input) => {
        const artifact = JSON.parse(input.sources.candidateThird.artifactText);
        artifact.gitCommit = APPROVED_PR_C_BASE_COMMIT;
        input.sources.candidateThird.artifactText = JSON.stringify(artifact);
      },
    ],
    [
      /position 1 artifact validation failed/,
      (input) => {
        const artifact = JSON.parse(input.sources.candidateThird.artifactText);
        artifact.workloads[0].samples[0].durableEvidence.receipts.shift();
        input.sources.candidateThird.artifactText = JSON.stringify(artifact);
      },
    ],
    [
      /output paths must be distinct/,
      (input) => {
        input.outputs.block2Candidate = input.outputs.block1Candidate;
      },
    ],
  ];
}

const ENVIRONMENT = `${[
  'image_ref=postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171',
  'image_id=sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171',
  'repo_digest=postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171',
  'platform=linux\nimage_architecture=arm64\nimage_os=linux\nentrypoint=docker-entrypoint.sh',
  'command=postgres -c autovacuum=off',
  'shm_size=268435456\nmemory=4294967296\nmemory_swap=4294967296',
  'nano_cpus=4000000000\ncpu_period=0\ncpu_quota=0\ncpu_set=',
  'server_version=16.14 (Debian 16.14-1.pgdg13+1)',
  'autovacuum=off\ntrack_counts=on\nshared_buffers=16384\nwork_mem=4096',
  'maintenance_work_mem=65536\neffective_cache_size=524288\nrandom_page_cost=4',
  'effective_io_concurrency=1\nsynchronous_commit=on',
  'fsync=on\nfull_page_writes=on\nmax_wal_size=1024\ncheckpoint_timeout=300',
  'jit=on\nmax_parallel_workers_per_gather=2',
  'host_architecture=arm64\nnode=v26.5.1\nnpm=11.17.0',
  'deno=2.9.4 aarch64-apple-darwin\ndeno_v8=15.0.245.2-rusty\ndeno_typescript=6.0.3',
  'docker=29.6.2 dfc4efb\ndocker_compose=5.3.1\nfresh_container=true',
  'container_overlap_count=0\nbenchmark_process_overlap_count=0',
  'preflight_app_data_store_rows=0\npreflight_client_state_events_rows=0',
  'preflight_group_state_events_rows=0\npreflight_resource_inbox_rows=0',
  'preflight_resource_inbox_results_rows=0\npreflight_runtime_state_store_rows=0',
  'preflight_automatic_maintenance_count=0\npostflight_automatic_maintenance_count=0',
].join('\n')}\n`;

async function writeCliEvidence(directory: string, input: any): Promise<string[]> {
  const argumentsInput = [
    `--expected-approved-base-commit=${input.expectedApprovedBaseCommit}`,
    `--expected-approved-base-tree=${input.expectedApprovedBaseTree}`,
    `--expected-candidate-commit=${input.expectedCandidateCommit}`,
    `--expected-candidate-tree=${input.expectedCandidateTree}`,
  ];
  const reasonPath = join(directory, 'reasons.json');
  await writeFile(reasonPath, input.conflictReasonText);
  argumentsInput.push(`--conflict-reasons-file=${reasonPath}`);
  for (const [key, source] of Object.entries(input.sources) as any[]) {
    const artifact = join(directory, `${key}.json`);
    const environment = join(directory, `${key}.environment.txt`);
    await Promise.all([
      writeFile(artifact, source.artifactText),
      writeFile(environment, source.environmentText),
    ]);
    argumentsInput.push(`--${toKebabCase(key)}=${artifact}`);
    argumentsInput.push(`--${toKebabCase(key)}-environment=${environment}`);
  }
  for (const [key, output] of Object.entries(OUTPUTS)) {
    argumentsInput.push(`--${toKebabCase(key)}=${join(directory, output.split('/').at(-1)!)}`);
  }
  for (const [key, hash] of Object.entries(HASHES)) {
    argumentsInput.push(`--${toKebabCase(key)}-sha256=${hash}`);
  }
  return argumentsInput;
}

const toKebabCase = (value: string): string => value.replaceAll(/([A-Z])/g, '-$1').toLowerCase();
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const readArgumentPath = (args: readonly string[], name: string): string =>
  args
    .find((argument) => argument.startsWith(`--${name}=`))!
    .split('=')
    .slice(1)
    .join('=');
const replaceArgumentPath = (args: string[], name: string, path: string): void => {
  args[args.findIndex((argument) => argument.startsWith(`--${name}=`))] = `--${name}=${path}`;
};
