import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const entryPath = path.join(process.cwd(), 'scripts/repo-structure-check.mjs');
const fixtureRoots: string[] = [];

export function cleanupRepositoryFixtures(): void {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

export function createRepositoryFixture(baseFiles: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-structure-check-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--quiet', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Repository Structure Test']);
  runGit(root, ['config', 'user.email', 'repo-structure@example.test']);
  runGit(root, ['remote', 'add', 'origin', 'https://github.com/example/repository.git']);
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
  const base = runGit(root, ['rev-parse', 'HEAD']).trim();
  writePlanRecord(root, createRecord());
  return { root, base };
}

export function fixtureScripts() {
  return {
    'test:example': 'vitest run packages/tests/repo/example',
  };
}

export function createRecord(): FixtureRecord {
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

export type FixtureRecord = Record<string, unknown> & {
  readonly capabilities: Array<Record<string, unknown>>;
  coldNavigationEvidence: unknown;
};

export function recordBlock(record: Record<string, unknown>): string {
  return `\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\``;
}

export function writePlanRecord(root: string, record: FixtureRecord): void {
  (record.facts as Record<string, unknown>).diffBase = runGit(root, [
    'rev-list',
    '--max-parents=0',
    'HEAD',
  ]).trim();
  writeFixture(root, 'plans/fixture-plan.md', `# Fixture plan\n\n${recordBlock(record)}\n`);
}

export function runChecker(
  fixture: { readonly root: string; readonly base: string },
  options:
    | boolean
    | {
        readonly environment?: Readonly<Record<string, string | undefined>>;
        readonly extraArgs?: readonly string[];
      } = true,
) {
  const includeBase = typeof options === 'boolean' ? options : true;
  const environment = typeof options === 'boolean' ? undefined : options.environment;
  const extraArgs = typeof options === 'boolean' ? [] : (options.extraArgs ?? []);
  const args = [...(includeBase ? ['--base', fixture.base] : []), ...extraArgs];
  return spawnSync(process.execPath, [entryPath, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

export function writeFixture(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

export function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
