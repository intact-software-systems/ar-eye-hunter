import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const exceptionRegistryPath = 'docs/repo-structure-exceptions.json';
const authorizedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const substantiveReviewStates = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const exactShaPattern = /^[a-f0-9]{40}$/u;

export function readStructureExceptions(repoRoot, dependencies = {}) {
  const absolutePath = resolveRegistryPath(repoRoot);
  if (absolutePath === undefined) {
    return { exceptions: [], issues: [] };
  }
  let registry;
  try {
    registry = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    return {
      exceptions: [],
      issues: [`${exceptionRegistryPath} contains invalid JSON: ${toError(error).message}`],
    };
  }
  if (registry?.version !== 2 || !Array.isArray(registry.exceptions)) {
    return {
      exceptions: [],
      issues: [`${exceptionRegistryPath} must contain version 2 and an exceptions array`],
    };
  }
  if (registry.exceptions.length === 0) {
    return { exceptions: [], issues: [] };
  }
  const repositoryContext = readRepositoryExceptionContext(repoRoot);
  const reviewLookup = dependencies.reviewLookup ?? readAuthenticatedGitHubReview;
  const exceptions = [];
  const issues = [];
  for (const [index, exception] of registry.exceptions.entries()) {
    const name = `${exceptionRegistryPath} exceptions[${index}]`;
    const exceptionIssues = validateRegisteredException({
      repoRoot,
      repositoryContext,
      reviewLookup,
      exception,
      name,
    });
    issues.push(...exceptionIssues);
    if (exceptionIssues.length === 0) {
      exceptions.push(exception);
    }
  }
  return { exceptions, issues };
}

function validateRegisteredException(input) {
  const { repoRoot, repositoryContext, reviewLookup, exception, name } = input;
  const issues = validateExceptionFields(exception, name);
  if (issues.length > 0) {
    return issues;
  }
  let evidence;
  try {
    evidence = reviewLookup({
      repoRoot,
      repository: repositoryContext.repository,
      pullNumber: exception.approval.pullNumber,
      reviewId: exception.approval.reviewId,
    });
  } catch (error) {
    const reason =
      error?.code === 'MALFORMED_GITHUB_REVIEW'
        ? 'authenticated GitHub review lookup returned malformed evidence'
        : 'authenticated GitHub review lookup failed';
    return [`${name} ${reason}`];
  }
  if (!isReviewEvidence(evidence)) {
    return [`${name} authenticated GitHub review lookup returned malformed evidence`];
  }
  issues.push(...validateTrustedReview({ exception, name, repositoryContext, evidence }));
  if (isConfinedRepoPath(exception.target) && !candidatePathsAreClean(repoRoot, exception.target)) {
    issues.push(`${name} trusted GitHub review does not cover dirty candidate paths`);
  }
  return issues;
}

export function readRepositoryExceptionContext(repoRoot) {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const candidateHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const repository = normalizeGitHubRepository(remote);
  if (repository === undefined || !exactShaPattern.test(candidateHead)) {
    throw new Error(
      'repository structure exception evidence requires GitHub origin and exact HEAD',
    );
  }
  return { repository, candidateHead };
}

function validateExceptionFields(exception, name) {
  const issues = [];
  if (exception?.ruleId !== 'topology.singleton-subtree') {
    issues.push(`${name}.ruleId must be topology.singleton-subtree`);
  }
  for (const field of ['target', 'owner', 'reviewOrRemovalCondition']) {
    if (typeof exception?.[field] !== 'string' || exception[field].trim() === '') {
      issues.push(`${name}.${field} must be a non-empty string`);
    }
  }
  if (typeof exception?.target === 'string' && !isConfinedRepoPath(exception.target)) {
    issues.push(`${name}.target must be a confined repository-relative path`);
  }
  const approval = exception?.approval;
  if (
    !Number.isInteger(approval?.pullNumber) ||
    approval.pullNumber <= 0 ||
    !Number.isInteger(approval?.reviewId) ||
    approval.reviewId <= 0 ||
    typeof approval.reviewerLogin !== 'string' ||
    approval.reviewerLogin.trim() === '' ||
    typeof approval.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(approval.approvedAt))
  ) {
    issues.push(
      `${name}.approval must record positive pull/review IDs, named reviewer login, and ` +
        'approval time',
    );
  }
  return issues;
}

function validateTrustedReview(input) {
  const { exception, name, repositoryContext, evidence } = input;
  const issues = [];
  const review = evidence.review;
  if (
    review.id !== exception.approval.reviewId ||
    !evidence.reviews.some((candidate) => candidate.id === review.id)
  ) {
    return [`${name} trusted GitHub review ID is missing`];
  }
  if (review.state !== 'APPROVED') {
    issues.push(`${name} trusted GitHub review state must be APPROVED`);
  }
  if (
    review.user?.type !== 'User' ||
    review.user?.login !== exception.approval.reviewerLogin ||
    !authorizedAssociations.has(review.author_association)
  ) {
    issues.push(`${name} trusted GitHub reviewer does not match an authorized named human`);
  }
  const superseded = evidence.reviews.some(
    (candidate) =>
      candidate?.user?.login === review.user?.login &&
      substantiveReviewStates.has(candidate?.state) &&
      compareReviews(candidate, review) > 0,
  );
  if (superseded) {
    issues.push(`${name} trusted GitHub approval is superseded`);
  }
  if (
    review.commit_id !== repositoryContext.candidateHead ||
    review.submitted_at !== exception.approval.approvedAt
  ) {
    issues.push(`${name} trusted GitHub review does not match candidate head or approval time`);
  }
  const expectedBody = [
    'REPOSITORY-STRUCTURE-EXCEPTION v2',
    `repository: ${repositoryContext.repository}`,
    `candidate-head: ${repositoryContext.candidateHead}`,
    `rule: ${exception.ruleId}`,
    `target: ${exception.target}`,
  ].join('\n');
  if (typeof review.body !== 'string' || !review.body.includes(expectedBody)) {
    issues.push(`${name} trusted GitHub review does not bind the exact rule and target`);
  }
  return issues;
}

function readAuthenticatedGitHubReview(input) {
  const reviewEndpoint =
    `repos/${input.repository}/pulls/${input.pullNumber}/reviews/` + input.reviewId;
  const reviewsEndpoint = `repos/${input.repository}/pulls/${input.pullNumber}/reviews`;
  const review = readGitHubApiJson(input.repoRoot, ['api', '--method', 'GET', reviewEndpoint]);
  const pages = readGitHubApiJson(input.repoRoot, [
    'api',
    '--method',
    'GET',
    '--paginate',
    '--slurp',
    reviewsEndpoint,
  ]);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw toMalformedGitHubReviewError();
  }
  const evidence = { review, reviews: pages.flat() };
  if (!isReviewEvidence(evidence)) {
    throw toMalformedGitHubReviewError();
  }
  return evidence;
}

function readGitHubApiJson(repoRoot, args) {
  let raw;
  try {
    raw = execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    throw new Error('authenticated GitHub API call failed');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw toMalformedGitHubReviewError();
  }
}

function toMalformedGitHubReviewError() {
  return Object.assign(new Error('authenticated GitHub API returned malformed review JSON'), {
    code: 'MALFORMED_GITHUB_REVIEW',
  });
}

function isReviewEvidence(evidence) {
  return (
    isRecord(evidence) &&
    isNamedGitHubReview(evidence.review) &&
    Array.isArray(evidence.reviews) &&
    evidence.reviews.every(isGitHubReviewListEntry)
  );
}

function isNamedGitHubReview(review) {
  return (
    isGitHubReviewListEntry(review) &&
    exactShaPattern.test(review.commit_id ?? '') &&
    typeof review.author_association === 'string' &&
    typeof review.body === 'string' &&
    review.user?.type === 'User' &&
    typeof review.user.login === 'string' &&
    review.user.login !== '' &&
    typeof review.submitted_at === 'string' &&
    Number.isFinite(Date.parse(review.submitted_at))
  );
}

function isGitHubReviewListEntry(review) {
  if (
    isRecord(review) &&
    Number.isInteger(review.id) &&
    review.id > 0 &&
    typeof review.state === 'string'
  ) {
    return (
      !substantiveReviewStates.has(review.state) ||
      (typeof review.user?.login === 'string' &&
        review.user.login !== '' &&
        typeof review.submitted_at === 'string' &&
        Number.isFinite(Date.parse(review.submitted_at)))
    );
  }
  return false;
}

function compareReviews(left, right) {
  const timeDifference =
    Date.parse(left?.submitted_at ?? '') - Date.parse(right?.submitted_at ?? '');
  return timeDifference === 0 ? Number(left?.id) - Number(right?.id) : timeDifference;
}

function resolveRegistryPath(repoRoot) {
  const repositoryRoot = realpathSync(repoRoot);
  const absolutePath = path.join(repositoryRoot, exceptionRegistryPath);
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw new Error('repository structure exception registry must be a confined regular file');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(absolutePath) !== absolutePath) {
    throw new Error('repository structure exception registry must be a confined regular file');
  }
  return absolutePath;
}

function candidatePathsAreClean(repoRoot, target) {
  try {
    return (
      execFileSync(
        'git',
        [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--',
          exceptionRegistryPath,
          target,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      ) === ''
    );
  } catch {
    return false;
  }
}

function isConfinedRepoPath(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value === value.replaceAll('\\', '/') &&
    !path.posix.isAbsolute(value) &&
    !value.split('/').includes('..')
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeGitHubRepository(remote) {
  const match = /github\.com(?::|\/)([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote);
  return match?.[1];
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
