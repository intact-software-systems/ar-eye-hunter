import { validateRetainedLegacy } from './trusted-retained-legacy.mjs';
import { isBuildAffectingPath } from './review-freshness.mjs';
import { isPlanClosureReceiptPath } from '../plan-adaptation/plan-closure-receipt.mjs';
import {
  isExactSha,
  readVisibleReviewSections,
  validateCheckpointReview,
  validateFinalFindings,
  validateFinalReview,
  validateInitialReview,
} from './validate-review-evidence.mjs';

export { isExactSha } from './validate-review-evidence.mjs';

const recordFence = /```pr-human-review-record-v2\s*\n([\s\S]*?)\n```/gu;
const exemptionPaths = {
  'plan-only': [
    /^docs\/superpowers\/plans\/.+\.md$/u,
    /^plans\/.+\.md$/u,
    /^plans\/policy\.json$/u,
    isPlanClosureReceiptPath,
  ],
  'documentation-only': [
    (repositoryPath) => /\.mdx?$/u.test(repositoryPath) && !isBuildAffectingPath(repositoryPath),
  ],
  'agent-guidance-only': [/^\.agents\/.+\.md$/u, /^AGENTS\.md$/u],
};

export function validateReviewRecord(input) {
  const errors = [];
  const recordEvidence = readRecord(input.body, errors);
  if (!recordEvidence) {
    return errors;
  }
  const { record, visibleBody } = recordEvidence;
  validateCurrentInput(input, errors);
  validateRecordShape(record, errors);
  if (record.scope === 'exempt') {
    validateExemption(record, input.changedPaths, errors);
    return errors;
  }
  if (record.scope !== 'code-changing') {
    return errors;
  }
  validatePlanReference(record.plan, input.currentPlan, errors);
  const sections = readVisibleReviewSections(visibleBody, errors);
  validateInitialReview({
    review: record.initialReview,
    reviewedPlanContext: input.reviewedPlanContextBySha?.[record.initialReview?.headSha],
    section: sections.initial,
    errors,
  });
  validateCheckpointReview({
    checkpointReview: record.checkpointReview,
    currentPlan: input.currentPlan,
    section: sections.checkpoint,
    errors,
  });
  if (input.draft) {
    return errors;
  }
  const finalReview = validateFinalReview({
    review: record.finalReview,
    currentPlan: input.currentPlan,
    currentBuildTreeDigest: input.currentBuildTreeDigest,
    reviewedBuildTreeDigestBySha: input.reviewedBuildTreeDigestBySha,
    section: sections.final,
    retainedLegacy: record.retainedLegacy,
    errors,
  });
  validateFinalFindings(finalReview, errors);
  if (finalReview?.legacy?.items && Array.isArray(record.retainedLegacy)) {
    validateRetainedLegacy({ record, finalReview, ...input, errors });
  }
  return errors;
}

export function readReviewRecordV2(body) {
  const errors = [];
  const evidence = readRecord(body, errors);
  if (!evidence) {
    throw new Error(errors.join('; '));
  }
  return evidence.record;
}

function readRecord(body, errors) {
  const matches = [...body.matchAll(recordFence)];
  if (matches.length !== 1) {
    errors.push('PR Human Review Record v2 must contain exactly one metadata fence');
    return undefined;
  }
  const trimmedBody = body.trimEnd();
  const fenceEnd = matches[0].index + matches[0][0].length;
  if (fenceEnd !== trimmedBody.length) {
    errors.push('PR Human Review Record v2 metadata fence must end the pull request body');
    return undefined;
  }
  try {
    const record = JSON.parse(matches[0][1]);
    if (!isPlainRecord(record)) {
      errors.push('PR Human Review Record v2 metadata must be a plain object');
      return undefined;
    }
    return { record, visibleBody: body.replace(recordFence, '') };
  } catch {
    errors.push('PR Human Review Record v2 metadata block is not valid JSON');
    return undefined;
  }
}

function validateCurrentInput(input, errors) {
  if (!isExactSha(input.mergeBaseSha)) {
    errors.push('computed merge base SHA must be a full 40-character lowercase SHA');
  }
  if (!isExactSha(input.headSha)) {
    errors.push('current head SHA must be a full 40-character lowercase SHA');
  }
}

function validateRecordShape(record, errors) {
  if (record.version !== 2) {
    errors.push('PR Human Review Record v2 metadata must use version 2');
  }
  if (record.scope !== 'code-changing' && record.scope !== 'exempt') {
    errors.push('review scope must be code-changing or exempt');
  }
  if (!Array.isArray(record.retainedLegacy)) {
    errors.push('retainedLegacy must be an array');
  }
  validateTopLevelFields(record, errors);
}

function validateTopLevelFields(record, errors) {
  const fieldsByScope = {
    'code-changing': new Set([
      'version',
      'scope',
      'exemption',
      'plan',
      'initialReview',
      'checkpointReview',
      'finalReview',
      'retainedLegacy',
    ]),
    exempt: new Set(['version', 'scope', 'exemption', 'retainedLegacy']),
  };
  const allowedFields = fieldsByScope[record.scope];
  if (!allowedFields) {
    return;
  }
  const unsupportedFields = Object.keys(record)
    .filter((field) => !allowedFields.has(field))
    .sort();
  if (unsupportedFields.length > 0) {
    const fieldList = unsupportedFields.join(', ');
    errors.push(`${record.scope} review metadata contains unsupported fields: ${fieldList}`);
  }
}

function validatePlanReference(plan, currentPlan, errors) {
  if (!isPlainRecord(plan) || typeof plan.path !== 'string' || plan.path.length === 0) {
    errors.push('code-changing review must identify its adaptive plan path');
    return;
  }
  if (plan.path !== currentPlan?.path) {
    errors.push('review adaptive plan path must match the current plan');
  }
  if (currentPlan?.status !== 'active') {
    errors.push('code-changing review must identify an active adaptive plan');
  }
}

function validateExemption(record, changedPaths, errors) {
  const exemption = record.exemption;
  if (!isPlainRecord(exemption) || !Array.isArray(exemption.changedPaths)) {
    errors.push('explicit exemption evidence is required for an exempt pull request');
    return;
  }
  const allowedPatterns = exemptionPaths[exemption.kind];
  if (!allowedPatterns) {
    errors.push('exemption kind must be plan-only, documentation-only, or agent-guidance-only');
    return;
  }
  const expected = normalizePaths(exemption.changedPaths, 'exemption', errors);
  const actual = normalizePaths(changedPaths, 'observed', errors);
  if (!sameTextArray(expected, actual)) {
    errors.push('exemption changed paths must exactly match the observed changed paths');
  }
  for (const changedPath of actual) {
    if (!allowedPatterns.some((pattern) => matchesExemptionPath(pattern, changedPath))) {
      errors.push(`${exemption.kind} exemption path is not allowed: ${changedPath}`);
    }
  }
}

function matchesExemptionPath(pattern, repositoryPath) {
  return typeof pattern === 'function' ? pattern(repositoryPath) : pattern.test(repositoryPath);
}

function normalizePaths(paths, source, errors) {
  if (!Array.isArray(paths)) {
    errors.push(`${source} changed paths must be an array`);
    return [];
  }
  const normalized = paths.map(normalizePath);
  if (normalized.some((repositoryPath) => repositoryPath === undefined)) {
    errors.push(`${source} changed paths must be normalized repository-relative paths`);
  }
  return [...new Set(normalized.filter(Boolean))].sort();
}

function normalizePath(repositoryPath) {
  if (
    typeof repositoryPath !== 'string' ||
    repositoryPath.includes('\\') ||
    repositoryPath.startsWith('./') ||
    repositoryPath.startsWith('/') ||
    repositoryPath.includes('//') ||
    repositoryPath.includes('../')
  ) {
    return undefined;
  }
  return repositoryPath.includes('/./') || repositoryPath === '.' ? undefined : repositoryPath;
}

function sameTextArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPlainRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
