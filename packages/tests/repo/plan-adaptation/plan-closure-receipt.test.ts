import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeAdaptivePlanRecordDigest } from '../../../../scripts/plan-adaptation/adaptive-plan-record.mjs';
import { readChangedPaths } from '../../../../scripts/plan-adaptation/plan-change-facts.mjs';
import { readAuthenticatedPlanClosureChanges } from '../../../../scripts/plan-adaptation/plan-closure-receipt.mjs';

const sourceRoot = process.cwd();
const entryPath = path.join(sourceRoot, 'scripts/plan-adaptation.mjs');
const fixturePaths: string[] = [];

afterEach(() => {
  for (const fixturePath of fixturePaths.splice(0)) {
    rmSync(fixturePath, { recursive: true, force: true });
  }
});

describe('plan closure receipt', () => {
  it.each(['merge', 'squash', 'rebase'] as const)(
    'keeps the same reviewed plan tree valid after a %s merge',
    (mergeMode) => {
      const fixture = createMergedClosureRepository(mergeMode);
      const record = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
      writeFinalReviewEvidence(fixture.root, record);

      const close = runCli(fixture.root, [
        'close',
        '--plan',
        fixture.planPath,
        '--base',
        fixture.closeBase,
        '--final-pr-evidence',
        'final-pr-evidence.json',
      ]);

      expect(close.status, close.stdout).toBe(0);
      expect(runCli(fixture.root, ['check', '--base', fixture.closeBase]).status).toBe(0);
    },
  );

  it('closes one plan while preserving every other plan and static navigation', () => {
    const fixture = createClosureRepository({ includeSecondActivePlan: true });
    const record = parseRecord(readFileSync(path.join(fixture.root, fixture.planPath), 'utf8'));
    writeFinalReviewEvidence(fixture.root, record);

    const close = runCli(fixture.root, [
      'close',
      '--plan',
      fixture.planPath,
      '--base',
      fixture.closeBase,
      '--final-pr-evidence',
      'final-pr-evidence.json',
    ]);

    expect(close.status, close.stdout).toBe(0);
    expect(readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8')).toBe(
      '# Adaptive plans\n\nStatic navigation.\n',
    );
    expect(readFileSync(path.join(fixture.root, 'plans/aaa-plan.md'), 'utf8')).toContain(
      '"planId": "zzz-plan"',
    );
  });

  it('rejects an inactive deleted base plan even when its receipt matches', () => {
    const fixture = createInactiveClosureTransition();

    const result = readAuthenticatedPlanClosureChanges({
      repoRoot: fixture.root,
      base: fixture.base,
      changes: readChangedPaths(fixture.root, fixture.base),
    });

    expect(result.issues).toContainEqual(
      expect.stringContaining('comparison base plan must be active or postponed'),
    );
  });

  it('authenticates only an exact, complete close-out transition', () => {
    const fixture = createClosureRepository();
    const planPath = path.join(fixture.root, fixture.planPath);
    const baseMarkdown = readFileSync(planPath, 'utf8');
    const baseRecord = parseRecord(baseMarkdown);
    const baseRegistry = readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8');
    const receiptPath = path.join(fixture.root, 'plans/fixture-plan.closure.json');

    writeFinalReviewEvidence(fixture.root, baseRecord);
    symlinkSync(`${fixture.root}-missing-receipt-target`, receiptPath);
    const occupiedReceiptClose = runCli(fixture.root, [
      'close',
      '--plan',
      fixture.planPath,
      '--base',
      fixture.closeBase,
      '--final-pr-evidence',
      'final-pr-evidence.json',
    ]);
    expect(occupiedReceiptClose.status).toBe(1);
    expect(occupiedReceiptClose.stdout).toContain('close receipt already exists');
    expect(lstatSync(receiptPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(planPath, 'utf8')).toBe(baseMarkdown);
    expect(readFileSync(path.join(fixture.root, 'plans/README.md'), 'utf8')).toBe(baseRegistry);
    rmSync(receiptPath);

    const changedRecord = structuredClone(baseRecord);
    changedRecord.checkpoint.outcome = 'An uncommitted plan record must not be closable.';
    writeFixture(
      fixture.root,
      fixture.planPath,
      `# Fixture plan\n\n${recordBlock(changedRecord)}\n`,
    );
    writeFinalReviewEvidence(fixture.root, changedRecord);
    const changedPlanClose = runCli(fixture.root, [
      'close',
      '--plan',
      fixture.planPath,
      '--base',
      fixture.closeBase,
      '--final-pr-evidence',
      'final-pr-evidence.json',
    ]);
    expect(changedPlanClose.status).toBe(1);
    expect(changedPlanClose.stdout).toContain('comparison base to contain the exact eligible plan');

    writeFileSync(planPath, baseMarkdown);
    writeFinalReviewEvidence(fixture.root, baseRecord);
    const close = runCli(fixture.root, [
      'close',
      '--plan',
      fixture.planPath,
      '--base',
      fixture.closeBase,
      '--final-pr-evidence',
      'final-pr-evidence.json',
    ]);
    expect(close.status, close.stdout).toBe(0);

    const validReceipt = readFileSync(receiptPath, 'utf8');
    const authenticatedCloseout = readAuthenticatedPlanClosureChanges({
      repoRoot: fixture.root,
      base: fixture.closeBase,
      changes: readChangedPaths(fixture.root, fixture.closeBase),
    });
    expect(authenticatedCloseout.authenticatedPlans).toEqual([
      { planPath: fixture.planPath, record: baseRecord },
    ]);
    const misplacedPath = path.join(fixture.root, 'plans/misplaced.closure.json');
    const outsideReceipt = `${fixture.root}-outside-closure.json`;
    fixturePaths.push(outsideReceipt);
    const cases: Array<{
      readonly name: string;
      readonly mutate: () => void;
      readonly message: string;
    }> = [
      {
        name: 'missing',
        mutate: () => rmSync(receiptPath),
        message: 'expected a new plans/fixture-plan.closure.json receipt',
      },
      {
        name: 'malformed',
        mutate: () => writeFileSync(receiptPath, '{broken'),
        message: 'is invalid JSON',
      },
      {
        name: 'noncanonical bytes',
        mutate: () => writeFileSync(receiptPath, JSON.stringify(JSON.parse(validReceipt))),
        message: 'must use canonical closure v1 serialization',
      },
      {
        name: 'misplaced',
        mutate: () => renameSync(receiptPath, misplacedPath),
        message: 'expected a new plans/fixture-plan.closure.json receipt',
      },
      {
        name: 'symlinked',
        mutate: () => {
          writeFileSync(outsideReceipt, validReceipt);
          rmSync(receiptPath);
          symlinkSync(outsideReceipt, receiptPath);
        },
        message: 'must be a regular non-symbolic-link file',
      },
      {
        name: 'stale digest',
        mutate: () => mutateReceipt(receiptPath, { planDigest: '0'.repeat(64) }),
        message: 'does not match the deleted base plan',
      },
      {
        name: 'mismatched plan',
        mutate: () => mutateReceipt(receiptPath, { planId: 'different-plan' }),
        message: 'does not match the deleted base plan',
      },
      {
        name: 'incomplete final review',
        mutate: () => mutateReceipt(receiptPath, { finalReviewStatus: 'changes-requested' }),
        message: 'must record a completed final review',
      },
      {
        name: 'invalid pull request',
        mutate: () => mutateReceipt(receiptPath, { pullRequestUrl: 'https://example.test/pull/1' }),
        message: 'must identify a GitHub pull request',
      },
    ];

    for (const receiptCase of cases) {
      rmSync(receiptPath, { force: true });
      rmSync(misplacedPath, { force: true });
      rmSync(outsideReceipt, { force: true });
      writeFileSync(receiptPath, validReceipt);
      receiptCase.mutate();
      const result = readAuthenticatedPlanClosureChanges({
        repoRoot: fixture.root,
        base: fixture.closeBase,
        changes: readChangedPaths(fixture.root, fixture.closeBase),
      });
      expect(result.issues, receiptCase.name).toContainEqual(
        expect.stringContaining(receiptCase.message),
      );
    }

    rmSync(misplacedPath, { force: true });
    rmSync(outsideReceipt, { force: true });
    writeFileSync(receiptPath, validReceipt);
    writeFileSync(path.join(fixture.root, 'plans/README.md'), '# Edited static navigation\n');
    const staticNavigation = runCli(fixture.root, ['check', '--base', fixture.closeBase]);
    expect(staticNavigation.status, staticNavigation.stdout).toBe(0);
    for (const file of ['first.mjs', 'second.mjs', 'third.mjs']) {
      writeFixture(fixture.root, `scripts/new-capability/${file}`, 'export const value = true;\n');
    }
    const additionalWork = runCli(fixture.root, ['check', '--base', fixture.closeBase]);
    expect(additionalWork.status).toBe(1);
    expect(additionalWork.stdout).toContain(
      'qualifying work requires an active plan-adaptation-v1 record',
    );
    expect(additionalWork.stdout).toContain('directory-creation-or-movement');
    expect(additionalWork.stdout).toContain('three-production-modules');
  });
});

function createClosureRepository(options: { readonly includeSecondActivePlan?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-closure-receipt-'));
  fixturePaths.push(root);
  runGit(root, ['init', '--quiet', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Plan Closure Test']);
  runGit(root, ['config', 'user.email', 'plan-closure@example.test']);
  writeFixture(root, '.gitignore', '/.plan-adaptation/\n');
  writeFixture(
    root,
    'plans/policy.json',
    '{"schemaVersion":"adaptive-plan-policy-v1","maxActivePlans":8}\n',
  );
  writeFixture(root, 'plans/README.md', '# Adaptive plans\n\nStatic navigation.\n');
  writeFixture(root, 'scripts/plan-adaptation.mjs', 'console.log("fixture entry");\n');
  writeFixture(root, 'packages/tests/repo/plan-adaptation/fixture.test.ts', 'export {};\n');
  const planPath = 'plans/fixture-plan.md';
  writeFixture(root, planPath, `# Fixture plan\n\n${recordBlock(createRecord())}\n`);
  if (options.includeSecondActivePlan) {
    const second = createRecord('zzz-plan');
    second.capabilities[0] = {
      ...second.capabilities[0],
      owner: 'second plan',
      root: 'scripts/second-plan',
      entry: 'scripts/second-plan.mjs',
      testRoot: 'packages/tests/repo/second-plan',
    };
    writeFixture(root, 'plans/aaa-plan.md', `# Other plan\n\n${recordBlock(second)}\n`);
  }
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'base']);
  const base = runGit(root, ['rev-parse', 'HEAD']).trim();
  writeFixture(root, 'scripts/plan-adaptation/change.mjs', 'export const changed = true;\n');
  expect(runCli(root, ['init', '--plan', planPath, '--base', base]).status).toBe(0);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'record close base']);
  return { root, planPath, closeBase: runGit(root, ['rev-parse', 'HEAD']).trim() };
}

function createMergedClosureRepository(mergeMode: 'merge' | 'squash' | 'rebase') {
  const root = mkdtempSync(path.join(tmpdir(), `plan-${mergeMode}-closure-`));
  fixturePaths.push(root);
  runGit(root, ['init', '--quiet', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Plan Merge Test']);
  runGit(root, ['config', 'user.email', 'plan-merge@example.test']);
  writeFixture(root, '.gitignore', '/.plan-adaptation/\n');
  writeFixture(
    root,
    'plans/policy.json',
    '{"schemaVersion":"adaptive-plan-policy-v1","maxActivePlans":8}\n',
  );
  writeFixture(root, 'plans/README.md', '# Adaptive plans\n\nStatic navigation.\n');
  writeFixture(root, 'scripts/plan-adaptation.mjs', 'console.log("fixture entry");\n');
  writeFixture(root, 'packages/tests/repo/plan-adaptation/fixture.test.ts', 'export {};\n');
  const planPath = 'plans/fixture-plan.md';
  writeFixture(root, planPath, `# Fixture plan\n\n${recordBlock(createRecord())}\n`);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'base']);
  const base = runGit(root, ['rev-parse', 'HEAD']).trim();
  runGit(root, ['switch', '--quiet', '-c', 'reviewed-candidate']);
  writeFixture(root, 'scripts/plan-adaptation/change.mjs', 'export const changed = true;\n');
  expect(runCli(root, ['init', '--plan', planPath, '--base', base]).status).toBe(0);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'reviewed candidate']);
  const candidate = runGit(root, ['rev-parse', 'HEAD']).trim();
  runGit(root, ['switch', '--quiet', 'main']);
  if (mergeMode === 'merge') {
    runGit(root, ['merge', '--quiet', '--no-ff', 'reviewed-candidate', '-m', 'merge candidate']);
  } else if (mergeMode === 'squash') {
    runGit(root, ['merge', '--quiet', '--squash', 'reviewed-candidate']);
    runGit(root, ['commit', '--quiet', '-m', 'squash candidate']);
  } else {
    runGit(root, ['cherry-pick', '--quiet', candidate]);
  }
  return { root, planPath, closeBase: runGit(root, ['rev-parse', 'HEAD']).trim() };
}

function createInactiveClosureTransition() {
  const root = mkdtempSync(path.join(tmpdir(), 'inactive-plan-closure-'));
  fixturePaths.push(root);
  runGit(root, ['init', '--quiet', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Plan Closure Test']);
  runGit(root, ['config', 'user.email', 'plan-closure@example.test']);
  const record = { ...createRecord(), status: 'closed' };
  const planPath = 'plans/fixture-plan.md';
  writeFixture(root, planPath, `# Fixture plan\n\n${recordBlock(record)}\n`);
  writeFixture(root, 'plans/README.md', '# Adaptive plans\n\nStatic navigation.\n');
  writeFixture(
    root,
    'plans/policy.json',
    '{"schemaVersion":"adaptive-plan-policy-v1","maxActivePlans":8}\n',
  );
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'inactive base plan']);
  const base = runGit(root, ['rev-parse', 'HEAD']).trim();
  rmSync(path.join(root, planPath));
  writeFixture(
    root,
    'plans/fixture-plan.closure.json',
    `${JSON.stringify(
      {
        schemaVersion: 'plan-adaptation-closure-v1',
        planId: 'fixture-plan',
        planPath,
        planDigest: computeAdaptivePlanRecordDigest(record),
        pullRequestUrl: 'https://github.com/example/repository/pull/1',
        finalReviewStatus: 'complete',
      },
      null,
      2,
    )}\n`,
  );
  return { root, base };
}

function createRecord(planId = 'fixture-plan') {
  return {
    version: 1,
    planId,
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
        factContracts: [],
        controlFlowFamilies: ['lifecycle mutation', 'read-only check'],
      },
    ],
    architecture: {
      currentHypothesis: 'There is no adaptive owner.',
      intendedHypothesis: 'One lifecycle owns adaptive records.',
      freshInitialReview: { status: 'complete', reviewer: 'fixture', verdict: 'pass' },
    },
    completedSlicesSinceCheckpoint: [],
    facts: {
      diffBase: 'HEAD',
      affectedCodeDigest: null,
      computedTriggers: ['written-plan'],
      undeclaredChangedPaths: [],
    },
    checkpoint: {
      outcome: 'The fixture plan is active.',
      learning: 'The initial review fixed the owner.',
      structure: 'The lifecycle owns one atomic transaction.',
      decision: 'continue',
      nextSlices: ['slice-one'],
    },
    structuralDispositions: [],
    freshStructuralReview: null,
    coldNavigationEvidence: null,
    materialDecisions: [],
  };
}

function parseRecord(markdown: string): ReturnType<typeof createRecord> {
  const match = markdown.match(/```plan-adaptation-v1\n([\s\S]*?)\n```/u);
  if (!match) {
    throw new Error('fixture record missing');
  }
  return JSON.parse(match[1]);
}

function recordBlock(record: ReturnType<typeof createRecord>): string {
  return `\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\``;
}

function writeFinalReviewEvidence(root: string, record: ReturnType<typeof createRecord>): void {
  writeFileSync(
    path.join(root, 'final-pr-evidence.json'),
    JSON.stringify({
      version: 1,
      planId: record.planId,
      pullRequestUrl: 'https://github.com/example/repository/pull/1',
      finalReview: {
        status: 'complete',
        planDigest: computeAdaptivePlanRecordDigest(record),
      },
    }),
  );
}

function mutateReceipt(receiptPath: string, change: Record<string, string>): void {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, ...change }, null, 2)}\n`);
}

function runCli(root: string, args: readonly string[]) {
  return spawnSync(process.execPath, [entryPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}
