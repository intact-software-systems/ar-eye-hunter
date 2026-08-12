import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeBuildAffectingTreeDigest } from '../../../../scripts/pr-human-review/review-freshness.mjs';

const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('validation evidence command', () => {
  it('writes successful v1 evidence from the trusted current workflow run', () => {
    const fixtureRoot = createGitFixture();
    const head = runGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();
    const runEnvelopePath = path.join(fixtureRoot, 'run.json');
    const jobsEnvelopePath = path.join(fixtureRoot, 'jobs.json');
    const outputPath = path.join(fixtureRoot, 'validation-evidence-v1.json');
    writeFileSync(
      runEnvelopePath,
      `${JSON.stringify({
        id: 4123,
        run_attempt: 2,
        head_sha: head,
        workflow_id: 987,
        path: '.github/workflows/branch-release-gate.yml',
        event: 'push',
        status: 'in_progress',
        conclusion: null,
        created_at: '2026-08-13T09:00:00.000Z',
        updated_at: '2026-08-13T09:10:00.000Z',
        repository: { full_name: 'intact-software-systems/ar-eye-hunter' },
      })}\n`,
      'utf8',
    );
    writeFileSync(
      jobsEnvelopePath,
      `${JSON.stringify({
        total_count: 1,
        jobs: [
          {
            id: 7123,
            run_id: 4123,
            head_sha: head,
            name: 'Release Gate / Release Gate',
            status: 'completed',
            conclusion: 'success',
            completed_at: '2026-08-13T09:08:00Z',
          },
        ],
      })}\n`,
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/validation-evidence.mjs'),
        'create',
        '--repo-root',
        fixtureRoot,
        '--run-envelope',
        runEnvelopePath,
        '--jobs-envelope',
        jobsEnvelopePath,
        '--release-gate-result',
        'success',
        '--output',
        outputPath,
      ],
      { encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
      schemaVersion: 'validation-evidence-v1',
      repository: 'intact-software-systems/ar-eye-hunter',
      workflow: {
        id: 987,
        path: '.github/workflows/branch-release-gate.yml',
        runId: 4123,
        runAttempt: 2,
      },
      head,
      buildTreeDigest: computeBuildAffectingTreeDigest({
        repoRoot: fixtureRoot,
        headSha: head,
      }),
      releaseGate: {
        jobId: 7123,
        name: 'Release Gate / Release Gate',
        conclusion: 'success',
        completedAt: '2026-08-13T09:08:00.000Z',
      },
    });
  });

  it.each([
    ['reused evidence', 'success', 'success', 'true', 'skipped', 'skipped', 0],
    ['fresh broad evidence', 'success', 'success', 'false', 'success', 'success', 0],
    ['failed publication', 'success', 'success', 'false', 'success', 'failure', 1],
  ])(
    'reports one unambiguous branch result for %s',
    (_label, governance, selection, reuse, release, publication, expectedStatus) => {
      const result = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts/validation-evidence.mjs'),
          'conclude',
          '--governance-result',
          governance,
          '--selection-result',
          selection,
          '--reuse',
          reuse,
          '--release-result',
          release,
          '--publication-result',
          publication,
        ],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(expectedStatus);
    },
  );

  it.each([
    'no-prior-successful-run',
    'untrusted-workflow-run',
    'malformed-validation-evidence',
    'untrusted-release-gate-job',
    'expired-validation-evidence',
    'validation-evidence-head-is-not-ancestor',
    'build-tree-digest-mismatch',
  ])('requires broad validation after the selector succeeds with reuse=false: %s', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/validation-evidence.mjs'),
        'conclude',
        '--governance-result',
        'success',
        '--selection-result',
        'success',
        '--reuse',
        'false',
        '--release-result',
        'success',
        '--publication-result',
        'success',
      ],
      { encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('queries GitHub runs and downloads artifacts through the trusted gh boundary', () => {
    const fixtureRoot = createGitFixture();
    const head = runGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();
    const buildTreeDigest = computeBuildAffectingTreeDigest({
      repoRoot: fixtureRoot,
      headSha: head,
    });
    const externalRoot = mkdtempSync(path.join(tmpdir(), 'validation-evidence-gh-'));
    fixtureRoots.push(externalRoot);
    const runsPath = path.join(externalRoot, 'runs.json');
    const artifactPath = path.join(externalRoot, 'validation-evidence-v1.json');
    const jobsPath = path.join(externalRoot, 'jobs.json');
    const commandLogPath = path.join(externalRoot, 'commands.log');
    const outputPath = path.join(externalRoot, 'github-output.txt');
    writeFileSync(
      runsPath,
      `${JSON.stringify({
        total_count: 1,
        workflow_runs: [
          {
            id: 4123,
            run_attempt: 1,
            head_sha: head,
            head_branch: 'main',
            workflow_id: 987,
            path: '.github/workflows/branch-release-gate.yml',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-08-13T09:00:00.000Z',
            updated_at: '2026-08-13T09:10:00.000Z',
            repository: { full_name: 'intact-software-systems/ar-eye-hunter' },
          },
        ],
      })}\n`,
      'utf8',
    );
    writeFileSync(
      artifactPath,
      `${JSON.stringify({
        schemaVersion: 'validation-evidence-v1',
        repository: 'intact-software-systems/ar-eye-hunter',
        workflow: {
          id: 987,
          path: '.github/workflows/branch-release-gate.yml',
          runId: 4123,
          runAttempt: 1,
        },
        head,
        buildTreeDigest,
        releaseGate: {
          jobId: 7123,
          name: 'Release Gate / Release Gate',
          conclusion: 'success',
          completedAt: '2026-08-13T09:08:00.000Z',
        },
      })}\n`,
      'utf8',
    );
    writeFileSync(
      jobsPath,
      `${JSON.stringify({
        total_count: 1,
        jobs: [
          {
            id: 7123,
            run_id: 4123,
            head_sha: head,
            name: 'Release Gate / Release Gate',
            status: 'completed',
            conclusion: 'success',
            completed_at: '2026-08-13T09:08:00Z',
          },
        ],
      })}\n`,
      'utf8',
    );
    const fakeBin = path.join(externalRoot, 'bin');
    mkdirSync(fakeBin);
    const fakeGhPath = path.join(fakeBin, 'gh');
    writeFileSync(fakeGhPath, fakeGhSource(), 'utf8');
    chmodSync(fakeGhPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/validation-evidence.mjs'),
        'select',
        '--repo-root',
        fixtureRoot,
        '--repository',
        'intact-software-systems/ar-eye-hunter',
        '--workflow-path',
        '.github/workflows/branch-release-gate.yml',
        '--branch',
        'main',
        '--head',
        head,
        '--current-run-id',
        '5000',
        '--now',
        '2026-08-13T10:00:00.000Z',
        '--output',
        outputPath,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          FAKE_GH_RUNS: runsPath,
          FAKE_GH_JOBS: jobsPath,
          FAKE_GH_ARTIFACT: artifactPath,
          FAKE_GH_LOG: commandLogPath,
        },
      },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toContain('reuse=true\n');
    expect(readFileSync(commandLogPath, 'utf8')).toContain(
      'api --paginate --slurp /repos/intact-software-systems/ar-eye-hunter/actions/workflows/branch-release-gate.yml/runs?branch=main&event=push&status=success&per_page=100',
    );
    expect(readFileSync(commandLogPath, 'utf8')).toContain(
      'run download 4123 --repo intact-software-systems/ar-eye-hunter --name validation-evidence-v1',
    );
    expect(readFileSync(commandLogPath, 'utf8')).toContain(
      'api --paginate --slurp /repos/intact-software-systems/ar-eye-hunter/actions/runs/4123/jobs?filter=latest&per_page=100',
    );
  });
});

function createGitFixture(): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'validation-evidence-cli-'));
  fixtureRoots.push(fixtureRoot);
  runGit(fixtureRoot, ['init', '--initial-branch=main']);
  runGit(fixtureRoot, ['config', 'user.name', 'Validation Evidence Test']);
  runGit(fixtureRoot, ['config', 'user.email', 'validation-evidence@example.invalid']);
  writeFileSync(path.join(fixtureRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  runGit(fixtureRoot, ['add', '.']);
  runGit(fixtureRoot, ['commit', '-m', 'fixture']);
  return fixtureRoot;
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function fakeGhSource(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\\n');
if (args[0] === 'api') {
  const source = args.at(-1).includes('/jobs?') ? process.env.FAKE_GH_JOBS : process.env.FAKE_GH_RUNS;
  process.stdout.write(fs.readFileSync(source, 'utf8'));
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'download') {
  const outputDirectory = args[args.indexOf('--dir') + 1];
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.copyFileSync(
    process.env.FAKE_GH_ARTIFACT,
    path.join(outputDirectory, 'validation-evidence-v1.json'),
  );
  process.exit(0);
}
process.exit(2);
`;
}
