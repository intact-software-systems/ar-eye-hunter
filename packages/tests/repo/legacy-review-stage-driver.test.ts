import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const legacyReviewPath = path.join(repoRoot, 'scripts/review-legacy.mjs');
const stageDriverPath = path.join(repoRoot, 'scripts/check-pr-human-review-legacy-stages.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('PR legacy review stage driver', () => {
  it('validates initial pending-retention evidence without final approval metadata', () => {
    const fixture = createStageFixture();
    const pendingItems = reportedItems(fixture, 'retained-pending-human-approval');
    const record = {
      scope: 'code-changing',
      initialReview: stageReview(fixture, pendingItems),
      milestoneReview: { classification: 'none', entries: [] },
      finalReview: null,
      retainedLegacy: [],
    };

    const result = runStageDriver(fixture, record, true);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('validated 1 exact-SHA legacy candidate review stage(s)');
  });

  it('validates milestone pending-retention evidence without final approval metadata', () => {
    const fixture = createStageFixture();
    const resolvedItems = reportedItems(fixture, 'resolved');
    const pendingItems = reportedItems(fixture, 'retained-pending-human-approval');
    const record = {
      scope: 'code-changing',
      initialReview: stageReview(fixture, resolvedItems),
      milestoneReview: {
        classification: 'reviewed',
        entries: [stageReview(fixture, pendingItems)],
      },
      finalReview: null,
      retainedLegacy: [],
    };

    const result = runStageDriver(fixture, record, true);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('validated 2 exact-SHA legacy candidate review stage(s)');
  });

  it('validates final retained legacy with the complete approval and registry evidence', () => {
    const fixture = createStageFixture();
    const resolvedItems = reportedItems(fixture, 'resolved');
    const retainedItems = reportedItems(fixture, 'retained-pending-human-approval');
    const approvals = retainedItems.map((item) => retainedApproval(item, fixture.head));
    writeFileSync(fixture.registry, approvals.map(registryEntry).join('\n'));
    const record = {
      scope: 'code-changing',
      initialReview: stageReview(fixture, resolvedItems),
      milestoneReview: { classification: 'none', entries: [] },
      finalReview: stageReview(fixture, retainedItems),
      retainedLegacy: approvals,
    };

    const result = runStageDriver(fixture, record, false);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('validated 2 exact-SHA legacy candidate review stage(s)');
  });

  it('rejects a stage ledger that is not the exact scanner candidate set', () => {
    const fixture = createStageFixture();
    const incompleteItems = reportedItems(fixture, 'resolved').slice(1);
    const record = {
      scope: 'code-changing',
      initialReview: stageReview(fixture, incompleteItems),
      milestoneReview: { classification: 'none', entries: [] },
      finalReview: null,
      retainedLegacy: [],
    };

    const result = runStageDriver(fixture, record, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('initial legacy ledger does not match its exact stage range');
  });
});

function createStageFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'legacy-stage-driver-fixture-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'Legacy Stage Driver Test']);
  runGit(root, ['config', 'user.email', 'legacy-stage-driver@example.test']);
  writeFixture(
    root,
    'packages/example/src/canonical-route.ts',
    'export const createCanonicalRoute = () => 200;\n',
  );
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'base']);
  const base = runGit(root, ['rev-parse', 'HEAD']).trim();
  writeFixture(
    root,
    'packages/example/src/route-entry.ts',
    "export { createCanonicalRoute as createAlternateRoute } from './canonical-route.ts';\n",
  );
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'candidate']);
  const head = runGit(root, ['rev-parse', 'HEAD']).trim();
  symlinkSync(path.join(repoRoot, 'scripts'), path.join(root, 'scripts'), 'dir');
  const registry = path.join(root, 'registry.md');
  writeFileSync(registry, '# Production Legacy Exception Registry\n');
  return { root, base, head, registry };
}

function runStageDriver(
  fixture: ReturnType<typeof createStageFixture>,
  record: Record<string, unknown>,
  draft: boolean,
) {
  const event = path.join(fixture.root, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { body: JSON.stringify(record), draft } }));
  return spawnSync(
    process.execPath,
    [
      stageDriverPath,
      '--event',
      event,
      '--current-head',
      fixture.head,
      '--trusted-base',
      fixture.base,
      '--registry',
      fixture.registry,
    ],
    { cwd: fixture.root, encoding: 'utf8' },
  );
}

function reportedItems(fixture: ReturnType<typeof createStageFixture>, disposition: string) {
  const result = spawnSync(process.execPath, [legacyReviewPath, fixture.base, fixture.head], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
  expect(result.status, result.stdout).toBe(0);
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('CANDIDATE '))
    .map((line) => {
      const [id, location, symbol] = line.slice('CANDIDATE '.length).split(' | ');
      return {
        id,
        path: location.slice(0, location.lastIndexOf(':')),
        symbol,
        classification: 'legacy',
        disposition,
      };
    });
}

function stageReview(
  fixture: ReturnType<typeof createStageFixture>,
  items: readonly Record<string, string>[],
) {
  return {
    mergeBaseSha: fixture.base,
    headSha: fixture.head,
    legacy: { candidateCount: items.length, items },
  };
}

function retainedApproval(
  item: { readonly id: string; readonly path: string; readonly symbol: string },
  approvedProductionSha: string,
) {
  return {
    ...item,
    purpose: 'Keeps a documented compatibility entry available during migration.',
    consumerDependency: 'A named external consumer still calls this entry.',
    unsafeRemovalReason: 'The consumer migration has not completed.',
    minimization: 'The entry delegates directly to the canonical implementation.',
    canonicalOwner: 'packages/example/src/canonical-route.ts#createCanonicalRoute',
    compatibilityTests: 'packages/tests/example/route-entry-compatibility.test.ts',
    owner: 'Example team',
    removalCondition: 'Remove after the named consumer migration completes.',
    approvedProductionSha,
    reviewId: 1,
    reviewerLogin: 'named-human-reviewer',
    approvalDate: '2026-08-11T00:00:00Z',
    ledgerSha256: 'a'.repeat(64),
  };
}

function registryEntry(input: ReturnType<typeof retainedApproval>): string {
  return [
    '# Production Legacy Exception Registry',
    '',
    `### ${input.id}`,
    '',
    `- Repository-relative path and symbol: ${input.path}#${input.symbol}`,
    `- Purpose: ${input.purpose}`,
    `- Canonical implementation owner: ${input.canonicalOwner}`,
    `- Consumer or operational dependency: ${input.consumerDependency}`,
    `- Why removal is unsafe now: ${input.unsafeRemovalReason}`,
    `- Minimization already performed: ${input.minimization}`,
    `- Approval date and human reviewer: ${input.approvalDate} — ${input.reviewerLogin}`,
    `- Approved production candidate SHA: ${input.approvedProductionSha}`,
    `- Compatibility tests: ${input.compatibilityTests}`,
    `- Named owner: ${input.owner}`,
    `- Review or removal condition: ${input.removalCondition}`,
    `- GitHub PR review ID: ${input.reviewId}`,
    '',
  ].join('\n');
}

function writeFixture(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
