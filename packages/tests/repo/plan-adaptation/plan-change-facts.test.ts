import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  computeAffectedCodeDigest,
  computeCheckpointTriggers,
  computeQualificationReasons,
  computeUndeclaredChangedPaths,
  readChangedPaths,
} from '../../../../scripts/plan-adaptation/plan-change-facts.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('canonical content facts', () => {
  it('sorts canonical tuples by repository path bytes', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'scripts/Z.mjs', 'export const upper = true;\n');
    writeFixture(fixture.root, 'scripts/a.mjs', 'export const lower = true;\n');
    runGit(fixture.root, ['add', '.']);

    expect(
      computeAffectedCodeDigest(
        fixture.root,
        fixture.base,
        readChangedPaths(fixture.root, fixture.base),
      ),
    ).toBe('c0b3655922b79cf563699a94aadb3772a7ac1e20c18d01d54f83100d13fee7a4');
  });

  it('uses sorted path, Git mode, and content tuples without depending on commit SHA', () => {
    const first = createRepository();
    writeFixture(first.root, 'packages/example/src/a.ts', 'export const value = 2;\n');
    writeFixture(first.root, 'scripts/tool.mjs', '#!/usr/bin/env node\nconsole.log("same");\n');
    chmodSync(path.join(first.root, 'scripts/tool.mjs'), 0o755);
    runGit(first.root, ['add', '.']);

    const digest = computeAffectedCodeDigest(
      first.root,
      first.base,
      readChangedPaths(first.root, first.base),
    );
    runGit(first.root, ['commit', '--quiet', '-m', 'same tree at another SHA']);
    const secondBase = runGit(first.root, ['rev-parse', 'HEAD']).trim();
    runGit(first.root, ['commit', '--quiet', '--allow-empty', '-m', 'different SHA']);

    expect(
      computeAffectedCodeDigest(first.root, first.base, readChangedPaths(first.root, first.base)),
    ).toBe(digest);
    expect(secondBase).not.toBe(runGit(first.root, ['rev-parse', 'HEAD']).trim());

    chmodSync(path.join(first.root, 'scripts/tool.mjs'), 0o644);
    expect(
      computeAffectedCodeDigest(first.root, first.base, readChangedPaths(first.root, first.base)),
    ).not.toBe(digest);
  });

  it('uses Git-reported modes instead of filesystem executable bits', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'scripts/tool.mjs', 'export const tool = true;\n');
    chmodSync(path.join(fixture.root, 'scripts/tool.mjs'), 0o755);
    runGit(fixture.root, ['add', '.']);
    const executableDigest = computeAffectedCodeDigest(
      fixture.root,
      fixture.base,
      readChangedPaths(fixture.root, fixture.base),
    );

    runGit(fixture.root, ['config', 'core.fileMode', 'false']);
    chmodSync(path.join(fixture.root, 'scripts/tool.mjs'), 0o644);

    expect(
      computeAffectedCodeDigest(
        fixture.root,
        fixture.base,
        readChangedPaths(fixture.root, fixture.base),
      ),
    ).toBe(executableDigest);
  });

  it('keeps an old-path deletion tuple when production code is renamed outside code', () => {
    const fixture = createRepository();
    mkdirSync(path.join(fixture.root, 'notes'), { recursive: true });
    runGit(fixture.root, ['mv', 'packages/example/src/a.ts', 'notes/a.txt']);

    expect(
      computeAffectedCodeDigest(
        fixture.root,
        fixture.base,
        readChangedPaths(fixture.root, fixture.base),
      ),
    ).toBe('cf952557964e8fe54de27ab2551e23ede7b32f9271259dd786c5ba29b1611304');
  });
});

describe('qualification and checkpoint facts', () => {
  it('discovers untracked files and reports both paths of an undeclared rename', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'packages/untracked/src/new.ts', 'export const fresh = true;\n');
    mkdirSync(path.join(fixture.root, 'packages/outside/src'), { recursive: true });
    runGit(fixture.root, ['mv', 'packages/example/src/a.ts', 'packages/outside/src/renamed.ts']);
    const changes = readChangedPaths(fixture.root, fixture.base);
    const record = {
      capabilities: [
        {
          root: 'scripts/plan-adaptation',
          entry: 'scripts/plan-adaptation.mjs',
          testRoot: 'packages/tests/repo/plan-adaptation',
        },
      ],
    };

    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'A', path: 'packages/untracked/src/new.ts' }),
      ]),
    );
    expect(computeUndeclaredChangedPaths(changes, record)).toEqual(
      expect.arrayContaining([
        'packages/example/src/a.ts',
        'packages/outside/src/renamed.ts',
        'packages/untracked/src/new.ts',
      ]),
    );
  });
  it('qualifies every required diff shape against the actual Git diff', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'plans/new-plan.md', '# Written plan\n');
    writeFixture(fixture.root, 'packages/new-capability/src/one.ts', 'export const one = 1;\n');
    writeFixture(fixture.root, 'packages/new-capability/src/two.ts', 'export const two = 2;\n');
    writeFixture(fixture.root, 'packages/new-capability/src/three.ts', 'export const three = 3;\n');
    writeFixture(fixture.root, 'apps/example/src/public-api.ts', 'export const api = 1;\n');
    mkdirSync(path.join(fixture.root, 'scripts/moved-owner'), { recursive: true });
    runGit(fixture.root, ['mv', 'packages/example/src/a.ts', 'scripts/moved-owner/a.ts']);
    runGit(fixture.root, ['add', '.']);

    const changes = readChangedPaths(fixture.root, fixture.base);
    const reasons = computeQualificationReasons(fixture.root, fixture.base, changes);

    expect(reasons).toEqual(
      expect.arrayContaining([
        'written-plan',
        'directory-creation-or-movement',
        'three-production-modules',
        'package-or-capability-crossing',
        'public-ownership-change',
      ]),
    );
  });

  it('reports undeclared paths and mechanical triggers from the actual diff', () => {
    const fixture = createRepository();
    writeFixture(
      fixture.root,
      'scripts/plan-adaptation/new-lifecycle.mjs',
      'export const startLifecycle = () => true;\n',
    );
    writeFixture(fixture.root, 'packages/outside/src/public-api.ts', 'export const api = 1;\n');
    runGit(fixture.root, ['add', '.']);
    const changes = readChangedPaths(fixture.root, fixture.base);
    const record = {
      completedSlicesSinceCheckpoint: ['slice-one', 'slice-two'],
      capabilities: [
        {
          root: 'scripts/plan-adaptation',
          entry: 'scripts/plan-adaptation.mjs',
          testRoot: 'packages/tests/repo/plan-adaptation',
        },
      ],
      coldNavigationEvidence: { status: 'failed' },
      architecture: { invalidatedAssumptions: ['The planned owner is no longer valid.'] },
    };

    expect(computeUndeclaredChangedPaths(changes, record, 'plans/fixture.md')).toContain(
      'packages/outside/src/public-api.ts',
    );
    expect(
      computeCheckpointTriggers({
        repoRoot: fixture.root,
        base: fixture.base,
        changes,
        record,
      }),
    ).toEqual(
      expect.arrayContaining([
        'folder-change',
        'ownership-change',
        'public-contract-change',
        'lifecycle-change',
        'navigation-degradation',
        'invalid-assumption',
        'scope-growth',
        'two-completed-slices',
      ]),
    );
  });
});

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-adaptation-facts-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--quiet', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Plan Adaptation Test']);
  runGit(root, ['config', 'user.email', 'plan-adaptation@example.test']);
  writeFixture(root, 'packages/example/src/a.ts', 'export const value = 1;\n');
  writeFixture(root, 'scripts/plan-adaptation.mjs', 'console.log("fixture");\n');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'base']);
  return { root, base: runGit(root, ['rev-parse', 'HEAD']).trim() };
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
