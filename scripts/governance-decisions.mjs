#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { toCanonicalJson } from './governance-decisions/canonical-json.mjs';
// prettier-ignore
import { verifyGovernanceDecisionCommit } from
  './governance-decisions/governance-decision-commit-verification.mjs';
// prettier-ignore
import { decodeGovernanceDecisionCommand } from
  './governance-decisions/governance-decision-command.mjs';
import {
  createGovernanceDecisionReceipt,
  serializeGovernanceDecisionReceipt,
} from './governance-decisions/governance-decision-receipt.mjs';
import {
  trustedGovernanceAppSlug,
  verifyPublishedGovernanceDecisionCommit,
} from './governance-decisions/governance-decision-remote-verification.mjs';
// prettier-ignore
import { decodeGovernanceDecisionRequest } from
  './governance-decisions/governance-decision-request.mjs';
// prettier-ignore
import { computeGovernanceDecisionTransition } from
  './governance-decisions/governance-decision-transition.mjs';
import { createGitHubGovernanceApi } from './governance-decisions/github-governance-api.mjs';
import {
  authenticateGitHubAdministrator,
  authenticateRecordedGitHubAdministrator,
  publishGovernanceDecisionCommit,
  publishImmutableGitBlob,
  validateLocalGovernancePublicationState,
} from './governance-decisions/github-governance-publication.mjs';
import { readGitRepositorySnapshot } from './governance-decisions/git-repository-snapshot.mjs';
import { readChangedPathsBetweenRevisions } from './plan-adaptation/plan-change-facts.mjs';

try {
  const command = decodeGovernanceDecisionCommand(process.argv.slice(2));
  const result = runCommand(command);
  process.stdout.write(`${toCanonicalJson(result)}\n`);
} catch (error) {
  process.stderr.write(`${toError(error).message}\n`);
  process.exitCode = 1;
}

function runCommand(command) {
  if (command.command === 'preview') {
    return previewDecision(command);
  }
  if (command.command === 'apply') {
    return applyDecision(command);
  }
  if (command.command === 'publish-blob') {
    return publishBlob(command);
  }
  if (command.command === 'publish-request') {
    return publishRequest(command);
  }
  return verifyCommit(command);
}

function previewDecision(command) {
  const request = decodeGovernanceDecisionRequest(readJson(command.requestPath));
  const github = createGitHubGovernanceApi(command.repoRoot);
  const snapshot = readGitRepositorySnapshot({
    repoRoot: command.repoRoot,
    commitOid: request.expectedHeadOid,
  });
  return computeGovernanceDecisionTransition({
    request,
    snapshot,
    readChanges: (baseOid, headOid) =>
      readChangedPathsBetweenRevisions(command.repoRoot, baseOid, headOid),
    readSnapshot: (commitOid) =>
      readGitRepositorySnapshot({ repoRoot: command.repoRoot, commitOid }),
    ...(request.operation === 'plan.supersede'
      ? {
          readBlob: github.readBlob,
        }
      : {}),
  });
}

function verifyCommit(command) {
  const structuralVerification = verifyGovernanceDecisionCommit({
    commitOid: command.commitOid,
    readRepositoryChanges: (baseOid, headOid) =>
      readChangedPathsBetweenRevisions(command.repoRoot, baseOid, headOid),
    readRepositorySnapshot: (commitOid) =>
      readGitRepositorySnapshot({ repoRoot: command.repoRoot, commitOid }),
  });
  const github = createGitHubGovernanceApi(command.repoRoot);
  return verifyPublishedGovernanceDecisionCommit({
    commitOid: command.commitOid,
    structuralVerification,
    appSlug: process.env.GOVERNANCE_APP_SLUG,
    readCommit: github.readCommit,
    readWorkflowRun: github.readWorkflowRun,
    readPermission: github.readPermission,
  });
}

function applyDecision(command) {
  const request = decodeGovernanceDecisionRequest(readJson(command.requestPath));
  const github = createGitHubGovernanceApi(command.repoRoot);
  const publicationIdentity = readPublicationIdentity(github);
  validateLocalGovernancePublicationState({
    request,
    readCheckoutState: () => readCheckoutState(command.repoRoot, github),
  });
  const transition = previewDecision(command);
  const receipt = createGovernanceDecisionReceipt({
    request,
    actor: publicationIdentity.actor,
    transport: publicationIdentity.transport,
    result: transition.result,
    bypassedInvariants: transition.bypassedInvariants,
    stateChanges: transition.stateChanges,
  });
  return publishGovernanceDecisionCommit({
    expectedHeadOid: request.expectedHeadOid,
    operation: request.operation,
    decisionId: transition.decisionId,
    additions: [
      ...transition.additions,
      { path: transition.receiptPath, content: serializeGovernanceDecisionReceipt(receipt) },
    ],
    deletions: transition.deletions,
    writeCommit: github.writeCommit,
  });
}

function publishBlob(command) {
  const github = createGitHubGovernanceApi(command.repoRoot);
  authenticateGitHubAdministrator(github);
  return publishImmutableGitBlob({
    bytes: readFileSync(command.path),
    writeBlob: github.writeBlob,
  });
}

function publishRequest(command) {
  const github = createGitHubGovernanceApi(command.repoRoot);
  authenticateGitHubAdministrator(github);
  const request = decodeGovernanceDecisionRequest(readJson(command.requestPath));
  return publishImmutableGitBlob({
    bytes: Buffer.from(toCanonicalJson(request)),
    writeBlob: github.writeBlob,
  });
}

function readPublicationIdentity(github) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return {
      actor: authenticateGitHubAdministrator(github),
      transport: { kind: 'local-gh' },
    };
  }
  const expectedWorkflowRef =
    'intact-software-systems/ar-eye-hunter/' +
    '.github/workflows/governance-decision.yml@refs/heads/main';
  if (
    process.env.GITHUB_REPOSITORY !== 'intact-software-systems/ar-eye-hunter' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_WORKFLOW_REF !== expectedWorkflowRef ||
    process.env.GITHUB_WORKFLOW_SHA !== process.env.GITHUB_SHA ||
    process.env.GOVERNANCE_PREFLIGHT_ACTOR !== process.env.GITHUB_ACTOR ||
    process.env.GOVERNANCE_PREFLIGHT_SHA !== process.env.GITHUB_SHA ||
    process.env.GOVERNANCE_PREFLIGHT_WORKFLOW_REF !== process.env.GITHUB_WORKFLOW_REF ||
    process.env.GOVERNANCE_APP_SLUG !== trustedGovernanceAppSlug ||
    !/^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? '') ||
    typeof process.env.GITHUB_ACTOR !== 'string' ||
    process.env.GITHUB_ACTOR.trim() === ''
  ) {
    throw new Error('workflow publication requires the exact trusted main workflow identity');
  }
  return {
    actor: authenticateRecordedGitHubAdministrator({
      login: process.env.GITHUB_ACTOR,
      readPermission: github.readPermission,
    }),
    transport: {
      kind: 'workflow-dispatch',
      runId: toPositiveInteger(process.env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
      runAttempt: toPositiveInteger(process.env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    },
  };
}

function readCheckoutState(repoRoot, github) {
  const remoteMain = github.readRemoteMain();
  return {
    headOid: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
    remoteMainOid: remoteMain?.object?.sha,
    status: runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
  };
}

function runGit(repoRoot, arguments_) {
  return execFileSync('git', arguments_, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function toPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
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
