import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeBuildAffectingTreeDigest } from '../../../../scripts/pr-human-review/review-freshness.mjs';

const repository = 'intact-software-systems/ar-eye-hunter';
const workflowPath = '.github/workflows/branch-release-gate.yml';
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('validation evidence reuse', () => {
  it('reuses prior successful evidence after an unrelated documentation-only commit', () => {
    const fixture = createEvidenceFixture();
    const candidateHead = commit(fixture.repoRoot, 'docs only', {
      'docs/unrelated-guide.md': 'clarified prose\n',
    });

    const selection = runSelection(fixture, candidateHead);

    expect(selection.result.stderr).toBe('');
    expect(selection.result.status).toBe(0);
    expect(selection.outputs).toMatchObject({
      reuse: 'true',
      reason: 'reusable-validation-evidence',
      evidence_head: fixture.evidenceHead,
      build_tree_digest: fixture.buildTreeDigest,
    });
  });

  it.each([
    ['production code', 'apps/example/main.ts'],
    ['tests', 'packages/tests/example/main.test.ts'],
    ['workflow', '.github/workflows/ci.yml'],
    ['custom action', '.github/actions/example/action.yml'],
    ['package metadata', 'packages/example/package.json'],
    ['lockfile', 'package-lock.json'],
    ['root build configuration', 'tsconfig.json'],
    ['agent contract', 'AGENTS.md'],
    ['plugin contract', '.codex-plugin/plugin.json'],
    ['adaptive plan contract', 'plans/example-plan.md'],
  ])('runs broad validation when %s changes', (_label, changedPath) => {
    const fixture = createEvidenceFixture();
    const candidateHead = commit(fixture.repoRoot, `change ${changedPath}`, {
      [changedPath]: `changed ${changedPath}\n`,
    });

    const selection = runSelection(fixture, candidateHead);

    expect(selection.result.stderr).toBe('');
    expect(selection.result.status).toBe(0);
    expect(selection.outputs).toMatchObject({
      reuse: 'false',
      reason: 'build-tree-digest-mismatch',
    });
    expect(selection.outputs.build_tree_digest).not.toBe(fixture.buildTreeDigest);
  });

  it.each([
    ['failed run', { run: { conclusion: 'failure' } }],
    ['wrong repository', { run: { repository: { full_name: 'other/repository' } } }],
    ['wrong workflow', { run: { path: '.github/workflows/other.yml' } }],
    ['mismatched run identity', { evidence: { workflow: { runId: 9999 } } }],
    ['mismatched workflow identity', { evidence: { workflow: { id: 9999 } } }],
    ['mismatched head', { evidence: { head: 'f'.repeat(40) } }],
    ['non-success release job', { evidence: { releaseGate: { conclusion: 'failure' } } }],
    [
      'completion outside the run',
      { evidence: { releaseGate: { completedAt: '2026-08-13T09:11:00.000Z' } } },
    ],
    ['expired evidence', { now: '2026-08-21T10:05:00.000Z' }],
    ['malformed artifact', { artifactSource: '{not-json}\n' }],
  ])('fails closed for %s', (_label, mutation) => {
    const fixture = createEvidenceFixture(mutation);
    const candidateHead = commit(fixture.repoRoot, 'docs only', {
      'docs/unrelated-guide.md': 'clarified prose\n',
    });

    const selection = runSelection(fixture, candidateHead, mutation.now);

    expect(selection.result.status).toBe(0);
    expect(selection.outputs.reuse).toBe('false');
    expect(selection.outputs.reason).not.toBe('reusable-validation-evidence');
  });

  it('rejects matching evidence whose head is not an ancestor of the candidate', () => {
    const fixture = createEvidenceFixture();
    const candidateHead = createUnrelatedCommit(fixture.repoRoot, fixture.evidenceHead);

    const selection = runSelection(fixture, candidateHead);

    expect(selection.result.status).toBe(0);
    expect(selection.outputs).toMatchObject({
      reuse: 'false',
      reason: 'validation-evidence-head-is-not-ancestor',
    });
  });
});

function createEvidenceFixture(mutation: Record<string, any> = {}) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'validation-evidence-reuse-'));
  fixtureRoots.push(fixtureRoot);
  const gitRoot = path.join(fixtureRoot, 'repository');
  mkdirSync(gitRoot);
  runGit(gitRoot, ['init', '--initial-branch=feature']);
  runGit(gitRoot, ['config', 'user.name', 'Validation Evidence Test']);
  runGit(gitRoot, ['config', 'user.email', 'validation-evidence@example.invalid']);
  const evidenceHead = commit(gitRoot, 'base', {
    'package.json': '{"name":"fixture"}\n',
    'apps/example/main.ts': 'export const value = 1;\n',
  });
  const buildTreeDigest = computeBuildAffectingTreeDigest({
    repoRoot: gitRoot,
    headSha: evidenceHead,
  });
  const run = mergeRecord(
    {
      id: 4123,
      run_attempt: 2,
      head_sha: evidenceHead,
      head_branch: 'feature',
      workflow_id: 987,
      path: workflowPath,
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-08-13T09:00:00.000Z',
      updated_at: '2026-08-13T09:10:00.000Z',
      repository: { full_name: repository },
    },
    mutation.run,
  );
  const evidence = mergeRecord(
    {
      schemaVersion: 'validation-evidence-v1',
      repository,
      workflow: { id: 987, path: workflowPath, runId: 4123, runAttempt: 2 },
      head: evidenceHead,
      buildTreeDigest,
      releaseGate: {
        jobId: 7123,
        name: 'Release Gate / Release Gate',
        conclusion: 'success',
        completedAt: '2026-08-13T09:08:00.000Z',
      },
    },
    mutation.evidence,
  );
  const inputRoot = path.join(fixtureRoot, 'input');
  const artifactRoot = path.join(inputRoot, 'artifacts', '4123');
  const jobsRoot = path.join(inputRoot, 'jobs', '4123');
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(jobsRoot, { recursive: true });
  writeFileSync(
    path.join(inputRoot, 'runs.json'),
    `${JSON.stringify({ total_count: 1, workflow_runs: [run] })}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(artifactRoot, 'validation-evidence-v1.json'),
    mutation.artifactSource ?? `${JSON.stringify(evidence)}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(jobsRoot, 'jobs.json'),
    `${JSON.stringify({
      total_count: 1,
      jobs: [
        {
          id: 7123,
          run_id: 4123,
          head_sha: evidenceHead,
          name: 'Release Gate / Release Gate',
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-08-13T09:08:00Z',
        },
      ],
    })}\n`,
    'utf8',
  );
  return { repoRoot: gitRoot, inputRoot, evidenceHead, buildTreeDigest };
}

function runSelection(fixture: any, candidateHead: string, now = '2026-08-13T10:00:00.000Z') {
  const outputPath = path.join(fixture.inputRoot, 'github-output.txt');
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/validation-evidence.mjs'),
      'select',
      '--repo-root',
      fixture.repoRoot,
      '--repository',
      repository,
      '--workflow-path',
      workflowPath,
      '--branch',
      'feature',
      '--head',
      candidateHead,
      '--current-run-id',
      '5000',
      '--runs-envelope',
      path.join(fixture.inputRoot, 'runs.json'),
      '--artifact-root',
      path.join(fixture.inputRoot, 'artifacts'),
      '--jobs-root',
      path.join(fixture.inputRoot, 'jobs'),
      '--now',
      now,
      '--output',
      outputPath,
    ],
    { encoding: 'utf8' },
  );
  return { result, outputs: readOutputs(outputPath) };
}

function readOutputs(outputPath: string): Record<string, string> {
  if (!existsSync(outputPath)) {
    return {};
  }
  return Object.fromEntries(
    readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2)),
  );
}

function mergeRecord(base: Record<string, any>, mutation: Record<string, any> | undefined) {
  if (mutation === undefined) {
    return base;
  }
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      mutation[key] !== undefined && isRecord(value) && isRecord(mutation[key])
        ? mergeRecord(value, mutation[key])
        : (mutation[key] ?? value),
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commit(root: string, message: string, files: Record<string, string>): string {
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source, 'utf8');
  }
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', message]);
  return runGit(root, ['rev-parse', 'HEAD']).trim();
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function createUnrelatedCommit(root: string, sourceCommit: string): string {
  const tree = runGit(root, ['rev-parse', `${sourceCommit}^{tree}`]).trim();
  return runGit(root, ['commit-tree', tree, '-m', 'unrelated candidate']).trim();
}
