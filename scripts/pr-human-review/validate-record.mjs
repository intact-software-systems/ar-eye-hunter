import { validateRetainedLegacy } from './trusted-retained-legacy.mjs';
import {
  isExactSha,
  readVisibleReviewSections,
  validateFinalFindings,
  validateFreshReview,
  validateMilestoneReview,
  validateReviewEvidence,
} from './validate-review-evidence.mjs';

export { isExactSha } from './validate-review-evidence.mjs';

const recordFence = /```pr-human-review-record-v1\s*\n([\s\S]*?)\n```/gu;
const exemptionPaths = {
  'plan-only': [/^docs\/superpowers\/plans\/.+\.md$/u, /^plans\/.+\.md$/u],
  'documentation-only': [/^docs\/(?!superpowers\/plans\/).+\.md$/u],
  'agent-guidance-only': [/^\.agents\/.+\.md$/u, /^AGENTS\.md$/u],
};

export function validateReviewRecord(input) {
  const errors = [];
  const recordEvidence = readRecord(input.body, errors);
  if (!recordEvidence) {
    return errors;
  }
  const { record, visibleBody } = recordEvidence;
  validateCurrentShas(input, errors);
  validateRecordShape(record, errors);
  if (record.scope === 'exempt') {
    validateExemption(record, input.changedPaths, errors);
    return errors;
  }
  if (record.scope !== 'code-changing') {
    return errors;
  }
  const visibleSections = readVisibleReviewSections(visibleBody, errors);
  validateMilestoneReview(record.milestoneReview, visibleSections.milestone, errors);
  const initialReview = validateReviewEvidence({
    review: record.initialReview,
    stage: 'initial',
    section: visibleSections.initial,
    errors,
  });
  if (input.draft) {
    validateFreshReview({ review: initialReview, stage: 'initial', input, errors });
    return errors;
  }
  const finalReview = validateReviewEvidence({
    review: record.finalReview,
    stage: 'final',
    section: visibleSections.final,
    retainedLegacy: record.retainedLegacy,
    errors,
  });
  validateFreshReview({ review: finalReview, stage: 'final', input, errors });
  validateFinalFindings(finalReview, errors);
  if (finalReview?.legacy?.items && Array.isArray(record.retainedLegacy)) {
    validateRetainedLegacy({ record, finalReview, ...input, errors });
  }
  return errors;
}

function readRecord(body, errors) {
  const matches = [...body.matchAll(recordFence)];
  if (matches.length !== 1) {
    errors.push('PR Human Review Record v1 must contain exactly one metadata fence');
    return undefined;
  }
  try {
    const record = JSON.parse(matches[0][1]);
    if (!isPlainRecord(record)) {
      errors.push('PR Human Review Record v1 metadata must be a plain object');
      return undefined;
    }
    return {
      record,
      visibleBody: body.replace(recordFence, ''),
    };
  } catch {
    errors.push('PR Human Review Record v1 metadata block is not valid JSON');
    return undefined;
  }
}

function validateCurrentShas(input, errors) {
  if (!isExactSha(input.mergeBaseSha)) {
    errors.push('computed merge base SHA must be a full 40-character lowercase SHA');
  }
  if (!isExactSha(input.headSha)) {
    errors.push('current head SHA must be a full 40-character lowercase SHA');
  }
}

function validateRecordShape(record, errors) {
  if (record.version !== 1) {
    errors.push('PR Human Review Record v1 metadata must use version 1');
  }
  if (record.scope !== 'code-changing' && record.scope !== 'exempt') {
    errors.push('review scope must be code-changing or exempt');
  }
  if (!Array.isArray(record.retainedLegacy)) {
    errors.push('retainedLegacy must be an array');
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
  if (!sameSet(expected, actual)) {
    errors.push('exemption changed paths must exactly match the observed changed paths');
  }
  for (const changedPath of actual) {
    if (!allowedPatterns.some((pattern) => pattern.test(changedPath))) {
      errors.push(`${exemption.kind} exemption path is not allowed: ${changedPath}`);
    }
  }
}

function normalizePaths(paths, source, errors) {
  if (!Array.isArray(paths)) {
    errors.push(`${source} changed paths must be an array`);
    return [];
  }
  const normalized = paths.map((path) => normalizePath(path));
  if (normalized.some((path) => path === undefined)) {
    errors.push(`${source} changed paths must be normalized repository-relative paths`);
  }
  return [...new Set(normalized.filter(Boolean))].sort();
}

function normalizePath(path) {
  if (
    typeof path !== 'string' ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.includes('../')
  ) {
    return undefined;
  }
  const normalized = path.replace(/^\.\//u, '').replace(/\/+/gu, '/');
  return normalized.includes('/./') || normalized === '.' ? undefined : normalized;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function isPlainRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
