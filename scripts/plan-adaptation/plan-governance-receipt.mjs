import { execFileSync } from 'node:child_process';

import { verifyGovernanceDecisionCommit } from '../governance-decisions/governance-decision-commit-verification.mjs';
import { createGitHubGovernanceApi } from '../governance-decisions/github-governance-api.mjs';
import { verifyGovernanceDecisionAdmission } from '../governance-decisions/governance-decision-admission-verification.mjs';
import { readGitRepositorySnapshot } from '../governance-decisions/git-repository-snapshot.mjs';
import { readChangedPathsBetweenRevisions } from '../repository-changes/read-git-changes.mjs';
import { parseAdaptivePlanRecord } from './adaptive-plan-record.mjs';

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
    const receiptPath = receiptChanges[0].path;
    const commitOid = readReceiptAddingCommit(governanceInput, receiptPath);
    const github = createGitHubGovernanceApi(governanceInput.repoRoot);
    const verification = verifyGovernanceDecisionCommit({
      commitOid,
      readRepositoryChanges: (baseOid, headOid) =>
        readChangedPathsBetweenRevisions(governanceInput.repoRoot, baseOid, headOid),
      readRepositorySnapshot: (revision) =>
        readGitRepositorySnapshot({ repoRoot: governanceInput.repoRoot, commitOid: revision }),
      readGateEvidence: governanceInput.readGateEvidence ?? github.readGateEvidence,
    });
    verifyGovernanceDecisionAdmission({
      commitOid,
      decisionId: verification.decisionId,
      evidence: (
        governanceInput.readDecisionAdmissionEvidence ?? github.readDecisionAdmissionEvidence
      )(commitOid),
    });
    requireReceiptUnchanged(governanceInput, verification.receiptPath, commitOid);
    if (!verification.operation.startsWith('plan.')) {
      return readAuthenticatedNonPlanDecision(governanceInput, verification);
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
      `governance decision is not authenticated: ${toError(error).message}`,
    );
  }
}

function readAuthenticatedNonPlanDecision(governanceInput, verification) {
  if (!['gate.accept-deviation', 'exception.decide'].includes(verification.operation)) {
    throw new Error('receipt operation is not a plan-neutral governance decision');
  }
  if (verification.receipt.stateChanges.length !== 0) {
    throw new Error('plan-neutral governance decisions cannot declare state changes');
  }
  if (
    !governanceInput.changes.some(
      (change) =>
        change.path === verification.receiptPath || change.oldPath === verification.receiptPath,
    )
  ) {
    throw new Error(
      `authenticated path is absent from current changes: ${verification.receiptPath}`,
    );
  }
  return {
    authenticatedPlans: [],
    authenticatedDispositions: [],
    changes: governanceInput.changes.filter(
      (change) =>
        change.path !== verification.receiptPath && change.oldPath !== verification.receiptPath,
    ),
    issues: [],
  };
}

function readReceiptAddingCommit(governanceInput, receiptPath) {
  const addingCommits = runGit(governanceInput.repoRoot, [
    'log',
    '--format=%H',
    '--diff-filter=A',
    'HEAD',
    '--',
    receiptPath,
  ])
    .split('\n')
    .filter(Boolean);
  if (addingCommits.length !== 1) {
    throw new Error('governance receipt must have exactly one adding commit');
  }
  const baseOid = runGit(governanceInput.repoRoot, [
    'rev-parse',
    '--verify',
    governanceInput.base,
  ]).trim();
  const addingCommit = addingCommits[0];
  const trustedMainCommits = new Set(
    runGit(governanceInput.repoRoot, ['rev-list', '--first-parent', 'HEAD'])
      .split('\n')
      .filter(Boolean),
  );
  if (!trustedMainCommits.has(addingCommit)) {
    throw new Error('adding commit is not on the trusted main first-parent lineage');
  }
  const ancestry = runGitStatus(governanceInput.repoRoot, [
    'merge-base',
    '--is-ancestor',
    baseOid,
    addingCommit,
  ]);
  if (ancestry !== 0 && baseOid !== addingCommit) {
    throw new Error('governance receipt adding commit is outside the compared history');
  }
  return addingCommit;
}

function requireReceiptUnchanged(governanceInput, receiptPath, addingCommit) {
  if (
    runGitStatus(governanceInput.repoRoot, [
      'diff',
      '--quiet',
      addingCommit,
      'HEAD',
      '--',
      receiptPath,
    ]) !== 0
  ) {
    throw new Error('governance receipt changed after its authenticated commit');
  }
  const worktreeStatus = runGit(governanceInput.repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    receiptPath,
  ]);
  if (worktreeStatus !== '') {
    throw new Error('governance receipt differs from its authenticated commit');
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

function runGitStatus(repoRoot, arguments_) {
  try {
    execFileSync('git', arguments_, {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return 0;
  } catch (error) {
    return typeof error?.status === 'number' ? error.status : 1;
  }
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
