import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = process.cwd();
const entryPath = path.join(sourceRoot, 'scripts/plan-adaptation.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plan adaptation CLI lifecycle', () => {
  it('runs init, complete-slice, prepare, apply, check, and close through real files', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];

    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    expect(readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8')).toContain(
      '| fixture-plan | plan adaptation  | active | continue            | slice-one, slice-two |',
    );

    expect(runCli(fixture.root, ['complete-slice', ...common, '--slice', 'slice-one']).status).toBe(
      0,
    );
    expect(runCli(fixture.root, ['prepare', ...common]).status).toBe(0);

    const draftPath = path.join(fixture.root, '.plan-adaptation/fixture-plan.draft.json');
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    expect(draft.record.completedSlicesSinceCheckpoint).toEqual(['slice-one']);
    expect(draft.record.facts.affectedCodeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(draft.record.facts.undeclaredChangedPaths).toEqual([]);
    expect(draft.record.checkpoint).toEqual({
      outcome: '',
      learning: '',
      structure: '',
      decision: '',
      nextSlices: [],
    });
    draft.record.checkpoint = {
      outcome: 'The first slice now owns the canonical lifecycle.',
      learning: 'Content tuples keep review freshness independent of commit identity.',
      structure: 'The thin entry routes into one cohesive plan-adaptation owner.',
      decision: 'amend',
      nextSlices: ['slice-two'],
    };
    writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`);

    expect(runCli(fixture.root, ['apply', ...common]).status).toBe(0);
    expect(existsSync(draftPath)).toBe(false);
    const appliedPlan = readFileSync(path.join(fixture.root, fixture.planPath), 'utf8');
    expect(appliedPlan).toContain('"decision": "amend"');
    expect(appliedPlan).toContain('"completedSlicesSinceCheckpoint": []');

    const beforeCheck = snapshotTrackedFiles(fixture.root);
    expect(runCli(fixture.root, ['check', ...common]).status).toBe(0);
    expect(snapshotTrackedFiles(fixture.root)).toEqual(beforeCheck);

    const evidencePath = path.join(fixture.root, 'final-pr-evidence.json');
    const record = parseRecord(appliedPlan);
    writeFileSync(
      evidencePath,
      JSON.stringify({
        version: 1,
        planId: 'fixture-plan',
        pullRequestUrl: 'https://github.com/example/repository/pull/1',
        finalReview: { status: 'complete', planDigest: recordDigest(record) },
      }),
    );
    expect(
      runCli(fixture.root, ['close', ...common, '--final-pr-evidence', evidencePath]).status,
    ).toBe(0);
    expect(existsSync(path.join(fixture.root, fixture.planPath))).toBe(false);
    expect(readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8')).not.toContain(
      'fixture-plan',
    );
  });

  it('keeps prepare drafts ignored and rejects stale facts or incomplete judgments on apply', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);
    expect(runCli(fixture.root, ['prepare', ...common]).status).toBe(0);
    expect(
      runGit(fixture.root, ['check-ignore', '.plan-adaptation/fixture-plan.draft.json']),
    ).toContain('.plan-adaptation/fixture-plan.draft.json');

    const draftPath = path.join(fixture.root, '.plan-adaptation/fixture-plan.draft.json');
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    writeFileSync(draftPath, JSON.stringify(draft));
    expect(runCli(fixture.root, ['apply', ...common]).stdout).toContain(
      'checkpoint.learning must be a non-empty judgment',
    );

    draft.record.checkpoint = {
      outcome: 'A complete outcome judgment.',
      learning: 'A complete learning judgment.',
      structure: 'A complete structure judgment.',
      decision: 'continue',
      nextSlices: ['slice-one'],
    };
    writeFileSync(draftPath, JSON.stringify(draft));
    writeFixture(
      fixture.root,
      'scripts/plan-adaptation/new-owner.mjs',
      'export const owner = true;\n',
    );
    expect(runCli(fixture.root, ['apply', ...common]).stdout).toContain(
      'draft facts are stale; run prepare again',
    );
  });

  it('requires matching final pull-request evidence before destructive close-out', () => {
    const fixture = createLifecycleRepository();
    const result = runCli(fixture.root, [
      'close',
      '--plan',
      fixture.planPath,
      '--base',
      fixture.base,
      '--final-pr-evidence',
      'missing.json',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('final pull-request evidence');
    expect(existsSync(path.join(fixture.root, fixture.planPath))).toBe(true);
  });

  it('runs the package check entry from the single active record and configured base', () => {
    const fixture = createLifecycleRepository();
    const common = ['--plan', fixture.planPath, '--base', fixture.base];
    expect(runCli(fixture.root, ['init', ...common]).status).toBe(0);

    const result = runCli(fixture.root, ['check']);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: plan adaptation check');
  });
});

function createLifecycleRepository() {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-adaptation-lifecycle-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--quiet', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Plan Adaptation Test']);
  runGit(root, ['config', 'user.email', 'plan-adaptation@example.test']);
  writeFixture(root, '.gitignore', '/.plan-adaptation/\n');
  writeFixture(root, 'scripts/plan-adaptation.mjs', 'console.log("fixture entry");\n');
  writeFixture(root, 'packages/tests/repo/plan-adaptation/fixture.test.ts', 'export {};\n');
  writeFixture(root, 'plans/fixture-plan.md', `# Fixture plan\n\n${recordBlock(createRecord())}\n`);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'base']);
  const base = runGit(root, ['rev-parse', 'HEAD']).trim();
  writeFixture(root, 'scripts/plan-adaptation/change.mjs', 'export const changed = true;\n');
  runGit(root, ['add', '.']);
  return { root, base, planPath: 'plans/fixture-plan.md' };
}

function runCli(root: string, args: readonly string[], environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [entryPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function snapshotTrackedFiles(root: string): Record<string, string> {
  const paths = runGit(root, ['ls-files']).trim().split('\n').filter(Boolean);
  return Object.fromEntries(
    paths.map((file) => [file, readFileSync(path.join(root, file), 'utf8')]),
  );
}

function parseRecord(markdown: string): any {
  const match = markdown.match(/```plan-adaptation-v1\n([\s\S]*?)\n```/u);
  if (!match) {
    throw new Error('fixture record missing');
  }
  return JSON.parse(match[1]);
}

function recordDigest(record: unknown): string {
  return execFileSync(
    process.execPath,
    [
      '-e',
      "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(process.argv[1]).digest('hex'))",
      JSON.stringify(record),
    ],
    { encoding: 'utf8' },
  );
}

function createRecord(): any {
  return {
    version: 1,
    planId: 'fixture-plan',
    status: 'active',
    goal: 'Prove the adaptive plan lifecycle.',
    acceptanceCriteria: ['All lifecycle commands preserve one canonical record.'],
    capabilities: [
      {
        owner: 'plan adaptation',
        root: 'scripts/plan-adaptation',
        entry: 'scripts/plan-adaptation.mjs',
        testRoot: 'packages/tests/repo/plan-adaptation',
        focusedCommand: 'npm run test:plan-adaptation',
        navigationMap: null,
      },
    ],
    architecture: {
      currentHypothesis: 'There is no adaptive owner.',
      intendedHypothesis: 'One lifecycle owns adaptive records.',
      freshInitialReview: { status: 'complete', reviewer: 'fixture', verdict: 'pass' },
    },
    completedSlicesSinceCheckpoint: [],
    facts: {
      affectedCodeDigest: null,
      computedTriggers: ['written-plan'],
      undeclaredChangedPaths: [],
    },
    checkpoint: {
      outcome: 'The fixture plan is active.',
      learning: 'The initial review fixed the owner.',
      structure: 'One capability owns the lifecycle.',
      decision: 'continue',
      nextSlices: ['slice-one', 'slice-two'],
    },
    structuralDispositions: [],
    freshStructuralReview: null,
    coldNavigationEvidence: null,
    materialDecisions: [],
  };
}

function recordBlock(record: ReturnType<typeof createRecord>): string {
  return `\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\``;
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
