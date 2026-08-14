import { execFileSync, spawnSync } from 'node:child_process';

import { readChangedPathsBetweenRevisions } from '../plan-adaptation/plan-change-facts.mjs';
import { verifyGovernanceDecisionCommit } from './governance-decision-commit-verification.mjs';
import { decodeGovernanceDecisionReceipt } from './governance-decision-receipt.mjs';
// prettier-ignore
import { verifyHistoricalGovernanceDecisionCommit } from
  './governance-decision-remote-verification.mjs';
import { readGitRepositorySnapshot } from './git-repository-snapshot.mjs';
import { createGitHubGovernanceApi } from './github-governance-api.mjs';
// prettier-ignore
import { verifyGovernanceDecisionAdmission } from
  './governance-decision-admission-verification.mjs';

const receiptPathPattern = /^governance\/decisions\/([0-9a-f]{64})\.json$/u;
const gitObjectIdPattern = /^[0-9a-f]{40}$/u;

export function readTrustedGovernanceDecisionIndex(input) {
  if (!gitObjectIdPattern.test(input.trustedRevision ?? '')) {
    throw new Error('trusted governance revision must be a full Git object ID');
  }
  const remoteMain = runGit(input.root, [
    'rev-parse',
    '--verify',
    'refs/remotes/origin/main^{commit}',
  ]).trim();
  if (
    remoteMain === '' ||
    !runGitSuccess(input.root, ['merge-base', '--is-ancestor', input.trustedRevision, remoteMain])
  ) {
    throw new Error('trusted governance revision must belong to origin/main history');
  }
  const trustedMainCommits = runGit(input.root, [
    'rev-list',
    '--first-parent',
    '--reverse',
    input.trustedRevision,
  ])
    .split('\n')
    .filter(Boolean);
  const trustedMainCommitSet = new Set(trustedMainCommits);
  const commitOrder = new Map(trustedMainCommits.map((commitOid, index) => [commitOid, index]));
  const issues = [];
  const entries = readTrustedReceiptEntries(input.root, input.trustedRevision);
  const paths = readHistoricalReceiptPaths(input.root, input.trustedRevision);
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entryPath of paths) {
    const entry = entryByPath.get(entryPath);
    if (entry === undefined) {
      issues.push(`${entryPath} immutable receipt path changed after creation`);
      continue;
    }
    const history = readReceiptHistory(input.root, input.trustedRevision, entryPath);
    if (history.length !== 1 || history[0].status !== 'A') {
      issues.push(`${entryPath} immutable receipt path changed after creation`);
      entryByPath.delete(entryPath);
    }
  }
  for (const entry of entries) {
    if (!entryByPath.has(entry.path)) {
      continue;
    }
    if (!receiptPathPattern.test(entry.path)) {
      issues.push(`${entry.path} is not a canonical immutable receipt path`);
    } else if (entry.mode !== '100644' || entry.type !== 'blob') {
      issues.push(`${entry.path} must be a regular non-executable Git blob`);
    }
  }
  const evidence = entries
    .filter(
      (entry) =>
        entryByPath.has(entry.path) &&
        receiptPathPattern.test(entry.path) &&
        entry.mode === '100644' &&
        entry.type === 'blob',
    )
    .flatMap((entry) => {
      const entryPath = entry.path;
      try {
        const receiptEvidence = readTrustedReceiptEvidence(input, entryPath);
        if (!trustedMainCommitSet.has(receiptEvidence.commitOid)) {
          throw new Error('adding commit is not on the trusted main first-parent lineage');
        }
        if (typeof input.verifyDecisionCommit !== 'function') {
          throw new Error('trusted governance index requires commit provenance verification');
        }
        const verified = input.verifyDecisionCommit({
          commitOid: receiptEvidence.commitOid,
          decisionId: receiptEvidence.decisionId,
        });
        if (
          verified?.commitOid !== receiptEvidence.commitOid ||
          verified.decisionId !== receiptEvidence.decisionId
        ) {
          throw new Error('commit provenance verification returned mismatched evidence');
        }
        if (typeof input.verifyDecisionAdmission !== 'function') {
          throw new Error('trusted governance index requires authenticated admission evidence');
        }
        const admitted = input.verifyDecisionAdmission({
          commitOid: receiptEvidence.commitOid,
          decisionId: receiptEvidence.decisionId,
        });
        if (
          admitted?.commitOid !== receiptEvidence.commitOid ||
          admitted.decisionId !== receiptEvidence.decisionId
        ) {
          throw new Error('authenticated admission returned mismatched decision evidence');
        }
        return [receiptEvidence];
      } catch (error) {
        issues.push(`${entryPath} ${toError(error).message}`);
        return [];
      }
    })
    .sort(
      (left, right) =>
        (commitOrder.get(left.commitOid) ?? Number.MAX_SAFE_INTEGER) -
        (commitOrder.get(right.commitOid) ?? Number.MAX_SAFE_INTEGER),
    );
  const indexed = indexGovernanceDecisionReceipts(evidence);
  return { ...indexed, issues: [...issues, ...indexed.issues].sort(compareText) };
}

function readHistoricalReceiptPaths(root, trustedRevision) {
  return [
    ...new Set(
      runGit(root, [
        'log',
        '--format=',
        '--name-only',
        trustedRevision,
        '--',
        'governance/decisions',
      ])
        .split('\n')
        .filter(Boolean),
    ),
  ].sort(compareText);
}

function readReceiptHistory(root, trustedRevision, entryPath) {
  return runGit(root, ['log', '--format=', '--name-status', trustedRevision, '--', entryPath])
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.split('\t')[0], line }));
}

function readTrustedReceiptEntries(root, trustedRevision) {
  return runGit(root, ['ls-tree', '-r', trustedRevision, 'governance/decisions'])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/u.exec(line);
      if (match === null) {
        throw new Error('trusted governance receipt tree contains unreadable entries');
      }
      return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
    });
}

export function readOriginMainGovernanceDecisionIndex(root) {
  const resolved = spawnSync(
    'git',
    ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
    { cwd: root, encoding: 'utf8' },
  );
  if (resolved.status !== 0 || !gitObjectIdPattern.test(resolved.stdout.trim())) {
    return indexGovernanceDecisionReceipts([]);
  }
  const github = createGitHubGovernanceApi(root);
  return readTrustedGovernanceDecisionIndex({
    root,
    trustedRevision: resolved.stdout.trim(),
    verifyDecisionCommit: ({ commitOid, decisionId }) => {
      const structuralVerification = verifyGovernanceDecisionCommit({
        commitOid,
        readRepositoryChanges: (baseOid, headOid) =>
          readChangedPathsBetweenRevisions(root, baseOid, headOid),
        readRepositorySnapshot: (revision) =>
          readGitRepositorySnapshot({ repoRoot: root, commitOid: revision }),
        readGateEvidence: github.readGateEvidence,
      });
      const historicalVerification = verifyHistoricalGovernanceDecisionCommit({
        commitOid,
        structuralVerification,
        appSlug: process.env.GOVERNANCE_APP_SLUG,
        readCommit: github.readCommit,
        readWorkflowRun: github.readWorkflowRun,
      });
      if (historicalVerification.decisionId !== decisionId) {
        throw new Error('verified decision does not match the indexed receipt');
      }
      return { commitOid, decisionId };
    },
    verifyDecisionAdmission: ({ commitOid, decisionId }) =>
      verifyGovernanceDecisionAdmission({
        commitOid,
        decisionId,
        evidence: github.readDecisionAdmissionEvidence(commitOid),
      }),
  });
}

export function indexGovernanceDecisionReceipts(receiptEvidence) {
  const decisions = [];
  const issues = [];
  const evidenceByDecisionId = new Map();
  const duplicateDecisionIds = new Set();
  for (const [index, evidence] of receiptEvidence.entries()) {
    try {
      const indexed = toIndexedDecision(evidence, index);
      if (evidenceByDecisionId.has(indexed.decisionId)) {
        duplicateDecisionIds.add(indexed.decisionId);
      } else {
        evidenceByDecisionId.set(indexed.decisionId, indexed);
      }
      decisions.push(indexed);
    } catch (error) {
      issues.push(`governance receipt[${index}] ${toError(error).message}`);
    }
  }
  for (const decisionId of [...duplicateDecisionIds].sort(compareText)) {
    issues.push(`duplicate governance decision ID: ${decisionId}`);
  }
  return {
    decisions,
    duplicateDecisionIds,
    issues: issues.sort(compareText),
  };
}

export function resolveGovernanceExceptionDecisions(index, selector) {
  const activeApprovals = new Map();
  for (const decision of index.decisions) {
    if (index.duplicateDecisionIds.has(decision.decisionId)) {
      continue;
    }
    const { request } = decision.receipt;
    if (request.operation !== 'exception.decide') {
      continue;
    }
    if (request.target.action === 'revoke') {
      activeApprovals.delete(request.target.priorDecisionId);
      continue;
    }
    activeApprovals.set(decision.decisionId, decision);
  }
  return [...activeApprovals.values()]
    .filter(
      (decision) =>
        decision.receipt.request.target.exceptionKind === selector.exceptionKind &&
        decision.receipt.request.target.candidateHead === selector.candidateHead,
    )
    .map((decision) => ({
      decisionId: decision.decisionId,
      projection: decision.receipt.request.payload.projection,
    }));
}

export function resolveGovernanceGateDeviations(index, selector) {
  return index.decisions
    .filter(
      (decision) =>
        !index.duplicateDecisionIds.has(decision.decisionId) &&
        decision.receipt.request.operation === 'gate.accept-deviation' &&
        decision.receipt.request.target.candidateSha === selector.candidateSha &&
        decision.receipt.request.target.gateName === selector.gateName,
    )
    .map((decision) => ({
      decisionId: decision.decisionId,
      workflowRunId: decision.receipt.request.target.workflowRunId,
      runAttempt: decision.receipt.request.target.runAttempt,
      gateName: decision.receipt.request.target.gateName,
      candidateSha: decision.receipt.request.target.candidateSha,
      status: decision.receipt.result.status,
      underlyingStatus: decision.receipt.result.underlyingStatus,
    }));
}

function toIndexedDecision(evidence, index) {
  requireExactKeys(
    evidence,
    ['decisionId', 'path', 'commitOid', 'content'],
    `governance receipt[${index}] evidence`,
  );
  if (!gitObjectIdPattern.test(evidence.commitOid)) {
    throw new Error('commitOid must be a full Git object ID');
  }
  const pathDecisionId = receiptPathPattern.exec(evidence.path)?.[1];
  if (pathDecisionId === undefined || pathDecisionId !== evidence.decisionId) {
    throw new Error('path must equal the declared immutable decision path');
  }
  const receipt = decodeGovernanceDecisionReceipt(evidence.content);
  if (receipt.decisionId !== evidence.decisionId) {
    throw new Error('receipt decision ID must equal its immutable path');
  }
  return { ...evidence, receipt };
}

function requireExactKeys(value, expectedKeys, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} must contain exactly: ${expectedKeys.join(', ')}`);
  }
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function readTrustedReceiptEvidence(input, entryPath) {
  const addingCommits = runGit(input.root, [
    'log',
    '--format=%H',
    '--diff-filter=A',
    input.trustedRevision,
    '--',
    entryPath,
  ])
    .split('\n')
    .filter(Boolean);
  if (addingCommits.length !== 1) {
    throw new Error(`trusted governance receipt must have one adding commit: ${entryPath}`);
  }
  const decisionId = receiptPathPattern.exec(entryPath)[1];
  return {
    decisionId,
    path: entryPath,
    commitOid: addingCommits[0],
    content: runGit(input.root, ['show', `${input.trustedRevision}:${entryPath}`]),
  };
}

function runGit(root, arguments_) {
  return execFileSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGitSuccess(root, arguments_) {
  return spawnSync('git', arguments_, { cwd: root, stdio: 'ignore' }).status === 0;
}
