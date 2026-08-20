#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { deriveDeliveryAction } from './pull-request-delivery/derive-delivery-action.mjs';
import {
  readPullRequest,
  toCommandErrorMessage,
} from './pull-request-delivery/read-pull-request.mjs';
import {
  armPullRequestAutoMerge,
  markPullRequestReady,
} from './pull-request-delivery/ready-pull-request.mjs';

const mutationBlockedActions = new Set([
  'OPEN_DRAFT',
  'STOP_CLOSED',
  'DONE',
  'STOP_WRONG_BASE',
  'WAIT_GITHUB',
  'REPAIR_CONFLICT',
  'REPAIR_CHECK',
  'AWAIT_REVIEW_OR_ADMIN_MERGE',
]);

if (isDirectExecution()) {
  try {
    await runPullRequestDeliveryCommand(process.argv.slice(2), {
      execFile: execFileSync,
      writeOutput: console.log,
      writeError: console.error,
    });
  } catch (error) {
    console.error(`FAIL: pull request delivery: ${toCommandErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

export async function runPullRequestDeliveryCommand(arguments_, dependencies) {
  const operation = readOperation(arguments_);
  if (operation === 'help') {
    printHelp(dependencies.writeOutput);
    return 'HELP';
  }

  let pullRequest = readPullRequest({ execFile: dependencies.execFile });
  let action = deriveDeliveryAction(pullRequest);
  if (operation === 'status' || mutationBlockedActions.has(action)) {
    printDeliveryStatus(pullRequest, action, dependencies.writeOutput);
    return action;
  }

  if (pullRequest.isDraft) {
    markPullRequestReady(dependencies.execFile);
    pullRequest = readPullRequest({
      execFile: dependencies.execFile,
      defaultBranch: pullRequest.defaultBranch,
    });
    action = deriveDeliveryAction(pullRequest);
  }

  if (
    !mutationBlockedActions.has(action) &&
    pullRequest.reviewDecision === 'APPROVED' &&
    !pullRequest.autoMergeArmed
  ) {
    try {
      armPullRequestAutoMerge(dependencies.execFile);
    } catch (error) {
      dependencies.writeError(toCommandErrorMessage(error));
      action = 'AWAIT_REVIEW_OR_ADMIN_MERGE';
      printDeliveryStatus(pullRequest, action, dependencies.writeOutput);
      return action;
    }
    pullRequest = readPullRequest({
      execFile: dependencies.execFile,
      defaultBranch: pullRequest.defaultBranch,
    });
    action = deriveDeliveryAction(pullRequest);
  }

  printDeliveryStatus(pullRequest, action, dependencies.writeOutput);
  return action;
}

function readOperation(arguments_) {
  if (arguments_.length === 1 && (arguments_[0] === '--help' || arguments_[0] === '-h')) {
    return 'help';
  }
  if (arguments_.length === 1 && (arguments_[0] === 'status' || arguments_[0] === 'ready')) {
    return arguments_[0];
  }
  throw new Error('usage: npm run pr:delivery -- <status|ready>');
}

function printHelp(writeOutput) {
  writeOutput('Usage: npm run pr:delivery -- <status|ready>');
  writeOutput('  status  Read the current pull request and report the next action.');
  writeOutput('  ready   Mark a draft ready and arm native auto-merge after approval.');
}

function printDeliveryStatus(pullRequest, action, writeOutput) {
  if (pullRequest !== undefined) {
    writeOutput(`PR #${pullRequest.number} ${pullRequest.url}`);
  }
  writeOutput(`Action: ${action}`);

  const detail = readActionDetail(action, pullRequest);
  if (detail !== undefined) {
    writeOutput(detail);
  }
}

function readActionDetail(action, pullRequest) {
  switch (action) {
    case 'OPEN_DRAFT':
      return 'Next: Publish a coherent commit and open one draft pull request.';
    case 'WORK':
      return 'Next: Continue the requested implementation in this draft pull request.';
    case 'STOP_CLOSED':
      return 'Blocker: The pull request is closed without merge.';
    case 'DONE':
      return (
        'Terminal: GitHub reports this pull request merged; ' + 'no governance action is permitted.'
      );
    case 'STOP_WRONG_BASE':
      return 'Blocker: The pull request does not target the repository default branch.';
    case 'WAIT_GITHUB':
      return 'Blocker: GitHub is still calculating pull request mergeability.';
    case 'REPAIR_CONFLICT':
      return 'Blocker: Resolve the real source conflict before validation or governance work.';
    case 'REPAIR_CHECK':
      return 'Blocker: Diagnose the failing pull request check.';
    case 'WAIT_CI':
      return 'Blocker: Required pull request checks are still running.';
    case 'AWAIT_REVIEW_OR_ADMIN_MERGE':
      return pullRequest?.autoMergeArmed
        ? 'Next: Await native review, or disable PR auto-merge before an intentional ' +
            'administrator merge.'
        : 'Next: Await native review or merge intentionally through GitHub as an administrator.';
    case 'ARM_AUTO_MERGE':
      return 'Next: Arm native auto-merge.';
    case 'WAIT_MERGE':
      return 'Next: GitHub owns the merge; wait without creating governance work.';
    default:
      return undefined;
  }
}

function isDirectExecution() {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
}
