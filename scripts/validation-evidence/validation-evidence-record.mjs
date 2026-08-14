import { computeBuildAffectingTreeDigest } from './build-affecting-tree.mjs';

const fullCommitSha = /^[0-9a-f]{40}$/u;
const workflowPathPattern = /^\.github\/workflows\/[a-z0-9][a-z0-9._-]*\.ya?ml$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

export function createValidationEvidence({ repoRoot, context }) {
  validateContext(context);
  return {
    schemaVersion: 'validation-evidence-v2',
    repository: context.repository,
    pullRequestNumber: context.pullRequestNumber,
    workflow: {
      path: context.workflowPath,
      runId: context.runId,
      runAttempt: context.runAttempt,
    },
    head: context.head,
    buildTreeDigest: computeBuildAffectingTreeDigest({ repoRoot, headSha: context.head }),
    completedAt: toCanonicalIsoTime(context.completedAt),
  };
}

export function readValidationEvidence(source) {
  let evidence;
  try {
    evidence = JSON.parse(source);
  } catch {
    throw new Error('validation evidence artifact must contain JSON');
  }
  const issues = validateValidationEvidence(evidence);
  if (issues.length > 0) {
    throw new Error(issues.join('; '));
  }
  return evidence;
}

export function validateValidationEvidence(evidence) {
  if (!isRecord(evidence)) {
    return ['validation evidence must be an object'];
  }
  const issues = [];
  requireExactFields(issues, evidence, [
    'schemaVersion',
    'repository',
    'pullRequestNumber',
    'workflow',
    'head',
    'buildTreeDigest',
    'completedAt',
  ]);
  if (evidence.schemaVersion !== 'validation-evidence-v2') {
    issues.push('validation evidence schemaVersion must be validation-evidence-v2');
  }
  if (!isRepositoryName(evidence.repository)) {
    issues.push('validation evidence repository must be an owner/name pair');
  }
  if (!isPositiveInteger(evidence.pullRequestNumber)) {
    issues.push('validation evidence pull request number must be a positive integer');
  }
  validateWorkflow(issues, evidence.workflow);
  if (!fullCommitSha.test(evidence.head ?? '')) {
    issues.push('validation evidence head must be a full commit SHA');
  }
  if (!digestPattern.test(evidence.buildTreeDigest ?? '')) {
    issues.push('validation evidence buildTreeDigest must be a SHA-256 digest');
  }
  if (!isCanonicalIsoTime(evidence.completedAt)) {
    issues.push('validation evidence completedAt must be a canonical ISO timestamp');
  }
  return issues;
}

function validateContext(context) {
  if (!isRecord(context)) {
    throw new Error('validation evidence context must be an object');
  }
  if (!isRepositoryName(context.repository)) {
    throw new Error('repository must be an owner/name pair');
  }
  if (!isPositiveInteger(context.pullRequestNumber)) {
    throw new Error('pull request number must be a positive integer');
  }
  if (!workflowPathPattern.test(context.workflowPath ?? '')) {
    throw new Error('workflow path must identify a repository workflow');
  }
  if (!isPositiveInteger(context.runId) || !isPositiveInteger(context.runAttempt)) {
    throw new Error('workflow run identity must use positive integers');
  }
  if (!fullCommitSha.test(context.head ?? '')) {
    throw new Error('workflow head must be a full commit SHA');
  }
  if (!isIsoTime(context.completedAt)) {
    throw new Error('completion time must be an ISO timestamp');
  }
}

function validateWorkflow(issues, workflow) {
  if (!isRecord(workflow)) {
    issues.push('validation evidence workflow must be an object');
    return;
  }
  requireExactFields(issues, workflow, ['path', 'runId', 'runAttempt']);
  if (!workflowPathPattern.test(workflow.path ?? '')) {
    issues.push('validation evidence workflow path must identify a repository workflow');
  }
  if (!isPositiveInteger(workflow.runId) || !isPositiveInteger(workflow.runAttempt)) {
    issues.push('validation evidence workflow run identity must use positive integers');
  }
}

function requireExactFields(issues, value, expected) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((field, index) => field !== canonical[index])
  ) {
    issues.push(`validation evidence fields must match: ${expected.join(', ')}`);
  }
}

function isRepositoryName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isCanonicalIsoTime(value) {
  return isIsoTime(value) && new Date(Date.parse(value)).toISOString() === value;
}

function toCanonicalIsoTime(value) {
  return new Date(Date.parse(value)).toISOString();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
