import { execFileSync } from 'node:child_process';

import { computeBuildAffectingTreeDigest } from '../pr-human-review/review-freshness.mjs';
import { readValidationEvidence } from './validation-evidence-record.mjs';

export const VALIDATION_EVIDENCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function readWorkflowRunsEnvelope(source) {
  return readPagedItems(source, 'workflow_runs', 'workflow runs response');
}

export function readWorkflowJobsEnvelope(source) {
  return readPagedItems(source, 'jobs', 'workflow jobs response');
}

function readPagedItems(source, field, label) {
  let envelope;
  try {
    envelope = JSON.parse(source);
  } catch {
    throw new Error(`${label} must contain JSON`);
  }
  const pages = Array.isArray(envelope) ? envelope : [envelope];
  if (pages.length === 0 || pages.some((page) => !isRecord(page) || !Array.isArray(page[field]))) {
    throw new Error(`${label} must contain ${field} pages`);
  }
  return pages.flatMap((page) => page[field]);
}

export function selectReusableValidationEvidence({
  repoRoot,
  candidate,
  runs,
  readArtifact,
  readJobs,
  now,
}) {
  validateCandidate(candidate);
  const nowTime = readIsoTime(now, 'selection time');
  const buildTreeDigest = computeBuildAffectingTreeDigest({
    repoRoot,
    headSha: candidate.head,
  });
  let reason = runs.length === 0 ? 'no-prior-successful-run' : 'untrusted-workflow-run';
  for (const run of runs) {
    const runIssue = validateTrustedRun(run, candidate);
    if (runIssue !== undefined) {
      reason = runIssue;
      continue;
    }
    const result = validateRunEvidence({
      repoRoot,
      candidate,
      run,
      source: readArtifact(run),
      jobs: readJobs(run),
      buildTreeDigest,
      nowTime,
    });
    if (result.reuse) {
      return { ...result, buildTreeDigest };
    }
    reason = result.reason;
  }
  return { reuse: false, reason, buildTreeDigest };
}

function validateRunEvidence({ repoRoot, candidate, run, source, jobs, buildTreeDigest, nowTime }) {
  if (typeof source !== 'string') {
    return rejected('validation-evidence-artifact-unavailable');
  }
  let evidence;
  try {
    evidence = readValidationEvidence(source);
  } catch {
    return rejected('malformed-validation-evidence');
  }
  if (!matchesTrustedRun(evidence, run, candidate)) {
    return rejected('untrusted-validation-evidence-identity');
  }
  if (!matchesTrustedReleaseGate(evidence.releaseGate, jobs, run)) {
    return rejected('untrusted-release-gate-job');
  }
  const completedAt = Date.parse(evidence.releaseGate.completedAt);
  if (
    !isRunCompletionTime(completedAt, run) ||
    nowTime - completedAt > VALIDATION_EVIDENCE_LIFETIME_MS
  ) {
    return rejected('expired-validation-evidence');
  }
  if (!isAncestor(repoRoot, evidence.head, candidate.head)) {
    return rejected('validation-evidence-head-is-not-ancestor');
  }
  const sourceBuildTreeDigest = computeBuildAffectingTreeDigest({
    repoRoot,
    headSha: evidence.head,
  });
  if (evidence.buildTreeDigest !== sourceBuildTreeDigest) {
    return rejected('validation-evidence-source-digest-mismatch');
  }
  if (evidence.buildTreeDigest !== buildTreeDigest) {
    return rejected('build-tree-digest-mismatch');
  }
  return { reuse: true, reason: 'reusable-validation-evidence', evidence };
}

function validateTrustedRun(run, candidate) {
  if (!isRecord(run) || !isRecord(run.repository)) {
    return 'malformed-workflow-run';
  }
  if (
    run.repository.full_name !== candidate.repository ||
    run.path !== candidate.workflowPath ||
    run.head_branch !== candidate.branch ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  ) {
    return 'untrusted-workflow-run';
  }
  if (
    !isPositiveInteger(run.id) ||
    run.id === candidate.currentRunId ||
    !isPositiveInteger(run.run_attempt) ||
    !isPositiveInteger(run.workflow_id) ||
    !isFullCommitSha(run.head_sha) ||
    !isIsoTime(run.created_at) ||
    !isIsoTime(run.updated_at)
  ) {
    return 'malformed-workflow-run';
  }
  return undefined;
}

function matchesTrustedRun(evidence, run, candidate) {
  return (
    evidence.repository === candidate.repository &&
    evidence.workflow.id === run.workflow_id &&
    evidence.workflow.path === run.path &&
    evidence.workflow.runId === run.id &&
    evidence.workflow.runAttempt === run.run_attempt &&
    evidence.head === run.head_sha
  );
}

function matchesTrustedReleaseGate(releaseGate, jobs, run) {
  if (!Array.isArray(jobs)) {
    return false;
  }
  const matchingJobs = jobs.filter(
    (job) =>
      isRecord(job) &&
      job.id === releaseGate.jobId &&
      job.run_id === run.id &&
      job.head_sha === run.head_sha &&
      job.name === releaseGate.name &&
      job.status === 'completed' &&
      job.conclusion === releaseGate.conclusion &&
      toCanonicalIsoTime(job.completed_at) === releaseGate.completedAt,
  );
  return matchingJobs.length === 1;
}

function isRunCompletionTime(completedAt, run) {
  return completedAt >= Date.parse(run.created_at) && completedAt <= Date.parse(run.updated_at);
}

function isAncestor(repoRoot, ancestor, candidateHead) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, candidateHead], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function validateCandidate(candidate) {
  if (
    !isRecord(candidate) ||
    !isRepositoryName(candidate.repository) ||
    typeof candidate.workflowPath !== 'string' ||
    !/^\.github\/workflows\/[a-z0-9][a-z0-9._-]*\.ya?ml$/u.test(candidate.workflowPath) ||
    typeof candidate.branch !== 'string' ||
    candidate.branch.trim() === '' ||
    !isFullCommitSha(candidate.head) ||
    !isPositiveInteger(candidate.currentRunId)
  ) {
    throw new Error('candidate validation context is malformed');
  }
}

function rejected(reason) {
  return { reuse: false, reason };
}

function readIsoTime(value, label) {
  if (!isIsoTime(value)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return Date.parse(value);
}

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function toCanonicalIsoTime(value) {
  return isIsoTime(value) ? new Date(Date.parse(value)).toISOString() : undefined;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isFullCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function isRepositoryName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
