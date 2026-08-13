#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { toCanonicalJson } from './governance-decisions/canonical-json.mjs';
import { verifyGovernanceDecisionCommit } from './governance-decisions/governance-decision-commit-verification.mjs';
import { decodeGovernanceDecisionCommand } from './governance-decisions/governance-decision-command.mjs';
import { decodeGovernanceDecisionRequest } from './governance-decisions/governance-decision-request.mjs';
import { computeGovernanceDecisionTransition } from './governance-decisions/governance-decision-transition.mjs';
import { readGitRepositorySnapshot } from './governance-decisions/git-repository-snapshot.mjs';

try {
  const command = decodeGovernanceDecisionCommand(process.argv.slice(2));
  if (['apply', 'publish-blob', 'publish-request'].includes(command.command)) {
    throw new Error(
      'trusted publication is not configured; authenticated publication belongs to Task 2',
    );
  }
  const result = command.command === 'preview' ? previewDecision(command) : verifyCommit(command);
  process.stdout.write(`${toCanonicalJson(result)}\n`);
} catch (error) {
  process.stderr.write(`${toError(error).message}\n`);
  process.exitCode = 1;
}

function previewDecision(command) {
  const request = decodeGovernanceDecisionRequest(readJson(command.requestPath));
  const snapshot = readGitRepositorySnapshot({
    repoRoot: command.repoRoot,
    commitOid: request.expectedHeadOid,
  });
  return computeGovernanceDecisionTransition({
    request,
    snapshot,
    readSnapshot: (commitOid) =>
      readGitRepositorySnapshot({ repoRoot: command.repoRoot, commitOid }),
    ...(request.operation === 'plan.supersede'
      ? {
          readBlob: (blobOid) =>
            execFileSync('git', ['cat-file', 'blob', blobOid], {
              cwd: command.repoRoot,
              encoding: 'utf8',
            }),
        }
      : {}),
  });
}

function verifyCommit(command) {
  return verifyGovernanceDecisionCommit({
    commitOid: command.commitOid,
    parentOid: command.parentOid,
    readRepositorySnapshot: (commitOid) =>
      readGitRepositorySnapshot({ repoRoot: command.repoRoot, commitOid }),
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`request file is invalid: ${toError(error).message}`);
  }
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
