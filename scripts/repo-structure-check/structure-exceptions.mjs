import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const exceptionRegistryPath = 'docs/repo-structure-exceptions.json';
const authorizedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const exactShaPattern = /^[a-f0-9]{40}$/u;

export function readStructureExceptions(repoRoot, evidenceInput) {
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
  const resolvedEvidenceInput = !isRecord(evidenceInput?.trustedEvidence)
    ? (evidenceInput ?? {})
    : typeof evidenceInput?.repository === 'string' &&
        typeof evidenceInput?.candidateHead === 'string'
      ? evidenceInput
      : { ...evidenceInput, ...readRepositoryExceptionContext(repoRoot) };
  const exceptions = [];
  const issues = [];
  for (const [index, exception] of registry.exceptions.entries()) {
    const name = `${exceptionRegistryPath} exceptions[${index}]`;
    const exceptionIssues = validateException({
      exception,
      name,
      evidenceInput: resolvedEvidenceInput,
      repoRoot,
    });
    issues.push(...exceptionIssues);
    if (exceptionIssues.length === 0) {
      exceptions.push(exception);
    }
  }
  return { exceptions, issues };
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

function validateException(input) {
  const { exception, name, evidenceInput, repoRoot } = input;
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
    !Number.isInteger(approval?.reviewId) ||
    typeof approval.reviewerLogin !== 'string' ||
    approval.reviewerLogin.trim() === '' ||
    typeof approval.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(approval.approvedAt))
  ) {
    issues.push(
      `${name}.approval must record a GitHub review ID, named reviewer login, and approval time`,
    );
    return issues;
  }
  issues.push(...validateTrustedEvidence(exception, name, evidenceInput));
  if (
    isRecord(evidenceInput?.trustedEvidence) &&
    isConfinedRepoPath(exception?.target) &&
    !candidatePathsAreClean(repoRoot, exception.target)
  ) {
    issues.push(`${name} trusted GitHub review does not cover dirty candidate paths`);
  }
  return issues;
}

function validateTrustedEvidence(exception, name, input) {
  if (!isRecord(input?.trustedEvidence)) {
    return [`${name} trusted GitHub review evidence is required`];
  }
  const evidence = input.trustedEvidence;
  const issues = [];
  if (
    evidence.version !== 2 ||
    evidence.repository !== input.repository ||
    evidence.candidateHead !== input.candidateHead ||
    !exactShaPattern.test(evidence.candidateHead ?? '') ||
    !Array.isArray(evidence.reviews)
  ) {
    return [`${name} trusted evidence does not match this repository and candidate head`];
  }
  const review = evidence.reviews.find(
    (candidate) => candidate?.id === exception.approval.reviewId,
  );
  if (!isRecord(review)) {
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
      ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(candidate?.state) &&
      compareReviews(candidate, review) > 0,
  );
  if (superseded) {
    issues.push(`${name} trusted GitHub approval is superseded`);
  }
  if (
    review.commit_id !== input.candidateHead ||
    review.submitted_at !== exception.approval.approvedAt
  ) {
    issues.push(`${name} trusted GitHub review does not match candidate head or approval time`);
  }
  const expectedBody = [
    'REPOSITORY-STRUCTURE-EXCEPTION v2',
    `repository: ${input.repository}`,
    `candidate-head: ${input.candidateHead}`,
    `rule: ${exception.ruleId}`,
    `target: ${exception.target}`,
  ].join('\n');
  if (typeof review.body !== 'string' || !review.body.includes(expectedBody)) {
    issues.push(`${name} trusted GitHub review does not bind the exact rule and target`);
  }
  return issues;
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
