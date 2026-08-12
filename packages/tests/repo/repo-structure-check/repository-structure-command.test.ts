import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const entryPath = path.join(repoRoot, 'scripts/repo-structure-check.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('repository structure command', () => {
  it('rejects a new authored-code subtree with one code descendant', () => {
    const fixture = createRepositoryFixture();
    writeFixture(fixture.root, 'apps/new-feature/only-module.ts', 'export const value = true;\n');

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/new-feature [topology.singleton-subtree]');
  });

  it('uses the active plan diff base when no base option is supplied', () => {
    const fixture = createRepositoryFixture();
    writeFixture(fixture.root, 'apps/new-feature/only-module.ts', 'export const value = true;\n');

    const result = runChecker(fixture, false);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/new-feature [topology.singleton-subtree]');
    expect(result.stderr).not.toContain('origin/main');
  });

  it('rejects a new one-child directory chain with multiple leaf modules', () => {
    const fixture = createRepositoryFixture();
    writeFixture(
      fixture.root,
      'apps/new-feature/internal/first.ts',
      'export const first = true;\n',
    );
    writeFixture(
      fixture.root,
      'apps/new-feature/internal/second.ts',
      'export const second = true;\n',
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'apps/new-feature -> apps/new-feature/internal [topology.redundant-chain]',
    );
  });

  it('activates existing singleton debt when its code changes materially', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts': 'export const value = true;\n',
    });
    writeFixture(
      fixture.root,
      'apps/legacy-feature/only-module.ts',
      'export const value = false;\n',
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/legacy-feature [topology.singleton-subtree]');
    expect(result.stdout).toContain('Materially changed');
  });

  it('does not block narrow work because an unrelated singleton already exists', () => {
    const fixture = createRepositoryFixture({
      'apps/unrelated-legacy/only-module.ts': 'export const legacy = true;\n',
    });
    writeFixture(fixture.root, 'apps/example/first.ts', 'export const first = false;\n');

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('does not activate existing singleton debt for formatting-only changes', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts': 'export const value=true;\n',
    });
    writeFixture(
      fixture.root,
      'apps/legacy-feature/only-module.ts',
      'export const value = true;\n',
    );

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('does not activate existing singleton debt for a comment-only spelling correction', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts':
        '// Return teh stable value.\nexport const value = true;\n',
    });
    writeFixture(
      fixture.root,
      'apps/legacy-feature/only-module.ts',
      '// Return the stable value.\nexport const value = true;\n',
    );

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('requires a disposition when material work activates existing density debt', () => {
    const denseFiles = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        `apps/dense-legacy/module-${index}.ts`,
        `export const value${index} = true;\n`,
      ]),
    );
    const fixture = createRepositoryFixture(denseFiles);
    writeFixture(fixture.root, 'apps/dense-legacy/module-0.ts', 'export const value0 = false;\n');

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'apps/dense-legacy [layout.directory-density] requires an explicit ' +
        'keep/split/move/consolidate disposition',
    );
  });

  it('does not activate existing singleton debt for a path-only subtree rename', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts': 'export const value = true;\n',
    });
    runGit(fixture.root, ['mv', 'apps/legacy-feature', 'apps/renamed-feature']);

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('activates renamed singleton debt when the moved code also changes', () => {
    const fixture = createRepositoryFixture({
      'apps/legacy-feature/only-module.ts': 'export const value = true;\n',
    });
    runGit(fixture.root, ['mv', 'apps/legacy-feature', 'apps/renamed-feature']);
    writeFixture(
      fixture.root,
      'apps/renamed-feature/only-module.ts',
      'export const value = false;\n',
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/renamed-feature [topology.singleton-subtree]');
  });

  it('accepts a new production singleton only with an explicit human-approved exception', () => {
    const fixture = createRepositoryFixture();
    writeFixture(
      fixture.root,
      'apps/approved-singleton/entry.ts',
      'export const approvedValue = true;\n',
    );
    writeFixture(
      fixture.root,
      'docs/repo-structure-exceptions.json',
      `${JSON.stringify(
        {
          version: 1,
          exceptions: [
            {
              ruleId: 'topology.singleton-subtree',
              target: 'apps/approved-singleton',
              owner: 'Repository maintainers',
              reviewOrRemovalCondition: 'Review when the public integration gains another module.',
              approval: {
                kind: 'human',
                approvedBy: 'Fixture Human',
                approvedAt: '2026-08-12',
                evidence: 'https://github.com/example/repository/pull/42#pullrequestreview-100',
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = runChecker(fixture);

    expect(result.status, result.stdout).toBe(0);
  });

  it('does not apply production singleton exceptions to test topology', () => {
    const fixture = createRepositoryFixture();
    writeFixture(fixture.root, 'packages/tests/repo/approved-test/only.test.ts', 'export {};\n');
    writeFixture(
      fixture.root,
      'docs/repo-structure-exceptions.json',
      `${JSON.stringify({
        version: 1,
        exceptions: [
          {
            ruleId: 'topology.singleton-subtree',
            target: 'packages/tests/repo/approved-test',
            owner: 'Repository maintainers',
            reviewOrRemovalCondition: 'Remove when a second test exists.',
            approval: {
              kind: 'human',
              approvedBy: 'Fixture Human',
              approvedAt: '2026-08-12',
              evidence: 'https://github.com/example/repository/pull/42#pullrequestreview-101',
            },
          },
        ],
      })}\n`,
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'packages/tests/repo/approved-test [topology.singleton-subtree]',
    );
  });
});

function createRepositoryFixture(baseFiles: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-structure-check-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--quiet', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Repository Structure Test']);
  runGit(root, ['config', 'user.email', 'repo-structure@example.test']);
  writeFixture(root, 'package.json', JSON.stringify({ scripts: fixtureScripts() }, null, 2));
  writeFixture(root, 'apps/example/first.ts', 'export const first = true;\n');
  writeFixture(root, 'apps/example/second.ts', 'export const second = true;\n');
  writeFixture(root, 'scripts/example.mjs', 'export function runExample() { return true; }\n');
  writeFixture(root, 'scripts/example/first.mjs', 'export const first = true;\n');
  writeFixture(root, 'scripts/example/second.mjs', 'export const second = true;\n');
  writeFixture(root, 'packages/tests/repo/example/first.test.ts', 'export {};\n');
  writeFixture(root, 'packages/tests/repo/example/second.test.ts', 'export {};\n');
  writeFixture(root, 'plans/fixture-plan.md', `# Fixture plan\n\n${recordBlock(createRecord())}\n`);
  writeFixture(root, 'plans/README.md', '# Active adaptive plans\n');
  for (const [file, content] of Object.entries(baseFiles)) {
    writeFixture(root, file, content);
  }
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'base']);
  return { root, base: runGit(root, ['rev-parse', 'HEAD']).trim() };
}

function fixtureScripts() {
  return {
    'test:example': 'vitest run packages/tests/repo/example',
  };
}

function createRecord(): Record<string, unknown> {
  return {
    version: 1,
    planId: 'fixture-plan',
    status: 'active',
    goal: 'Keep repository capabilities navigable.',
    acceptanceCriteria: ['Changed structure remains navigable.'],
    capabilities: [
      {
        owner: 'example capability',
        root: 'scripts/example',
        entry: 'scripts/example.mjs',
        testRoot: 'packages/tests/repo/example',
        focusedCommand: 'npm run test:example',
        navigationMap: null,
        controlFlowFamilies: ['scan', 'report'],
      },
    ],
    architecture: {
      currentHypothesis: 'The fixture starts navigable.',
      intendedHypothesis: 'The fixture remains navigable.',
      freshInitialReview: { status: 'complete', reviewer: 'human', verdict: 'pass' },
    },
    completedSlicesSinceCheckpoint: [],
    facts: {
      diffBase: 'HEAD',
      affectedCodeDigest: null,
      computedTriggers: [],
      undeclaredChangedPaths: [],
    },
    checkpoint: {
      outcome: 'The fixture baseline exists.',
      learning: 'The owner is explicit.',
      structure: 'One capability owns the fixture.',
      decision: 'continue',
      nextSlices: ['fixture-slice'],
    },
    structuralDispositions: [],
    structuralExceptions: [],
    freshStructuralReview: null,
    coldNavigationEvidence: null,
    materialDecisions: [],
  };
}

function recordBlock(record: Record<string, unknown>): string {
  return `\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\``;
}

function runChecker(fixture: { readonly root: string; readonly base: string }, includeBase = true) {
  const args = includeBase ? ['--base', fixture.base] : [];
  return spawnSync(process.execPath, [entryPath, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
