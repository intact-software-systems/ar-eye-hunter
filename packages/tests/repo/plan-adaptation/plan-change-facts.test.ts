import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  computeAffectedCodeDigest,
  computeCheckpointTriggers,
  computePlanFacts,
  computePlanFactsFromTree,
  computeQualificationReasons,
  computeQualificationReasonsForPlan,
  computeUndeclaredChangedPaths,
  hasCurrentPlanFacts,
  readChangedPaths,
  readChangedPathsBetweenRevisions,
} from '../../../../scripts/plan-adaptation/plan-change-facts.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('canonical content facts', () => {
  it('uses the same canonical facts for a renamed candidate tree and worktree', () => {
    const fixture = createRepository();
    mkdirSync(path.join(fixture.root, 'scripts/moved'), { recursive: true });
    runGit(fixture.root, ['mv', 'packages/example/src/a.ts', 'scripts/moved/example.ts']);
    const record = predecessorRecord([
      predecessorDisposition({
        path: 'packages/example/src/a.ts',
        destination: 'scripts/moved/example.ts',
      }),
    ]);
    const changes = readChangedPaths(fixture.root, fixture.base);

    expect(
      computePlanFactsFromTree({
        baseOid: fixture.base,
        baseEntries: readTree(fixture.root, fixture.base),
        entries: readIndexTree(fixture.root),
        changes,
        record,
        planPath: 'plans/example.md',
      }),
    ).toEqual(
      computePlanFacts({
        repoRoot: fixture.root,
        base: fixture.base,
        changes,
        record,
        planPath: 'plans/example.md',
      }),
    );
  });

  it('uses the same folder-change fact for a modified move between existing directories', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'scripts/existing/keep.ts', 'export const keep = true;\n');
    writeFixture(
      fixture.root,
      'packages/example/src/a.ts',
      'export const value = 1;\nexport const stable = true;\n',
    );
    runGit(fixture.root, ['add', '.']);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'add existing destination']);
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    runGit(fixture.root, [
      'mv',
      'packages/example/src/a.ts',
      'scripts/existing/example.ts',
    ]);
    writeFixture(
      fixture.root,
      'scripts/existing/example.ts',
      'export const value = 1;\nexport const stable = true;\nexport const moved = true;\n',
    );
    runGit(fixture.root, ['add', '.']);
    const record = predecessorRecord([
      predecessorDisposition({
        path: 'packages/example/src/a.ts',
        destination: 'scripts/existing/example.ts',
      }),
    ]);
    const changes = readChangedPaths(fixture.root, base);
    const worktreeFacts = computePlanFacts({
      repoRoot: fixture.root,
      base,
      changes,
      record,
      planPath: 'plans/example.md',
    });
    runGit(fixture.root, ['commit', '--quiet', '-m', 'move and modify source']);
    const candidateHead = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();

    expect(
      computePlanFactsFromTree({
        baseOid: base,
        baseEntries: readTree(fixture.root, base),
        entries: readTree(fixture.root, candidateHead),
        changes: readChangedPathsBetweenRevisions(fixture.root, base, candidateHead),
        record,
        planPath: 'plans/example.md',
      }),
    ).toEqual(worktreeFacts);
    expect(worktreeFacts.computedTriggers).toContain('folder-change');
  });

  it('does not turn unrelated delete and add changes into a folder movement', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'scripts/existing/keep.ts', 'export const keep = true;\n');
    runGit(fixture.root, ['add', '.']);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'add existing destination']);
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    runGit(fixture.root, ['rm', 'packages/example/src/a.ts']);
    writeFixture(fixture.root, 'scripts/existing/unrelated.ts', 'export const other = 42;\n');
    runGit(fixture.root, ['add', '.']);
    const changes = readChangedPaths(fixture.root, base);
    const record = predecessorRecord([]);
    const worktreeFacts = computePlanFacts({
      repoRoot: fixture.root,
      base,
      changes,
      record,
      planPath: 'plans/example.md',
    });

    expect(worktreeFacts.computedTriggers).not.toContain('folder-change');
    expect(
      computePlanFactsFromTree({
        baseOid: base,
        baseEntries: readTree(fixture.root, base),
        entries: readIndexTree(fixture.root),
        changes,
        record,
        planPath: 'plans/example.md',
      }),
    ).toEqual(worktreeFacts);
  });

  it('compares computed facts semantically while preserving array order', () => {
    const fixture = createRepository();
    const recordWithoutFacts = {
      capabilities: [],
      completedSlicesSinceCheckpoint: ['first', 'second'],
      coldNavigationEvidence: { status: 'failed' },
      architecture: { invalidatedAssumptions: ['invalid'] },
    };
    const input = {
      repoRoot: fixture.root,
      base: fixture.base,
      changes: [],
      planPath: 'plans/example.md',
      record: {
        ...recordWithoutFacts,
        facts: computePlanFacts({
          repoRoot: fixture.root,
          base: fixture.base,
          changes: [],
          planPath: 'plans/example.md',
          record: recordWithoutFacts,
        }),
      },
    };

    expect(hasCurrentPlanFacts(input)).toBe(true);
    expect(
      hasCurrentPlanFacts({
        ...input,
        record: {
          ...input.record,
          facts: {
            ...input.record.facts,
            computedTriggers: [...input.record.facts.computedTriggers].reverse(),
          },
        },
      }),
    ).toBe(false);
  });

  it('includes declared code navigation maps and mirrored tests in the affected digest', () => {
    const fixture = createRepository();
    const record = {
      capabilities: [
        {
          owner: 'example capability',
          root: 'packages/example/src',
          entry: 'packages/example/src/a.ts',
          testRoot: 'packages/tests/repo/example',
          navigationMap: 'packages/example/README.md',
        },
      ],
    };
    writeFixture(fixture.root, 'packages/example/README.md', '# Navigation\n');
    writeFixture(fixture.root, 'packages/tests/repo/example/owner.test.ts', 'export {};\n');
    const first = computeAffectedCodeDigest({
      repoRoot: fixture.root,
      changes: readChangedPaths(fixture.root, fixture.base),
      record,
    });
    writeFixture(fixture.root, 'packages/example/README.md', '# Changed navigation\n');
    writeFixture(
      fixture.root,
      'packages/tests/repo/example/owner.test.ts',
      'export const changed = true;\n',
    );

    expect(
      computeAffectedCodeDigest({
        repoRoot: fixture.root,
        changes: readChangedPaths(fixture.root, fixture.base),
        record,
      }),
    ).not.toBe(first);
  });

  it('binds exact code contract paths to freshness and treats them as declared', () => {
    const fixture = createRepository();
    const contractPath = '.github/workflows/governance.yml';
    const record = {
      capabilities: [
        {
          owner: 'example capability',
          root: 'packages/example/src',
          entry: 'packages/example/src/a.ts',
          testRoot: 'packages/tests/repo/example',
          contractPaths: [contractPath],
        },
      ],
    };
    writeFixture(fixture.root, contractPath, 'name: Governance\n');
    const changes = readChangedPaths(fixture.root, fixture.base);
    const first = computeAffectedCodeDigest({ repoRoot: fixture.root, changes, record });

    expect(computeUndeclaredChangedPaths(changes, record)).not.toContain(contractPath);

    writeFixture(fixture.root, contractPath, 'name: Changed governance\n');
    expect(
      computeAffectedCodeDigest({
        repoRoot: fixture.root,
        changes: readChangedPaths(fixture.root, fixture.base),
        record,
      }),
    ).not.toBe(first);
  });
  it('sorts canonical tuples by repository path bytes', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'scripts/Z.mjs', 'export const upper = true;\n');
    writeFixture(fixture.root, 'scripts/a.mjs', 'export const lower = true;\n');
    runGit(fixture.root, ['add', '.']);

    expect(
      computeAffectedCodeDigest({
        repoRoot: fixture.root,
        changes: readChangedPaths(fixture.root, fixture.base),
      }),
    ).toBe('c0b3655922b79cf563699a94aadb3772a7ac1e20c18d01d54f83100d13fee7a4');
  });

  it('uses sorted path, Git mode, and content tuples without depending on commit SHA', () => {
    const first = createRepository();
    writeFixture(first.root, 'packages/example/src/a.ts', 'export const value = 2;\n');
    writeFixture(first.root, 'scripts/tool.mjs', '#!/usr/bin/env node\nconsole.log("same");\n');
    chmodSync(path.join(first.root, 'scripts/tool.mjs'), 0o755);
    runGit(first.root, ['add', '.']);

    const digest = computeAffectedCodeDigest({
      repoRoot: first.root,
      changes: readChangedPaths(first.root, first.base),
    });
    runGit(first.root, ['commit', '--quiet', '-m', 'same tree at another SHA']);
    const secondBase = runGit(first.root, ['rev-parse', 'HEAD']).trim();
    runGit(first.root, ['commit', '--quiet', '--allow-empty', '-m', 'different SHA']);

    expect(
      computeAffectedCodeDigest({
        repoRoot: first.root,
        changes: readChangedPaths(first.root, first.base),
      }),
    ).toBe(digest);
    expect(secondBase).not.toBe(runGit(first.root, ['rev-parse', 'HEAD']).trim());

    chmodSync(path.join(first.root, 'scripts/tool.mjs'), 0o644);
    expect(
      computeAffectedCodeDigest({
        repoRoot: first.root,
        changes: readChangedPaths(first.root, first.base),
      }),
    ).not.toBe(digest);
  });

  it('uses Git-reported modes instead of filesystem executable bits', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'scripts/tool.mjs', 'export const tool = true;\n');
    chmodSync(path.join(fixture.root, 'scripts/tool.mjs'), 0o755);
    runGit(fixture.root, ['add', '.']);
    const executableDigest = computeAffectedCodeDigest({
      repoRoot: fixture.root,
      changes: readChangedPaths(fixture.root, fixture.base),
    });

    runGit(fixture.root, ['config', 'core.fileMode', 'false']);
    chmodSync(path.join(fixture.root, 'scripts/tool.mjs'), 0o644);

    expect(
      computeAffectedCodeDigest({
        repoRoot: fixture.root,
        changes: readChangedPaths(fixture.root, fixture.base),
      }),
    ).toBe(executableDigest);
  });

  it('keeps an old-path deletion tuple when production code is renamed outside code', () => {
    const fixture = createRepository();
    mkdirSync(path.join(fixture.root, 'notes'), { recursive: true });
    runGit(fixture.root, ['mv', 'packages/example/src/a.ts', 'notes/a.txt']);

    expect(
      computeAffectedCodeDigest({
        repoRoot: fixture.root,
        changes: readChangedPaths(fixture.root, fixture.base),
      }),
    ).toBe('cf952557964e8fe54de27ab2551e23ede7b32f9271259dd786c5ba29b1611304');
  });
});

function readTree(root: string, revision: string) {
  return runGit(root, ['ls-tree', '-rz', '--full-tree', revision])
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/u)!;
      return {
        mode: match[1],
        blobOid: match[2],
        path: match[3],
        content: runGit(root, ['cat-file', 'blob', match[2]]),
      };
    });
}

function readIndexTree(root: string) {
  const treeOid = runGit(root, ['write-tree']).trim();
  return readTree(root, treeOid);
}

describe('qualification and checkpoint facts', () => {
  it('accepts exact deleted and moved predecessor files with structured owner destinations', () => {
    const fixture = createRepository();
    writeFixture(
      fixture.root,
      'packages/tests/repo/pr-human-review-validation.test.ts',
      'export {};\n',
    );
    writeFixture(
      fixture.root,
      'scripts/check-pr-human-review.mjs',
      'export const review = true;\n',
    );
    runGit(fixture.root, ['add', '.']);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'v1 review files']);
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    runGit(fixture.root, ['rm', 'packages/tests/repo/pr-human-review-validation.test.ts']);
    runGit(fixture.root, [
      'mv',
      'scripts/check-pr-human-review.mjs',
      'scripts/pr-human-review.mjs',
    ]);
    const changes = readChangedPaths(fixture.root, base);
    const record = predecessorRecord([
      predecessorDisposition({
        path: 'packages/tests/repo/pr-human-review-validation.test.ts',
        destination: 'scripts/pr-human-review.mjs',
      }),
      predecessorDisposition({
        path: 'scripts/check-pr-human-review.mjs',
        destination: 'scripts/pr-human-review.mjs',
      }),
    ]);

    expect(computeUndeclaredChangedPaths(changes, record)).toEqual([]);
  });

  it('does not let predecessor dispositions hide current, arbitrary, or non-migration paths', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, 'scripts/check-pr-human-review.mjs', 'export {};\n');
    runGit(fixture.root, ['add', '.']);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'v1 review entry']);
    const base = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    runGit(fixture.root, [
      'mv',
      'scripts/check-pr-human-review.mjs',
      'scripts/pr-human-review.mjs',
    ]);
    writeFixture(fixture.root, 'packages/unowned/new.ts', 'export {};\n');
    const changes = readChangedPaths(fixture.root, base);
    const record = predecessorRecord([
      predecessorDisposition({
        path: 'scripts/pr-human-review.mjs',
        destination: 'scripts/pr-human-review.mjs',
      }),
      predecessorDisposition({
        path: 'packages/unowned/new.ts',
        destination: 'scripts/pr-human-review.mjs',
      }),
      { ...predecessorDisposition(), disposition: 'keep' },
    ]);

    expect(computeUndeclaredChangedPaths(changes, record)).toEqual(
      expect.arrayContaining(['scripts/check-pr-human-review.mjs', 'packages/unowned/new.ts']),
    );
  });

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

  it('treats an explicitly consumed cross-owner fact contract as declared', () => {
    const fixture = createRepository();
    writeFixture(
      fixture.root,
      'scripts/repo-style-check/structural-facts.mjs',
      'export const facts = [];\n',
    );
    const changes = readChangedPaths(fixture.root, fixture.base);
    const record = {
      capabilities: [
        {
          root: 'scripts/repo-structure-check',
          entry: 'scripts/repo-structure-check.mjs',
          testRoot: 'packages/tests/repo/repo-structure-check',
          factContracts: ['scripts/repo-style-check/structural-facts.mjs'],
        },
      ],
    };

    expect(computeUndeclaredChangedPaths(changes, record)).not.toContain(
      'scripts/repo-style-check/structural-facts.mjs',
    );
  });

  it('reserves planned code and guidance surfaces before activation', () => {
    const fixture = createRepository();
    writeFixture(
      fixture.root,
      '.agents/skills/adaptive-plan-execution/SKILL.md',
      '# Adaptive Plan Execution\n',
    );
    writeFixture(
      fixture.root,
      '.agents/evaluations/adaptive-agent-execution/v1/rubric.json',
      '{"version":1}\n',
    );
    writeFixture(
      fixture.root,
      'packages/tests/repo/adaptive-agent-execution/contract.test.ts',
      'export {};\n',
    );
    writeFixture(
      fixture.root,
      'packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts',
      'export {};\n',
    );
    const record = {
      capabilities: [
        {
          kind: 'guidance',
          owner: 'adaptive plan execution guidance',
          skillRoot: '.agents/skills/adaptive-plan-execution',
          skillEntry: '.agents/skills/adaptive-plan-execution/SKILL.md',
          contractTestRoot: 'packages/tests/repo/adaptive-agent-execution',
          focusedCommand: 'npm run test:adaptive-plan-execution',
          evaluationRoot: '.agents/evaluations/adaptive-agent-execution/v1',
          contractPaths: ['packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts'],
          activation: { state: 'planned', slice: 'future-guidance' },
        },
        {
          owner: 'future code owner',
          root: 'scripts/future-code',
          entry: 'scripts/future-code.mjs',
          testRoot: 'packages/tests/repo/future-code',
          focusedCommand: 'npm run test:future-code',
          navigationMap: 'scripts/future-code/README.md',
          factContracts: ['scripts/future-contract.mjs'],
          contractPaths: ['.github/workflows/future-code.yml'],
          activation: { state: 'planned', slice: 'future-code' },
        },
      ],
    };

    writeFixture(fixture.root, 'scripts/future-code.mjs', 'export const future = true;\n');
    writeFixture(fixture.root, 'scripts/future-code/README.md', '# Future code\n');
    writeFixture(fixture.root, 'packages/tests/repo/future-code/owner.test.ts', 'export {};\n');
    writeFixture(fixture.root, 'scripts/future-contract.mjs', 'export const facts = [];\n');
    writeFixture(fixture.root, '.github/workflows/future-code.yml', 'name: Future code\n');
    const changes = readChangedPaths(fixture.root, fixture.base);

    expect(computeUndeclaredChangedPaths(changes, record)).toEqual([]);

    const digest = computeAffectedCodeDigest({ repoRoot: fixture.root, changes, record });
    writeFixture(
      fixture.root,
      '.agents/evaluations/adaptive-agent-execution/v1/rubric.json',
      '{"version":2}\n',
    );
    expect(
      computeAffectedCodeDigest({
        repoRoot: fixture.root,
        changes: readChangedPaths(fixture.root, fixture.base),
        record,
      }),
    ).not.toBe(digest);
  });

  it('tracks planned and active guidance-router entries, tests, evaluations, contracts, and crossings', () => {
    const fixture = createRepository();
    const routerPaths = [
      'AGENTS.md',
      'packages/tests/repo/general-agent-guidance/contract.test.ts',
      'packages/tests/repo/general-agent-guidance/evaluation-v1.json',
      '.agents/skills/adaptive-plan-execution/SKILL.md',
      '.agents/skills/organizing-repository-structure/SKILL.md',
    ];
    for (const repositoryPath of routerPaths) {
      writeFixture(fixture.root, repositoryPath, `${repositoryPath}\n`);
    }
    const router = {
      kind: 'guidance',
      guidanceRole: 'router',
      owner: 'general agent guidance',
      routingEntry: 'AGENTS.md',
      contractTestRoot: 'packages/tests/repo/general-agent-guidance',
      focusedCommand: 'npm run test:general-agent-guidance',
      evaluationRoot: null,
      contractPaths: [
        '.agents/skills/adaptive-plan-execution/SKILL.md',
        '.agents/skills/organizing-repository-structure/SKILL.md',
      ],
      activation: { state: 'planned', slice: 'general-guidance-routing-declaration' },
    };
    const record = {
      capabilities: [
        router,
        {
          kind: 'guidance',
          owner: 'adaptive plan execution guidance',
          skillRoot: '.agents/skills/adaptive-plan-execution',
          skillEntry: '.agents/skills/adaptive-plan-execution/SKILL.md',
          contractTestRoot: 'packages/tests/repo/adaptive-agent-execution',
          focusedCommand: 'npm run test:adaptive-plan-execution',
          evaluationRoot: null,
          contractPaths: [],
        },
        {
          kind: 'guidance',
          owner: 'repository structure guidance',
          skillRoot: '.agents/skills/organizing-repository-structure',
          skillEntry: '.agents/skills/organizing-repository-structure/SKILL.md',
          contractTestRoot: 'packages/tests/repo/organizing-repository-structure',
          focusedCommand: 'npm run test:organizing-repository-structure',
          evaluationRoot: null,
          contractPaths: [],
        },
      ],
    };
    const changes = readChangedPaths(fixture.root, fixture.base);

    expect(computeUndeclaredChangedPaths(changes, record)).toEqual([]);
    expect(
      computeQualificationReasonsForPlan({
        repoRoot: fixture.root,
        base: fixture.base,
        changes,
        record,
      }),
    ).toContain('package-or-capability-crossing');

    const plannedDigest = computeAffectedCodeDigest({ repoRoot: fixture.root, changes, record });
    delete router.activation;
    expect(computeAffectedCodeDigest({ repoRoot: fixture.root, changes, record })).toBe(
      plannedDigest,
    );
    writeFixture(fixture.root, 'AGENTS.md', '# Changed router\n');
    expect(
      computeAffectedCodeDigest({
        repoRoot: fixture.root,
        changes: readChangedPaths(fixture.root, fixture.base),
        record,
      }),
    ).not.toBe(plannedDigest);
  });

  it('detects ownership crossing between exact code contracts outside authored roots', () => {
    const fixture = createRepository();
    writeFixture(fixture.root, '.github/workflows/first.yml', 'name: First\n');
    writeFixture(fixture.root, '.github/workflows/second.yml', 'name: Second\n');
    const changes = readChangedPaths(fixture.root, fixture.base);
    const record = {
      capabilities: [
        {
          owner: 'first governance owner',
          root: 'scripts/first-governance',
          entry: 'scripts/first-governance.mjs',
          testRoot: 'packages/tests/repo/first-governance',
          contractPaths: ['.github/workflows/first.yml'],
        },
        {
          owner: 'second governance owner',
          root: 'scripts/second-governance',
          entry: 'scripts/second-governance.mjs',
          testRoot: 'packages/tests/repo/second-governance',
          contractPaths: ['.github/workflows/second.yml'],
        },
      ],
    };

    expect(
      computeQualificationReasonsForPlan({
        repoRoot: fixture.root,
        base: fixture.base,
        changes,
        record,
      }),
    ).toContain('package-or-capability-crossing');
    expect(
      computeCheckpointTriggers({
        repoRoot: fixture.root,
        base: fixture.base,
        changes,
        record,
      }),
    ).toContain('ownership-change');
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

function predecessorRecord(structuralDispositions: ReadonlyArray<Record<string, unknown>>) {
  return {
    capabilities: [
      {
        owner: 'PR human review',
        root: 'scripts/pr-human-review',
        entry: 'scripts/pr-human-review.mjs',
        testRoot: 'packages/tests/repo/pr-human-review',
      },
    ],
    structuralDispositions,
  };
}

function predecessorDisposition(
  input: { readonly path?: string; readonly destination?: string } = {},
) {
  return {
    kind: 'predecessor-path',
    path: input.path ?? 'scripts/check-pr-human-review.mjs',
    disposition: 'move',
    destination: input.destination ?? 'scripts/pr-human-review.mjs',
    owner: 'PR human review',
    rationale: 'Review Record v2 directly replaces the v1 path under its canonical owner.',
  };
}

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
