const pullRequestFields = [
  'number',
  'url',
  'state',
  'mergedAt',
  'isDraft',
  'baseRefName',
  'mergeable',
  'mergeStateStatus',
  'statusCheckRollup',
  'reviewDecision',
  'autoMergeRequest',
];

const failingCheckConclusions = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);

export function readPullRequest({ execFile, defaultBranch }) {
  let pullRequest;
  try {
    pullRequest = JSON.parse(
      execFile('gh', ['pr', 'view', '--json', pullRequestFields.join(',')], {
        encoding: 'utf8',
      }),
    );
  } catch (error) {
    if (isMissingPullRequest(error)) {
      return undefined;
    }
    throw error;
  }

  const resolvedDefaultBranch = defaultBranch ?? readDefaultBranch(execFile);
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    state: pullRequest.state,
    merged: pullRequest.mergedAt !== null,
    isDraft: pullRequest.isDraft,
    baseRefName: pullRequest.baseRefName,
    defaultBranch: resolvedDefaultBranch,
    mergeable: pullRequest.mergeable,
    mergeStateStatus: pullRequest.mergeStateStatus,
    checks: toCheckState(pullRequest.statusCheckRollup),
    reviewDecision: pullRequest.reviewDecision,
    autoMergeArmed: pullRequest.autoMergeRequest !== null,
  };
}

function readDefaultBranch(execFile) {
  const repository = JSON.parse(
    execFile('gh', ['repo', 'view', '--json', 'defaultBranchRef'], {
      encoding: 'utf8',
    }),
  );
  return repository.defaultBranchRef.name;
}

function toCheckState(statusCheckRollup) {
  if (statusCheckRollup.some(isFailingCheck)) {
    return 'FAILING';
  }
  if (statusCheckRollup.some(isPendingCheck)) {
    return 'PENDING';
  }
  return 'PASSING';
}

function isFailingCheck(check) {
  if (check.__typename === 'StatusContext') {
    return check.state === 'ERROR' || check.state === 'FAILURE';
  }
  return failingCheckConclusions.has(check.conclusion);
}

function isPendingCheck(check) {
  if (check.__typename === 'StatusContext') {
    return check.state === 'EXPECTED' || check.state === 'PENDING';
  }
  return check.status !== 'COMPLETED' || check.conclusion === '' || check.conclusion === null;
}

function isMissingPullRequest(error) {
  return /no pull requests found for branch/i.test(toCommandErrorMessage(error));
}

export function toCommandErrorMessage(error) {
  if (typeof error?.stderr === 'string' && error.stderr.trim() !== '') {
    return error.stderr.trim();
  }
  if (Buffer.isBuffer(error?.stderr)) {
    return error.stderr.toString('utf8').trim();
  }
  return error instanceof Error ? error.message : String(error);
}
