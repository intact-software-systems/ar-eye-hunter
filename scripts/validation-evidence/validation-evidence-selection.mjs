import { execFileSync } from 'node:child_process';

import { computeBuildAffectingTreeDigest } from './build-affecting-tree.mjs';
import { inspectRtcObservationChange } from './rtc-observation-change.mjs';
import { readValidationEvidence } from './validation-evidence-record.mjs';

export const VALIDATION_EVIDENCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function selectValidationEvidence(input) {
    if (!fullCommitSha(input.candidate.base)) {
        throw new Error('candidate base commit is malformed');
    }
    const observation = inspectRtcObservationChange({
        repoRoot: input.repoRoot,
        base: input.candidate.base,
        head: input.candidate.head
    });
    if (observation.observationOnly) {
        return {
            ...observation,
            mode: 'rtc-observation',
            reuse: false,
            buildTreeDigest: computeBuildAffectingTreeDigest({
                repoRoot: input.repoRoot,
                headSha: input.candidate.head
            })
        };
    }
    const selected = selectReusableValidationEvidence(input);
    return { ...selected, mode: selected.reuse ? 'reuse' : 'broad' };
}

export function readWorkflowRunsEnvelope(source) {
    let envelope;
    try {
        envelope = JSON.parse(source);
    }
    catch {
        throw new Error('workflow runs response must contain JSON');
    }
    const pages = Array.isArray(envelope) ? envelope : [envelope];
    if (
        pages.length === 0 ||
        pages.some((page) => !isRecord(page) || !Array.isArray(page.workflow_runs))
    ) {
        throw new Error('workflow runs response must contain workflow_runs pages');
    }
    return pages.flatMap((page) => page.workflow_runs);
}

export function selectReusableValidationEvidence({ repoRoot, candidate, runs, readArtifact, now }) {
    validateCandidate(candidate);
    const nowTime = readIsoTime(now, 'selection time');
    const buildTreeDigest = computeBuildAffectingTreeDigest({ repoRoot, headSha: candidate.head });
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
            buildTreeDigest,
            nowTime
        });
        if (result.reuse) {
            return { ...result, buildTreeDigest };
        }
        reason = result.reason;
    }

    return { reuse: false, reason, buildTreeDigest };
}

function validateRunEvidence({ repoRoot, candidate, run, source, buildTreeDigest, nowTime }) {
    if (typeof source !== 'string') {
        return rejected('validation-evidence-artifact-unavailable');
    }
    let evidence;
    try {
        evidence = readValidationEvidence(source);
    }
    catch {
        return rejected('malformed-validation-evidence');
    }
    if (!matchesRun(evidence, run, candidate)) {
        return rejected('untrusted-validation-evidence-identity');
    }
    const completedAt = Date.parse(evidence.completedAt);
    if (
        completedAt < Date.parse(run.created_at) ||
        completedAt > Date.parse(run.updated_at) ||
        nowTime - completedAt > VALIDATION_EVIDENCE_LIFETIME_MS
    ) {
        return rejected('expired-validation-evidence');
    }
    if (!isAncestor(repoRoot, evidence.head, candidate.head)) {
        return rejected('validation-evidence-head-is-not-ancestor');
    }
    const sourceBuildTreeDigest = computeBuildAffectingTreeDigest({
        repoRoot,
        headSha: evidence.head
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
    const pullRequest = Array.isArray(run?.pull_requests) ? run.pull_requests[0] : undefined;
    if (
        !isRecord(run) ||
        !isRecord(run.repository) ||
        run.repository.full_name !== candidate.repository ||
        run.path !== candidate.workflowPath ||
        run.head_branch !== candidate.branch ||
        run.event !== 'pull_request' ||
        run.status !== 'completed' ||
        run.conclusion !== 'success' ||
        !Array.isArray(run.pull_requests) ||
        run.pull_requests.length !== 1 ||
        pullRequest?.number !== candidate.pullRequestNumber ||
        pullRequest?.base?.ref !== candidate.baseBranch ||
        pullRequest?.head?.ref !== candidate.branch
    ) {
        return 'untrusted-workflow-run';
    }
    if (
        !isPositiveInteger(run.id) ||
        run.id === candidate.currentRunId ||
        !isPositiveInteger(run.run_attempt) ||
        !fullCommitSha(run.head_sha) ||
        !isIsoTime(run.created_at) ||
        !isIsoTime(run.updated_at)
    ) {
        return 'malformed-workflow-run';
    }
    return undefined;
}

function matchesRun(evidence, run, candidate) {
    return (
        evidence.repository === candidate.repository &&
        evidence.pullRequestNumber === candidate.pullRequestNumber &&
        evidence.workflow.path === candidate.workflowPath &&
        evidence.workflow.runId === run.id &&
        evidence.workflow.runAttempt === run.run_attempt &&
        evidence.head === run.head_sha
    );
}

function validateCandidate(candidate) {
    if (
        !isRecord(candidate) ||
        !isRepositoryName(candidate.repository) ||
        !isPositiveInteger(candidate.pullRequestNumber) ||
        !workflowPath(candidate.workflowPath) ||
        !nonEmpty(candidate.branch) ||
        !nonEmpty(candidate.baseBranch) ||
        !fullCommitSha(candidate.head) ||
        !isPositiveInteger(candidate.currentRunId)
    ) {
        throw new Error('candidate validation context is malformed');
    }
}

function isAncestor(repoRoot, ancestor, candidateHead) {
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, candidateHead], {
            cwd: repoRoot,
            stdio: 'ignore'
        });
        return true;
    }
    catch {
        return false;
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

function fullCommitSha(value) {
    return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function workflowPath(value) {
    return (
        typeof value === 'string' && /^\.github\/workflows\/[a-z0-9][a-z0-9._-]*\.ya?ml$/u.test(value)
    );
}

function isRepositoryName(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function isPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function isIsoTime(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
