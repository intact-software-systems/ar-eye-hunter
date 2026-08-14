import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { computeBuildAffectingTreeDigest, readCurrentPlanContext } from './review-freshness.mjs';
import { isExactSha, readReviewRecordV2 } from './validate-record.mjs';

export function readValidatorInput(args) {
  const options = readOptions(args);
  if (options.event) {
    return readGitHubEventInput(options);
  }
  const required = [
    'body',
    'changed-paths',
    'registry',
    'reviews',
    'merge-base',
    'head',
    'draft',
    'pr-author',
    'plan',
  ];
  const missing = required.filter((name) => options[name] === undefined);
  if (missing.length > 0) {
    failInput(`missing required options: ${missing.join(', ')}`);
  }
  const body = readFileSync(options.body, 'utf8');
  const record = tryReadReviewRecord(body);
  if (record?.plan?.path !== undefined && record.plan.path !== options.plan) {
    failInput('review adaptive plan path must match the supplied plan evidence');
  }
  const headSha = options.head;
  const repoRoot = options['repo-root'] ?? process.cwd();
  const currentPlan = readCurrentPlanContext({
    path: options.plan,
    source: readFileSync(options.plan, 'utf8'),
  });
  return {
    repoRoot,
    body,
    changedPaths: readLines(options['changed-paths']),
    registry: readFileSync(options.registry, 'utf8'),
    trustedReviews: readTrustedReviews(options.reviews),
    mergeBaseSha: options['merge-base'],
    headSha,
    draft: parseBoolean(options.draft),
    prAuthorLogin: options['pr-author'],
    approvalHistory: readJsonOrEmpty(options['approval-history']),
    currentPlan,
    currentBuildTreeDigest: computeBuildAffectingTreeDigest({ repoRoot, headSha }),
    reviewedBuildTreeDigestBySha: readReviewedBuildTreeDigestBySha({
      repoRoot,
      record,
      currentHeadSha: headSha,
    }),
    reviewedPlanContextBySha: readReviewedPlanContextBySha({
      repoRoot,
      record,
      currentHeadSha: headSha,
    }),
  };
}

function readGitHubEventInput(options) {
  const event = readJson(options.event);
  const pullRequest = event.pull_request;
  if (!isRecord(pullRequest) || typeof pullRequest.body !== 'string') {
    failInput('GitHub event does not contain pull_request data');
  }
  const baseTipSha = pullRequest.base?.sha;
  const headSha = pullRequest.head?.sha;
  if (!isExactSha(baseTipSha) || !isExactSha(headSha) || typeof pullRequest.draft !== 'boolean') {
    failInput('GitHub event must provide exact base, head, and draft data');
  }
  const mergeBaseSha = runGit(['merge-base', baseTipSha, headSha]);
  const changedPaths = runGit(['diff', '--name-only', `${mergeBaseSha}...${headSha}`])
    .split('\n')
    .filter(Boolean);
  const approvalShas = readApprovalShas(pullRequest.body);
  const record = tryReadReviewRecord(pullRequest.body);
  const currentPlan = record?.plan?.path
    ? readCurrentPlanContext({
        path: record.plan.path,
        source: readCandidateFile(headSha, record.plan.path),
      })
    : undefined;
  const approvalHistory = Object.fromEntries(
    approvalShas.map((approvedProductionSha) => [
      approvedProductionSha,
      {
        isAncestor: runGitSuccess(['merge-base', '--is-ancestor', approvedProductionSha, headSha]),
        changedPaths: runGit(['diff', '--name-only', `${approvedProductionSha}..${headSha}`])
          .split('\n')
          .filter(Boolean),
      },
    ]),
  );
  return {
    repoRoot: process.cwd(),
    body: pullRequest.body,
    changedPaths,
    registry: readFileSync(options.registry ?? 'docs/production-legacy-exceptions.md', 'utf8'),
    trustedReviews: readTrustedReviews(options.reviews),
    mergeBaseSha,
    headSha,
    draft: pullRequest.draft,
    prAuthorLogin: pullRequest.user?.login,
    approvalHistory,
    currentPlan,
    currentBuildTreeDigest: computeBuildAffectingTreeDigest({
      repoRoot: process.cwd(),
      headSha,
    }),
    reviewedBuildTreeDigestBySha: readReviewedBuildTreeDigestBySha({
      repoRoot: process.cwd(),
      record,
      currentHeadSha: headSha,
    }),
    reviewedPlanContextBySha: readReviewedPlanContextBySha({
      repoRoot: process.cwd(),
      record,
      currentHeadSha: headSha,
    }),
  };
}

function readApprovalShas(body) {
  const record = tryReadReviewRecord(body);
  if (!record) {
    return [];
  }
  return Array.isArray(record.retainedLegacy)
    ? record.retainedLegacy.map((item) => item?.approvedProductionSha).filter(isExactSha)
    : [];
}

function tryReadReviewRecord(body) {
  try {
    return readReviewRecordV2(body);
  } catch {
    return undefined;
  }
}

function readCandidateFile(headSha, repositoryPath) {
  if (!isSafePlanPath(repositoryPath)) {
    failInput('review plan path must be a safe plans/*.md repository path');
  }
  return runGit(['show', `${headSha}:${repositoryPath}`]);
}

function readReviewedPlanContextBySha({ repoRoot, record, currentHeadSha }) {
  const reviewedHeadSha = record?.initialReview?.headSha;
  const planPath = record?.plan?.path;
  if (
    !isExactSha(reviewedHeadSha) ||
    !isSafePlanPath(planPath) ||
    !runGitSuccessAt(repoRoot, ['merge-base', '--is-ancestor', reviewedHeadSha, currentHeadSha])
  ) {
    return {};
  }
  try {
    return {
      [reviewedHeadSha]: readCurrentPlanContext({
        path: planPath,
        source: runGitAt(repoRoot, ['show', `${reviewedHeadSha}:${planPath}`]),
      }),
    };
  } catch {
    return {};
  }
}

function readReviewedBuildTreeDigestBySha({ repoRoot, record, currentHeadSha }) {
  const reviewedHeadSha = record?.finalReview?.headSha;
  if (!isExactSha(reviewedHeadSha)) {
    return {};
  }
  if (
    !runGitSuccessAt(repoRoot, ['merge-base', '--is-ancestor', reviewedHeadSha, currentHeadSha])
  ) {
    return {};
  }
  return {
    [reviewedHeadSha]: computeBuildAffectingTreeDigest({ repoRoot, headSha: reviewedHeadSha }),
  };
}

function isSafePlanPath(repositoryPath) {
  return (
    typeof repositoryPath === 'string' &&
    /^plans\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.md$/u.test(repositoryPath) &&
    !repositoryPath.includes('..') &&
    !repositoryPath.includes('//')
  );
}

function readOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      failInput('expected --name value options');
    }
    const name = option.slice(2);
    if (options[name] !== undefined) {
      failInput(`option --${name} was supplied more than once`);
    }
    options[name] = value;
  }
  return options;
}

function readLines(filePath) {
  return readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readJsonOrEmpty(filePath) {
  return filePath === undefined ? {} : readJson(filePath);
}

function readTrustedReviews(filePath) {
  const reviews = readJson(filePath);
  if (!Array.isArray(reviews)) {
    failInput('trusted GitHub reviews must be an array');
  }
  // `gh api --paginate --slurp` yields an array of response pages. Direct
  // fixture and local callers may provide the equivalent flat review array.
  const flattened = reviews.flat();
  if (!flattened.every(isRecord)) {
    failInput('trusted GitHub reviews must contain only review objects');
  }
  return flattened;
}

function runGit(args) {
  return runGitAt(process.cwd(), args);
}

function runGitAt(repoRoot, args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    failInput(`could not read Git evidence: git ${args.join(' ')}`);
  }
}

function runGitSuccess(args) {
  return runGitSuccessAt(process.cwd(), args);
}

function runGitSuccessAt(repoRoot, args) {
  try {
    execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function parseBoolean(value) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  failInput('--draft must be true or false');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failInput(message) {
  console.log(`FAIL: ${message}`);
  process.exit(2);
}
