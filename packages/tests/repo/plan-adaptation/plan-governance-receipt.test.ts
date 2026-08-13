import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeSha256 } from '../../../../scripts/governance-decisions/canonical-json.mjs';
import {
  createGovernanceDecisionReceipt,
  serializeGovernanceDecisionReceipt,
} from '../../../../scripts/governance-decisions/governance-decision-receipt.mjs';
import { computeGovernanceDecisionTransition } from '../../../../scripts/governance-decisions/governance-decision-transition.mjs';
import { readGitRepositorySnapshot } from '../../../../scripts/governance-decisions/git-repository-snapshot.mjs';
import { toActivePlanRegistry } from '../../../../scripts/plan-adaptation/active-plan-registry.mjs';
import { parseAdaptivePlanRecord } from '../../../../scripts/plan-adaptation/adaptive-plan-record.mjs';
import {
  checkAdaptivePlans,
  initAdaptivePlan,
} from '../../../../scripts/plan-adaptation/plan-adaptation-lifecycle.mjs';
import { readAuthenticatedPlanTransitionChanges } from '../../../../scripts/plan-adaptation/plan-transition-authentication.mjs';
import {
  readChangedPaths,
  readChangedPathsBetweenRevisions,
} from '../../../../scripts/plan-adaptation/plan-change-facts.mjs';
import { checkRepositoryStructure } from '../../../../scripts/repo-structure-check/repository-structure-check.mjs';
import { toGovernanceDecisionFixturePlanMarkdown } from '../governance-decisions/governance-decision-fixture';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('plan governance receipt authentication', () => {
  it('accepts an exact receipt-backed plan cancellation without closure-v1 evidence', () => {
    const fixture = createCancelledPlanCommit();

    expect(() =>
      checkAdaptivePlans({ repoRoot: fixture.root, base: fixture.parentOid }),
    ).not.toThrow();
  });

  it('does not accept the same plan disposition when the receipt is absent', () => {
    const fixture = createCancelledPlanCommit({ omitReceipt: true });

    expect(() => checkAdaptivePlans({ repoRoot: fixture.root, base: fixture.parentOid })).toThrow(
      'close-out is not authenticated',
    );
  });

  it.each([
    'plan.cancel',
    'plan.complete',
    'plan.supersede',
    'plan.quarantine',
  ] as const)('accepts a %s disposition and frees or transfers the plan slot', (operation) => {
    const fixture = createPlanDispositionCommit({ operation });

    expect(() =>
      checkAdaptivePlans({ repoRoot: fixture.root, base: fixture.parentOid }),
    ).not.toThrow();
    if (['plan.cancel', 'plan.complete', 'plan.quarantine'].includes(operation)) {
      expect(
        checkRepositoryStructure({ repoRoot: fixture.root, base: fixture.parentOid }),
      ).toMatchObject({ findings: [] });
    }
    if (operation !== 'plan.supersede') {
      const nextPlanPath = 'plans/next-plan.md';
      writeFileSync(
        path.join(fixture.root, nextPlanPath),
        toGovernanceDecisionFixturePlanMarkdown(fixture.parentOid),
      );
      expect(() =>
        initAdaptivePlan({
          repoRoot: fixture.root,
          base: fixture.parentOid,
          planPath: nextPlanPath,
        }),
      ).not.toThrow();
    }
  });

  it('repairs a plan while retaining the structurally authenticated changed plan path', () => {
    const fixture = createRepairedPlanCommit();
    const authentication = readAuthenticatedPlanTransitionChanges({
      repoRoot: fixture.root,
      base: fixture.parentOid,
      changes: readChangedPaths(fixture.root, fixture.parentOid),
    });

    expect(authentication.issues).toEqual([]);
    expect(authentication.authenticatedDispositions).toEqual([
      expect.objectContaining({ operation: 'plan.repair', planPath: fixture.planPath }),
    ]);
    expect(authentication.changes).toEqual([]);
    expect(() =>
      checkAdaptivePlans({ repoRoot: fixture.root, base: fixture.parentOid }),
    ).not.toThrow();

    mkdirSync(path.join(fixture.root, 'scripts'), { recursive: true });
    writeFileSync(path.join(fixture.root, 'scripts/unrelated-later.mjs'), 'export const later = 1;\n');
    expect(() =>
      checkAdaptivePlans({ repoRoot: fixture.root, base: fixture.parentOid }),
    ).toThrow('computed facts are stale');
  });
});

function createCancelledPlanCommit(options: { omitReceipt?: boolean } = {}) {
  return createPlanDispositionCommit({ operation: 'plan.cancel', ...options });
}

function createPlanDispositionCommit(options: {
  operation: 'plan.cancel' | 'plan.complete' | 'plan.supersede' | 'plan.quarantine';
  omitReceipt?: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-governance-receipt-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'Fixture']);
  runGit(root, ['config', 'user.email', 'fixture@example.com']);
  mkdirSync(path.join(root, 'plans'), { recursive: true });
  const planPath = 'plans/blocked-plan.md';
  const planMarkdown =
    options.operation === 'plan.quarantine'
      ? 'unreadable tactical plan\n'
      : toGovernanceDecisionFixturePlanMarkdown();
  const record =
    options.operation === 'plan.quarantine'
      ? undefined
      : parseAdaptivePlanRecord(planMarkdown, planPath);
  writeFileSync(path.join(root, planPath), planMarkdown);
  writeFileSync(
    path.join(root, 'plans/README.md'),
    record ? toActivePlanRegistry([{ planPath, record }]) : '# Active adaptive plans\n\nBefore.\n',
  );
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'active plan']);
  const parentOid = runGit(root, ['rev-parse', 'HEAD']).trim();
  const parentSnapshot = readGitRepositorySnapshot({ repoRoot: root, commitOid: parentOid });
  const successorPath = 'plans/successor-plan.md';
  const successorMarkdown = toGovernanceDecisionFixturePlanMarkdown(parentOid)
    .replace('governance-decision-fixture', 'governance-decision-successor')
    .replace('"affectedCodeDigest": null', `"affectedCodeDigest": "${emptyDigest()}"`);
  const successorBlobOid = execFileSync('git', ['hash-object', '--stdin'], {
    cwd: root,
    encoding: 'utf8',
    input: successorMarkdown,
  }).trim();
  const request = {
    schemaVersion: 'governance-decision-request-v1',
    operation: options.operation,
    repository: 'intact-software-systems/ar-eye-hunter',
    defaultBranch: 'main',
    expectedHeadOid: parentOid,
    force: true,
    reason: 'Cancel the blocked tactical plan.',
    target:
      options.operation === 'plan.quarantine'
        ? {
            planPath,
            planBlobOid: parentSnapshot.entries.find((entry) => entry.path === planPath)!.blobOid,
          }
        : { planPath, planDigest: computeSha256(planMarkdown) },
    payload:
      options.operation === 'plan.supersede'
        ? { successorPlanPath: successorPath, successorPlanBlobOid: successorBlobOid }
        : {},
  };
  const transition = computeGovernanceDecisionTransition({
    request,
    snapshot: parentSnapshot,
    readBlob: () => successorMarkdown,
  });
  rmSync(path.join(root, planPath));
  for (const addition of transition.additions) {
    mkdirSync(path.dirname(path.join(root, addition.path)), { recursive: true });
    writeFileSync(path.join(root, addition.path), addition.content);
  }
  if (!options.omitReceipt) {
    const receipt = createGovernanceDecisionReceipt({
      request,
      actor: { login: 'repository-admin', permission: 'admin' },
      transport: { kind: 'local-gh' },
      result: transition.result,
      bypassedInvariants: transition.bypassedInvariants,
      stateChanges: transition.stateChanges,
    });
    mkdirSync(path.join(root, 'governance/decisions'), { recursive: true });
    writeFileSync(
      path.join(root, transition.receiptPath),
      serializeGovernanceDecisionReceipt(receipt),
    );
  }
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '-q', '-m', 'governance cancellation']);
  return { root, parentOid };
}

function createRepairedPlanCommit() {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-governance-repair-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'Fixture']);
  runGit(root, ['config', 'user.email', 'fixture@example.com']);
  mkdirSync(path.join(root, 'plans'), { recursive: true });
  const planPath = 'plans/repair-plan.md';
  const initialMarkdown = toGovernanceDecisionFixturePlanMarkdown('HEAD');
  writeFileSync(path.join(root, planPath), initialMarkdown);
  writeFileSync(path.join(root, 'plans/README.md'), '# Active adaptive plans\n\nBefore.\n');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'repair base']);
  const diffBase = runGit(root, ['rev-parse', 'HEAD']).trim();
  const planMarkdown = toGovernanceDecisionFixturePlanMarkdown(diffBase);
  const record = parseAdaptivePlanRecord(planMarkdown, planPath);
  writeFileSync(path.join(root, planPath), planMarkdown);
  writeFileSync(path.join(root, 'plans/README.md'), toActivePlanRegistry([{ planPath, record }]));
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'repair parent']);
  const parentOid = runGit(root, ['rev-parse', 'HEAD']).trim();
  const parentSnapshot = readGitRepositorySnapshot({ repoRoot: root, commitOid: parentOid });
  const baseSnapshot = readGitRepositorySnapshot({ repoRoot: root, commitOid: diffBase });
  const request = {
    schemaVersion: 'governance-decision-request-v1',
    operation: 'plan.repair',
    repository: 'intact-software-systems/ar-eye-hunter',
    defaultBranch: 'main',
    expectedHeadOid: parentOid,
    force: true,
    reason: 'Repair exact plan facts.',
    target: { planPath, planDigest: computeSha256(planMarkdown) },
    payload: {
      checkpoint: {
        outcome: 'The repaired plan is current.',
        learning: 'Facts were stale.',
        structure: 'Ownership remains coherent.',
        decision: 'amend',
        nextSlices: ['governance-decision-core'],
      },
    },
  };
  const transition = computeGovernanceDecisionTransition({
    request,
    snapshot: parentSnapshot,
    readSnapshot: (revision) => (revision === diffBase ? baseSnapshot : parentSnapshot),
    readChanges: (baseOid, headOid) => readChangedPathsBetweenRevisions(root, baseOid, headOid),
  });
  for (const addition of transition.additions) {
    mkdirSync(path.dirname(path.join(root, addition.path)), { recursive: true });
    writeFileSync(path.join(root, addition.path), addition.content);
  }
  const receipt = createGovernanceDecisionReceipt({
    request,
    actor: { login: 'repository-admin', permission: 'admin' },
    transport: { kind: 'local-gh' },
    result: transition.result,
    bypassedInvariants: transition.bypassedInvariants,
    stateChanges: transition.stateChanges,
  });
  mkdirSync(path.join(root, 'governance/decisions'), { recursive: true });
  writeFileSync(
    path.join(root, transition.receiptPath),
    serializeGovernanceDecisionReceipt(receipt),
  );
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '-q', '-m', 'repair governance plan']);
  return { root, parentOid, planPath };
}

function emptyDigest(): string {
  return createHash('sha256').digest('hex');
}

function runGit(root: string, arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}
