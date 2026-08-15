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
const requiredCheckName = 'Branch Release Gate result';

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
  const requiredChecks = statusCheckRollup.filter(isRequiredCheck);
  if (requiredChecks.length === 0) {
    return 'PENDING';
  }
  const requiredCheck = requiredChecks.reduce(newestCheck);
  if (isFailingCheck(requiredCheck)) {
    return 'FAILING';
  }
  if (isPendingCheck(requiredCheck)) {
    return 'PENDING';
  }
  return 'PASSING';
}

function newestCheck(current, candidate) {
  return (candidate.startedAt ?? '') > (current.startedAt ?? '') ? candidate : current;
}

function isRequiredCheck(check) {
  return check.__typename === 'StatusContext'
    ? check.context === requiredCheckName
    : check.name === requiredCheckName;
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
