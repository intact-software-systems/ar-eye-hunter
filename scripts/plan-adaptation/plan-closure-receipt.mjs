import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  computeAdaptivePlanRecordDigest,
  parseAdaptivePlanRecord,
} from './adaptive-plan-record.mjs';
import { resolvePlansRoot } from './adaptive-plan-catalog.mjs';

const closureSchemaVersion = 'plan-adaptation-closure-v1';
const closureKeys = [
  'schemaVersion',
  'planId',
  'planPath',
  'planDigest',
  'pullRequestUrl',
  'finalReviewStatus',
];

export function createPlanClosureReceipt(closeInput) {
  const basePlan = readBasePlan(closeInput.repoRoot, closeInput.base, closeInput.planPath);
  const expectedDigest = computeAdaptivePlanRecordDigest(closeInput.record);
  if (
    !['active', 'postponed'].includes(basePlan.record.status) ||
    basePlan.record.planId !== closeInput.record.planId ||
    computeAdaptivePlanRecordDigest(basePlan.record) !== expectedDigest
  ) {
    throw new Error('close requires the comparison base to contain the exact eligible plan');
  }

  const receipt = toPlanClosureReceipt({
    planPath: closeInput.planPath,
    record: closeInput.record,
    evidence: closeInput.evidence,
  });
  const receiptPath = resolvePlanClosureReceiptPath(closeInput.repoRoot, closeInput.record.planId);
  if (pathEntryExists(receiptPath)) {
    throw new Error(
      `close receipt already exists: ${path.relative(closeInput.repoRoot, receiptPath)}`,
    );
  }
  return { path: receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n` };
}

export function readAuthenticatedPlanClosureChanges(closureInput) {
  const planDeletions = closureInput.changes.filter(
    (change) => change.status.startsWith('D') && isTacticalPlanPath(change.path),
  );
  const changedReceipts = closureInput.changes.filter((change) =>
    isPlanClosureReceiptPath(change.path),
  );
  const authenticatedPaths = new Set();
  const authenticatedPlans = [];
  const issues = [];

  for (const deletion of planDeletions) {
    try {
      const basePlan = readBasePlan(closureInput.repoRoot, closureInput.base, deletion.path);
      const receiptPath = `plans/${basePlan.record.planId}.closure.json`;
      const receiptChange = changedReceipts.find((change) => change.path === receiptPath);
      validatePlanClosureReceipt({
        repoRoot: closureInput.repoRoot,
        base: closureInput.base,
        planPath: deletion.path,
        basePlan,
        receiptPath,
        receiptChange,
      });
      authenticatedPaths.add(deletion.path);
      authenticatedPaths.add(receiptPath);
      authenticatedPlans.push(basePlan);
    } catch (error) {
      issues.push(`${deletion.path} close-out is not authenticated: ${toError(error).message}`);
    }
  }

  for (const receiptChange of changedReceipts) {
    if (!authenticatedPaths.has(receiptChange.path)) {
      issues.push(`${receiptChange.path} does not authenticate a deleted eligible plan`);
    }
  }

  return {
    authenticatedPlans,
    changes: closureInput.changes.filter((change) => !authenticatedPaths.has(change.path)),
    issues,
  };
}

function validatePlanClosureReceipt(receiptInput) {
  if (!receiptInput.receiptChange?.status.startsWith('A')) {
    throw new Error(`expected a new ${receiptInput.receiptPath} receipt`);
  }
  if (!['active', 'postponed'].includes(receiptInput.basePlan.record.status)) {
    throw new Error('comparison base plan must be active or postponed');
  }
  const absoluteReceiptPath = path.join(receiptInput.repoRoot, receiptInput.receiptPath);
  const stat = lstatSync(absoluteReceiptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${receiptInput.receiptPath} must be a regular non-symbolic-link file`);
  }
  const { receipt, content } = readPlanClosureReceipt(
    absoluteReceiptPath,
    receiptInput.receiptPath,
  );
  const expected = toPlanClosureReceipt({
    planPath: receiptInput.planPath,
    record: receiptInput.basePlan.record,
    evidence: {
      pullRequestUrl: receipt.pullRequestUrl,
      finalReview: {
        status: receipt.finalReviewStatus,
        planDigest: receipt.planDigest,
      },
    },
  });
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error(`${receiptInput.receiptPath} does not match the deleted base plan`);
  }
  if (content !== `${JSON.stringify(expected, null, 2)}\n`) {
    throw new Error(`${receiptInput.receiptPath} must use canonical closure v1 serialization`);
  }
}

function readPlanClosureReceipt(absolutePath, relativePath) {
  const content = readFileSync(absolutePath, 'utf8');
  let receipt;
  try {
    receipt = JSON.parse(content);
  } catch (error) {
    throw new Error(`${relativePath} is invalid JSON: ${toError(error).message}`);
  }
  if (
    !isPlainObject(receipt) ||
    JSON.stringify(Object.keys(receipt)) !== JSON.stringify(closureKeys)
  ) {
    throw new Error(`${relativePath} must contain exactly the closure v1 fields`);
  }
  if (receipt.finalReviewStatus !== 'complete') {
    throw new Error(`${relativePath} must record a completed final review`);
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/u.test(receipt.pullRequestUrl)) {
    throw new Error(`${relativePath} must identify a GitHub pull request`);
  }
  return { receipt, content };
}

function toPlanClosureReceipt(receiptInput) {
  return {
    schemaVersion: closureSchemaVersion,
    planId: receiptInput.record.planId,
    planPath: receiptInput.planPath,
    planDigest: computeAdaptivePlanRecordDigest(receiptInput.record),
    pullRequestUrl: receiptInput.evidence.pullRequestUrl,
    finalReviewStatus: receiptInput.evidence.finalReview.status,
  };
}

function readBasePlan(repoRoot, base, planPath) {
  if (!isTacticalPlanPath(planPath)) {
    throw new Error('closure plan path must identify a direct plans/*.md tactical plan');
  }
  const markdown = readGitFile(repoRoot, base, planPath);
  return { planPath, record: parseAdaptivePlanRecord(markdown, planPath) };
}

function readGitFile(repoRoot, revision, relativePath) {
  try {
    return runGit(repoRoot, ['show', `${revision}:${relativePath}`]);
  } catch (error) {
    throw new Error(`comparison base does not contain ${relativePath}: ${toError(error).message}`);
  }
}

function runGit(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolvePlanClosureReceiptPath(repoRoot, planId) {
  if (typeof planId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(planId)) {
    throw new Error('close receipt plan ID must use lowercase letters, digits, and single hyphens');
  }
  return path.join(resolvePlansRoot(repoRoot), `${planId}.closure.json`);
}

function isTacticalPlanPath(value) {
  return (
    typeof value === 'string' &&
    /^plans\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(value) &&
    value !== 'plans/README.md'
  );
}

export function isPlanClosureReceiptPath(value) {
  return (
    typeof value === 'string' && /^plans\/[a-z0-9]+(?:-[a-z0-9]+)*\.closure\.json$/u.test(value)
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathEntryExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
