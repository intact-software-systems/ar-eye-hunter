import { computeBuildAffectingTreeDigest } from '../pr-human-review/review-freshness.mjs';

const fullCommitSha = /^[0-9a-f]{40}$/u;
const workflowPath = /^\.github\/workflows\/[a-z0-9][a-z0-9._-]*\.ya?ml$/u;
const digest = /^[0-9a-f]{64}$/u;
const evidenceFields = [
  'schemaVersion',
  'repository',
  'workflow',
  'head',
  'buildTreeDigest',
  'releaseGate',
];

export function createValidationEvidence({ repoRoot, run, jobs, releaseGateResult }) {
  validateCurrentRun(run);
  if (releaseGateResult !== 'success') {
    throw new Error('release gate result must be success');
  }
  const releaseGate = readSuccessfulReleaseGateJob(jobs, run);
  return {
    schemaVersion: 'validation-evidence-v1',
    repository: run.repository.full_name,
    workflow: {
      id: run.workflow_id,
      path: run.path,
      runId: run.id,
      runAttempt: run.run_attempt,
    },
    head: run.head_sha,
    buildTreeDigest: computeBuildAffectingTreeDigest({ repoRoot, headSha: run.head_sha }),
    releaseGate: {
      jobId: releaseGate.id,
      name: releaseGate.name,
      conclusion: releaseGate.conclusion,
      completedAt: toCanonicalIsoTime(releaseGate.completed_at),
    },
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
  requireExactFields({
    issues,
    value: evidence,
    expected: evidenceFields,
    label: 'validation evidence',
  });
  if (evidence.schemaVersion !== 'validation-evidence-v1') {
    issues.push('validation evidence schemaVersion must be validation-evidence-v1');
  }
  if (!isRepositoryName(evidence.repository)) {
    issues.push('validation evidence repository must be an owner/name pair');
  }
  validateEvidenceWorkflow(issues, evidence.workflow);
  if (typeof evidence.head !== 'string' || !fullCommitSha.test(evidence.head)) {
    issues.push('validation evidence head must be a full commit SHA');
  }
  if (typeof evidence.buildTreeDigest !== 'string' || !digest.test(evidence.buildTreeDigest)) {
    issues.push('validation evidence buildTreeDigest must be a SHA-256 digest');
  }
  validateReleaseGateEvidence(issues, evidence.releaseGate);
  return issues;
}

function validateReleaseGateEvidence(issues, releaseGate) {
  if (!isRecord(releaseGate)) {
    issues.push('validation evidence releaseGate must be an object');
    return;
  }
  requireExactFields({
    issues,
    value: releaseGate,
    expected: ['jobId', 'name', 'conclusion', 'completedAt'],
    label: 'validation evidence releaseGate',
  });
  if (!isPositiveInteger(releaseGate.jobId)) {
    issues.push('validation evidence releaseGate jobId must be a positive integer');
  }
  if (releaseGate.name !== 'Release Gate / Release Gate') {
    issues.push('validation evidence releaseGate name must identify the broad release job');
  }
  if (releaseGate.conclusion !== 'success') {
    issues.push('validation evidence releaseGate conclusion must be success');
  }
  if (!isCanonicalIsoTime(releaseGate.completedAt)) {
    issues.push('validation evidence releaseGate completedAt must be a canonical ISO timestamp');
  }
}

function readSuccessfulReleaseGateJob(jobs, run) {
  if (!Array.isArray(jobs)) {
    throw new Error('workflow jobs envelope must contain jobs');
  }
  const releaseGateJobs = jobs.filter((job) => job?.name === 'Release Gate / Release Gate');
  if (releaseGateJobs.length !== 1) {
    throw new Error('workflow jobs must contain exactly one broad Release Gate job');
  }
  const releaseGate = releaseGateJobs[0];
  if (
    !isPositiveInteger(releaseGate.id) ||
    releaseGate.run_id !== run.id ||
    releaseGate.head_sha !== run.head_sha ||
    releaseGate.status !== 'completed' ||
    releaseGate.conclusion !== 'success' ||
    !isIsoTime(releaseGate.completed_at)
  ) {
    throw new Error('broad Release Gate job must be completed, successful, and bound to this run');
  }
  return releaseGate;
}

function validateEvidenceWorkflow(issues, workflow) {
  if (!isRecord(workflow)) {
    issues.push('validation evidence workflow must be an object');
    return;
  }
  requireExactFields({
    issues,
    value: workflow,
    expected: ['id', 'path', 'runId', 'runAttempt'],
    label: 'validation evidence workflow',
  });
  for (const [field, label] of [
    ['id', 'workflow id'],
    ['runId', 'workflow run id'],
    ['runAttempt', 'workflow run attempt'],
  ]) {
    if (!Number.isSafeInteger(workflow[field]) || workflow[field] <= 0) {
      issues.push(`validation evidence ${label} must be a positive integer`);
    }
  }
  if (typeof workflow.path !== 'string' || !workflowPath.test(workflow.path)) {
    issues.push('validation evidence workflow path must identify a repository workflow');
  }
}

function requireExactFields({ issues, value, expected, label }) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((field, index) => field !== canonical[index])
  ) {
    issues.push(`${label} fields must match the v1 contract`);
  }
}

function isCanonicalIsoTime(value) {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function toCanonicalIsoTime(value) {
  return new Date(Date.parse(value)).toISOString();
}

function validateCurrentRun(run) {
  if (!isRecord(run)) {
    throw new Error('workflow run envelope must be an object');
  }
  requirePositiveInteger(run.id, 'workflow run id');
  requirePositiveInteger(run.run_attempt, 'workflow run attempt');
  requirePositiveInteger(run.workflow_id, 'workflow id');
  if (typeof run.path !== 'string' || !workflowPath.test(run.path)) {
    throw new Error('workflow path must identify a repository workflow');
  }
  if (run.event !== 'push' || run.status !== 'in_progress' || run.conclusion !== null) {
    throw new Error('evidence creation requires an in-progress push workflow run');
  }
  if (typeof run.head_sha !== 'string' || !fullCommitSha.test(run.head_sha)) {
    throw new Error('workflow head must be a full commit SHA');
  }
  if (!isRecord(run.repository) || !isRepositoryName(run.repository.full_name)) {
    throw new Error('workflow repository must be an owner/name pair');
  }
  readIsoTime(run.created_at, 'workflow creation time');
}

function requirePositiveInteger(value, label) {
  if (!isPositiveInteger(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function readIsoTime(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return Date.parse(value);
}

function isRepositoryName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
