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
const staticPlanNavigation = '# Adaptive plans\n\nStatic navigation.\n';

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('plan governance receipt authentication', () => {
  it.each([
    ['gate.accept-deviation', false],
    ['gate.accept-deviation', true],
    ['exception.decide', false],
    ['exception.decide', true],
  ] as const)(
    'keeps a valid receipt-only %s decision neutral to plan facts (active plan: %s)',
    (operation, activePlan) => {
      const fixture = createReceiptOnlyDecisionCommit({ operation, activePlan });

      expect(() =>
        checkAdaptivePlans({
          repoRoot: fixture.root,
          base: fixture.parentOid,
          readGateEvidence: () => failedGateEvidence(),
          readDecisionAdmissionEvidence: (commitOid: string) =>
            successfulAdmissionEvidence(commitOid),
        }),
      ).not.toThrow();
      expect(
        readAuthenticatedPlanTransitionChanges({
          repoRoot: fixture.root,
          base: fixture.diffBase,
          changes: readChangedPaths(fixture.root, fixture.diffBase),
          readGateEvidence: () => failedGateEvidence(),
          readDecisionAdmissionEvidence: (commitOid: string) =>
            successfulAdmissionEvidence(commitOid),
        }),
      ).toMatchObject({
        authenticatedPlans: [],
        authenticatedDispositions: [],
        changes: expect.not.arrayContaining([
          expect.objectContaining({ path: fixture.receiptPath }),
        ]),
        issues: [],
      });
    },
  );

  it('rejects a mixed non-plan receipt commit and never authenticates its plan change', () => {
    const fixture = createReceiptOnlyDecisionCommit({
      operation: 'exception.decide',
      activePlan: true,
      mutatePlanInDecisionCommit: true,
    });
    const authentication = readAuthenticatedPlanTransitionChanges({
      repoRoot: fixture.root,
      base: fixture.parentOid,
      changes: readChangedPaths(fixture.root, fixture.parentOid),
    });

    expect(authentication.issues[0]).toContain('is not authenticated');
    expect(authentication.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: fixture.planPath })]),
    );
    expect(() => checkAdaptivePlans({ repoRoot: fixture.root, base: fixture.parentOid })).toThrow(
      'is not authenticated',
    );
  });

  it('rejects a malformed receipt-only commit instead of making it plan-neutral', () => {
    const fixture = createReceiptOnlyDecisionCommit({
      operation: 'exception.decide',
      activePlan: false,
      malformedReceipt: true,
    });

    expect(() => checkAdaptivePlans({ repoRoot: fixture.root, base: fixture.parentOid })).toThrow(
      'is not authenticated',
    );
  });

  it('rejects a receipt-only decision merged from feature-branch history', () => {
    const fixture = createReceiptOnlyDecisionCommit({
      operation: 'exception.decide',
      activePlan: false,
      mergeFromFeature: true,
    });

    expect(() => checkAdaptivePlans({ repoRoot: fixture.root, base: fixture.parentOid })).toThrow(
      'adding commit is not on the trusted main first-parent lineage',
    );
  });

  it('rejects a structurally valid non-admin receipt on a pull-request head', () => {
    const fixture = createReceiptOnlyDecisionCommit({
      operation: 'exception.decide',
      activePlan: false,
      directFeatureHead: true,
    });

    expect(() =>
      checkAdaptivePlans({
        repoRoot: fixture.root,
        base: fixture.parentOid,
        readDecisionAdmissionEvidence: () => ({ workflowRuns: [] }),
      }),
    ).toThrow('authenticated main-push admission');
  });

  it('rejects a handcrafted one-parent first-parent receipt without authenticated admission', () => {
    const fixture = createReceiptOnlyDecisionCommit({
      operation: 'exception.decide',
      activePlan: false,
    });

    expect(() =>
      checkAdaptivePlans({
        repoRoot: fixture.root,
        base: fixture.parentOid,
        readDecisionAdmissionEvidence: () => ({ workflowRuns: [] }),
      }),
    ).toThrow('authenticated main-push admission');
  });

  it('rejects a plan disposition without authenticated admission', () => {
    const fixture = createCancelledPlanCommit();

    expect(() =>
      checkAdaptivePlans({
        repoRoot: fixture.root,
        base: fixture.parentOid,
        readDecisionAdmissionEvidence: () => ({ workflowRuns: [] }),
      }),
    ).toThrow('authenticated main-push admission');
  });

  it('accepts an exact receipt-backed plan cancellation without closure-v1 evidence', () => {
    const fixture = createCancelledPlanCommit();

    expect(() =>
      checkAdaptivePlans({
        repoRoot: fixture.root,
        base: fixture.parentOid,
        readDecisionAdmissionEvidence: (commitOid: string) =>
          successfulAdmissionEvidence(commitOid),
      }),
    ).not.toThrow();
  });

  it('does not accept the same plan disposition when the receipt is absent', () => {
    const fixture = createCancelledPlanCommit({ omitReceipt: true });

    expect(() => checkAdaptivePlans({ repoRoot: fixture.root, base: fixture.parentOid })).toThrow(
      'close-out is not authenticated',
    );
  });

  it.each(['plan.cancel', 'plan.complete', 'plan.supersede', 'plan.quarantine'] as const)(
    'accepts a %s disposition and frees or transfers the plan slot',
    (operation) => {
      const fixture = createPlanDispositionCommit({ operation });

      expect(() =>
        checkAdaptivePlans({
          repoRoot: fixture.root,
          base: fixture.parentOid,
          readDecisionAdmissionEvidence: (commitOid: string) =>
            successfulAdmissionEvidence(commitOid),
        }),
      ).not.toThrow();
      if (['plan.cancel', 'plan.complete', 'plan.quarantine'].includes(operation)) {
        expect(
          checkRepositoryStructure({
            repoRoot: fixture.root,
            base: fixture.parentOid,
            readDecisionAdmissionEvidence: (commitOid: string) =>
              successfulAdmissionEvidence(commitOid),
          }),
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
    },
  );

  it(
    'repairs a plan while retaining the structurally authenticated changed plan path',
    { timeout: 15_000 },
    () => {
      const fixture = createRepairedPlanCommit();
      const authentication = readAuthenticatedPlanTransitionChanges({
        repoRoot: fixture.root,
        base: fixture.parentOid,
        changes: readChangedPaths(fixture.root, fixture.parentOid),
        readDecisionAdmissionEvidence: (commitOid: string) =>
          successfulAdmissionEvidence(commitOid),
      });

      expect(authentication.issues).toEqual([]);
      expect(authentication.authenticatedDispositions).toEqual([
        expect.objectContaining({ operation: 'plan.repair', planPath: fixture.planPath }),
      ]);
      expect(authentication.changes).toEqual([]);
      expect(() =>
        checkAdaptivePlans({
          repoRoot: fixture.root,
          base: fixture.parentOid,
          readDecisionAdmissionEvidence: (commitOid: string) =>
            successfulAdmissionEvidence(commitOid),
        }),
      ).not.toThrow();

      mkdirSync(path.join(fixture.root, 'scripts'), { recursive: true });
      writeFileSync(
        path.join(fixture.root, 'scripts/unrelated-later.mjs'),
        'export const later = 1;\n',
      );
      expect(() =>
        checkAdaptivePlans({
          repoRoot: fixture.root,
          base: fixture.parentOid,
          readDecisionAdmissionEvidence: (commitOid: string) =>
            successfulAdmissionEvidence(commitOid),
        }),
      ).toThrow('unassigned qualifying scope: scripts/unrelated-later.mjs');
    },
  );
});

function createReceiptOnlyDecisionCommit(options: {
  operation: 'gate.accept-deviation' | 'exception.decide';
  activePlan: boolean;
  mutatePlanInDecisionCommit?: boolean;
  malformedReceipt?: boolean;
  mergeFromFeature?: boolean;
  directFeatureHead?: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-non-plan-governance-receipt-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'Fixture']);
  runGit(root, ['config', 'user.email', 'fixture@example.com']);
  mkdirSync(path.join(root, 'plans'), { recursive: true });
  writePlanPolicy(root);
  writeFileSync(path.join(root, 'plans/README.md'), staticPlanNavigation);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'decision fixture base']);
  const diffBase = runGit(root, ['rev-parse', 'HEAD']).trim();
  const planPath = 'plans/receipt-neutral-plan.md';
  if (options.activePlan) {
    const record = JSON.parse(
      JSON.stringify(parseAdaptivePlanRecord(toGovernanceDecisionFixturePlanMarkdown(), planPath)),
    );
    record.planId = 'receipt-neutral-plan';
    record.facts.diffBase = diffBase;
    record.facts.affectedCodeDigest = emptyDigest();
    const markdown = `# Receipt neutral plan\n\n\`\`\`plan-adaptation-v1\n${JSON.stringify(
      record,
      null,
      2,
    )}\n\`\`\`\n`;
    writeFileSync(path.join(root, planPath), markdown);
    writeFileSync(path.join(root, 'plans/README.md'), staticPlanNavigation);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-q', '-m', 'active plan']);
  }
  const parentOid = runGit(root, ['rev-parse', 'HEAD']).trim();
  const trustedBranch = runGit(root, ['branch', '--show-current']).trim();
  if (options.mergeFromFeature || options.directFeatureHead) {
    runGit(root, ['switch', '-c', 'receipt-feature']);
  }
  const request = receiptOnlyRequest(options.operation, parentOid);
  const transition = computeGovernanceDecisionTransition({
    request,
    snapshot: readGitRepositorySnapshot({ repoRoot: root, commitOid: parentOid }),
    readGateEvidence: () => failedGateEvidence(),
  });
  const receipt = createGovernanceDecisionReceipt({
    request,
    actor: { login: 'repository-admin', permission: 'admin' },
    transport: { kind: 'local-gh' },
    result: transition.result,
    bypassedInvariants: transition.bypassedInvariants,
    stateChanges: transition.stateChanges,
  });
  const receiptPath = transition.receiptPath;
  mkdirSync(path.dirname(path.join(root, receiptPath)), { recursive: true });
  writeFileSync(
    path.join(root, receiptPath),
    options.malformedReceipt ? '{malformed}\n' : serializeGovernanceDecisionReceipt(receipt),
  );
  if (options.mutatePlanInDecisionCommit) {
    writeFileSync(path.join(root, planPath), `${readFile(root, planPath)}\n`);
  }
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'receipt-only decision']);
  if (options.mergeFromFeature) {
    runGit(root, ['switch', trustedBranch]);
    runGit(root, ['commit', '--allow-empty', '-q', '-m', 'advance trusted main']);
    runGit(root, ['merge', '--no-ff', '-q', 'receipt-feature', '-m', 'merge receipt feature']);
  }
  return { root, diffBase, parentOid, planPath, receiptPath };
}

function receiptOnlyRequest(
  operation: 'gate.accept-deviation' | 'exception.decide',
  expectedHeadOid: string,
) {
  const common = {
    schemaVersion: 'governance-decision-request-v1',
    operation,
    repository: 'intact-software-systems/ar-eye-hunter',
    defaultBranch: 'main',
    expectedHeadOid,
    force: true,
    reason: 'Authenticate one receipt-only governance decision.',
  };
  if (operation === 'gate.accept-deviation') {
    return {
      ...common,
      target: {
        workflowRunId: 81,
        runAttempt: 2,
        gateName: 'Governance Gate / Governance Gate',
        candidateSha: '2'.repeat(40),
      },
      payload: {},
    };
  }
  const projection = {
    ruleId: 'topology.singleton-subtree',
    target: 'packages/example/singleton',
    owner: 'Example maintainers',
    reviewOrRemovalCondition: 'Remove when the sibling capability is added.',
  };
  return {
    ...common,
    target: {
      action: 'approve',
      exceptionKind: 'repository-structure',
      candidateHead: '2'.repeat(40),
      projectionSha256: computeSha256(
        JSON.stringify({
          owner: projection.owner,
          reviewOrRemovalCondition: projection.reviewOrRemovalCondition,
          ruleId: projection.ruleId,
          target: projection.target,
        }),
      ),
    },
    payload: { projection },
  };
}

function failedGateEvidence() {
  return {
    run: {
      id: 81,
      run_attempt: 2,
      head_sha: '2'.repeat(40),
      status: 'completed',
      conclusion: 'failure',
    },
    jobs: [
      {
        id: 91,
        run_id: 81,
        run_attempt: 2,
        head_sha: '2'.repeat(40),
        name: 'Governance Gate / Governance Gate',
        status: 'completed',
        conclusion: 'failure',
      },
    ],
  };
}

function successfulAdmissionEvidence(commitOid: string) {
  return {
    workflowRuns: [
      {
        run: {
          id: 701,
          run_attempt: 1,
          event: 'push',
          head_sha: commitOid,
          head_branch: 'main',
          path: '.github/workflows/deploy.yml',
          status: 'in_progress',
          conclusion: null,
        },
        jobs: [
          {
            id: 702,
            name: 'Classify authenticated governance decision',
            status: 'completed',
            conclusion: 'success',
            run_id: 701,
            run_attempt: 1,
            head_sha: commitOid,
            steps: [
              {
                name: 'Verify an exact decision-only commit',
                status: 'completed',
                conclusion: 'success',
              },
              {
                name: 'Resolve fail-closed governance classification',
                status: 'completed',
                conclusion: 'success',
              },
              {
                name: 'Record authenticated governance admission',
                status: 'completed',
                conclusion: 'success',
              },
            ],
          },
        ],
      },
    ],
  };
}

function readFile(root: string, repositoryPath: string): string {
  return execFileSync('git', ['show', `HEAD:${repositoryPath}`], {
    cwd: root,
    encoding: 'utf8',
  });
}

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
  writePlanPolicy(root);
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
  writeFileSync(path.join(root, 'plans/README.md'), staticPlanNavigation);
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
  writePlanPolicy(root);
  const planPath = 'plans/repair-plan.md';
  const initialMarkdown = toGovernanceDecisionFixturePlanMarkdown('HEAD');
  writeFileSync(path.join(root, planPath), initialMarkdown);
  writeFileSync(path.join(root, 'plans/README.md'), staticPlanNavigation);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'repair base']);
  const diffBase = runGit(root, ['rev-parse', 'HEAD']).trim();
  const planMarkdown = toGovernanceDecisionFixturePlanMarkdown(diffBase);
  const record = parseAdaptivePlanRecord(planMarkdown, planPath);
  writeFileSync(path.join(root, planPath), planMarkdown);
  writeFileSync(path.join(root, 'plans/README.md'), staticPlanNavigation);
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

function writePlanPolicy(root: string) {
  writeFileSync(
    path.join(root, 'plans/policy.json'),
    '{"schemaVersion":"adaptive-plan-policy-v1","maxActivePlans":8}\n',
  );
}

function runGit(root: string, arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}
