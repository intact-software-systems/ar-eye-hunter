import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  computeBuildAffectingTreeDigest,
  readCurrentPlanContext,
} from '../../../../scripts/pr-human-review/review-freshness.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('review freshness', () => {
  it.each([
    ['repository documentation', 'docs/guide.md'],
    ['application documentation', 'apps/example/README.md'],
    ['package documentation', 'packages/example/docs/architecture.md'],
  ])('keeps the build-affecting tree digest stable for unrelated %s', (_name, changedPath) => {
    const fixture = createGitFixture();
    const before = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });
    commit(fixture, 'docs only', { [changedPath]: 'clarified prose\n' });

    const after = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });

    expect(after).toBe(before);
  });

  it.each([
    ['production code', 'apps/example/main.ts'],
    ['tests', 'packages/tests/example/main.test.ts'],
    ['workflows', '.github/workflows/ci.yml'],
    ['custom actions', '.github/actions/api-v1-black-box-test/action.yml'],
    ['package metadata', 'package.json'],
    ['lockfiles', 'package-lock.json'],
    ['TypeScript configuration', 'tsconfig.json'],
    ['Vitest configuration', 'vitest.config.ts'],
    ['Deno configuration', 'deno.json'],
    ['Docker Compose configuration', 'docker-compose.yml'],
    ['root build scripts', 'no-js-files-outside-dist.sh'],
    ['plan contracts', 'plans/example-plan.md'],
    ['review contracts', 'docs/pr-human-review-record.md'],
    ['review guidance contracts', 'docs/repo-human-style-guide.md'],
    ['test exception registries', 'docs/test-structure-coupling-exceptions.md'],
    ['capability navigation maps', 'scripts/example-capability/README.md'],
    ['test-consumed app documentation', 'apps/api-v1/README.md'],
    ['test-consumed API reference', 'docs/rallar-api-reference.md'],
    ['agent contracts', 'CLAUDE.md'],
  ])('invalidates the digest for changed %s', (_name, changedPath) => {
    const fixture = createGitFixture();
    const before = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });
    commit(fixture, `change ${changedPath}`, { [changedPath]: `changed ${changedPath}\n` });

    const after = computeBuildAffectingTreeDigest({ repoRoot: fixture, headSha: 'HEAD' });

    expect(after).not.toBe(before);
  });

  it('derives the current goal, decision, digest, and active owner entries from one plan record', () => {
    const planRecord = {
      version: 1,
      goal: 'Keep agent work reviewable.',
      acceptanceCriteria: ['Humans can recover ownership from repository truth.'],
      capabilities: [
        {
          owner: 'PR human review',
          entry: 'scripts/pr-human-review.mjs',
        },
        {
          owner: 'future owner',
          entry: 'scripts/future.mjs',
          activation: { state: 'planned', slice: 'future-slice' },
        },
        {
          kind: 'guidance',
          guidanceRole: 'router',
          owner: 'general agent guidance',
          routingEntry: 'AGENTS.md',
        },
      ],
      checkpoint: {
        structure: 'Keep review and governance-gate ownership separate.',
        nextSlices: ['future-slice'],
      },
    };
    const planSource = [
      '# Plan',
      '```plan-adaptation-v1',
      JSON.stringify(planRecord, null, 2),
      '```',
    ].join('\n');

    const currentPlan = readCurrentPlanContext({
      path: 'plans/example-plan.md',
      source: planSource,
    });

    expect(currentPlan).toMatchObject({
      path: 'plans/example-plan.md',
      goal: planRecord.goal,
      acceptanceCriteria: planRecord.acceptanceCriteria,
      structuralDecision: planRecord.checkpoint.structure,
      ownerEntries: [
        { owner: 'PR human review', entry: 'scripts/pr-human-review.mjs' },
        { owner: 'general agent guidance', entry: 'AGENTS.md' },
      ],
      initialOwnerEntries: [
        { owner: 'PR human review', entry: 'scripts/pr-human-review.mjs' },
        { owner: 'future owner', entry: 'scripts/future.mjs' },
        { owner: 'general agent guidance', entry: 'AGENTS.md' },
      ],
    });
    expect(currentPlan.digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

function createGitFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pr-review-freshness-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Review Freshness Test']);
  runGit(root, ['config', 'user.email', 'review-freshness@example.invalid']);
  commit(root, 'base', {
    'apps/example/main.ts': 'export const value = 1;\n',
    'packages/tests/example/main.test.ts': 'export {};\n',
    '.github/workflows/ci.yml': 'name: CI\n',
    'package.json': '{"name":"fixture"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'plans/example-plan.md': '# Plan\n',
    'docs/pr-human-review-record.md': '# Review contract\n',
    'docs/guide.md': 'original prose\n',
  });
  return root;
}

function commit(root: string, message: string, files: Readonly<Record<string, string>>): void {
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
  }
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', message]);
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
