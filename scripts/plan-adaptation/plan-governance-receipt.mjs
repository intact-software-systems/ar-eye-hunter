import { execFileSync } from 'node:child_process';

// prettier-ignore
import { verifyGovernanceDecisionCommit } from
  '../governance-decisions/governance-decision-commit-verification.mjs';
import { readGitRepositorySnapshot } from '../governance-decisions/git-repository-snapshot.mjs';
import { parseAdaptivePlanRecord } from './adaptive-plan-record.mjs';
import { readChangedPathsBetweenRevisions } from './plan-change-facts.mjs';

const governanceReceiptPattern = /^governance\/decisions\/[0-9a-f]{64}\.json$/u;

export function readAuthenticatedPlanGovernanceChanges(governanceInput) {
  const receiptChanges = governanceInput.changes.filter((change) =>
    governanceReceiptPattern.test(change.path),
  );
  if (receiptChanges.length === 0) {
    return {
      authenticatedPlans: [],
      authenticatedDispositions: [],
      changes: governanceInput.changes,
      issues: [],
    };
  }
  if (receiptChanges.length !== 1 || !receiptChanges[0].status.startsWith('A')) {
    return failure(governanceInput.changes, 'expected exactly one new governance receipt');
  }
  try {
    const commitOid = runGit(governanceInput.repoRoot, ['rev-parse', 'HEAD']).trim();
    const verification = verifyGovernanceDecisionCommit({
      commitOid,
      readRepositoryChanges: (baseOid, headOid) =>
        readChangedPathsBetweenRevisions(governanceInput.repoRoot, baseOid, headOid),
      readRepositorySnapshot: (revision) =>
        readGitRepositorySnapshot({ repoRoot: governanceInput.repoRoot, commitOid: revision }),
    });
    if (!verification.operation.startsWith('plan.')) {
      throw new Error('receipt does not authenticate a plan disposition');
    }
    const baseOid = runGit(governanceInput.repoRoot, [
      'rev-parse',
      '--verify',
      governanceInput.base,
    ]).trim();
    if (baseOid !== verification.receipt.request.expectedHeadOid) {
      throw new Error('comparison base does not equal the authenticated decision parent');
    }
    const authenticatedPaths = new Set([
      verification.receiptPath,
      ...verification.receipt.stateChanges.map((change) => change.path),
    ]);
    for (const authenticatedPath of authenticatedPaths) {
      if (
        !governanceInput.changes.some(
          (change) => change.path === authenticatedPath || change.oldPath === authenticatedPath,
        )
      ) {
        throw new Error(`authenticated path is absent from current changes: ${authenticatedPath}`);
      }
    }
    const worktreeStatus = runGit(governanceInput.repoRoot, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      ...authenticatedPaths,
    ]);
    if (worktreeStatus !== '') {
      throw new Error('authenticated governance paths differ from the verified commit');
    }
    return {
      authenticatedPlans: readAuthenticatedBasePlan(governanceInput, verification),
      authenticatedDispositions: [toAuthenticatedDisposition(verification)],
      changes: governanceInput.changes.filter(
        (change) => !authenticatedPaths.has(change.path) && !authenticatedPaths.has(change.oldPath),
      ),
      issues: [],
    };
  } catch (error) {
    return failure(
      governanceInput.changes,
      `governance plan disposition is not authenticated: ${toError(error).message}`,
    );
  }
}

function toAuthenticatedDisposition(verification) {
  return {
    operation: verification.operation,
    planPath: verification.receipt.request.target.planPath,
    decisionId: verification.decisionId,
  };
}

function readAuthenticatedBasePlan(governanceInput, verification) {
  try {
    const planPath = verification.receipt.request.target.planPath;
    const markdown = runGit(governanceInput.repoRoot, [
      'show',
      `${verification.receipt.request.expectedHeadOid}:${planPath}`,
    ]);
    return [{ planPath, record: parseAdaptivePlanRecord(markdown, planPath) }];
  } catch {
    return [];
  }
}

function failure(changes, issue) {
  return { authenticatedPlans: [], authenticatedDispositions: [], changes, issues: [issue] };
}

function runGit(repoRoot, arguments_) {
  return execFileSync('git', arguments_, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
