import { validateRetainedLegacy } from './trusted-retained-legacy.mjs';

const recordFence = /```pr-human-review-record-v1\s*\n([\s\S]*?)\n```/gu;
const exactSha = /^[0-9a-f]{40}$/u;
const validDispositions = new Set([
  'removed',
  'minimized-boundary',
  'resolved',
  'retained-pending-human-approval',
]);
const narrativeKeys = [
  'productionOwnerToResultTrace',
  'cognitiveIndirectionFindings',
  'testsRewrittenOrRemoved',
  'productionNotCompromisedForTests',
  'automationGaps',
  'completeFindings',
];
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
  const initialReview = validateReview({
    review: record.initialReview,
    stage: 'initial',
    body: visibleBody,
    errors,
  });
  if (input.draft) {
    validateFreshReview({ review: initialReview, stage: 'initial', input, errors });
    return errors;
  }
  const finalReview = validateReview({
    review: record.finalReview,
    stage: 'final',
    body: visibleBody,
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
      // The machine-readable fence is evidence, not human-visible narrative.
      // Never let marker-like text embedded in JSON certify the review prose.
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

function validateReview({ review, stage, body, errors }) {
  if (!isPlainRecord(review)) {
    errors.push(`${stage} review metadata is required`);
    return undefined;
  }
  validateText(review.reviewer, `${stage} reviewer`, errors);
  if (review.independence !== 'separate-agent-or-human') {
    errors.push(`${stage} review must identify a separate agent or human`);
  }
  if (!isExactSha(review.mergeBaseSha)) {
    errors.push(`${stage} review merge base SHA must be exact`);
  }
  if (!isExactSha(review.headSha)) {
    errors.push(`${stage} review head SHA must be exact`);
  }
  if (!['pass', 'changes-requested'].includes(review.verdict)) {
    errors.push(`${stage} review verdict must be pass or changes-requested`);
  }
  validateFindings(review.unresolvedFindings, stage, errors);
  validateVisibleNarrative({ narrative: review.narrative, stage, body, errors });
  validateLegacyLedger(review.legacy, stage, errors);
  return review;
}

function validateFreshReview({ review, stage, input, errors }) {
  if (!review) {
    return;
  }
  if (review.mergeBaseSha !== input.mergeBaseSha) {
    errors.push(`${stage} review merge base SHA must match the computed merge base`);
  }
  if (review.headSha !== input.headSha) {
    errors.push(`${stage} review head SHA must match current head`);
  }
}

function validateFindings(findings, stage, errors) {
  if (!isPlainRecord(findings)) {
    errors.push(`${stage} review unresolved findings are required`);
    return;
  }
  for (const severity of ['critical', 'important']) {
    if (!Number.isInteger(findings[severity]) || findings[severity] < 0) {
      errors.push(`${stage} review ${severity} finding count must be a non-negative integer`);
    }
  }
}

function validateVisibleNarrative({ narrative, stage, body, errors }) {
  if (!isPlainRecord(narrative)) {
    errors.push(`${stage} review narrative evidence is required`);
    return;
  }
  for (const key of narrativeKeys) {
    validateText(narrative[key], `${stage} review ${key}`, errors);
    const visible = readVisibleNarrative(body, stage, key);
    validateText(visible, `${stage} visible narrative evidence ${key}`, errors);
    if (normalize(visible) !== normalize(narrative[key])) {
      errors.push(`${stage} visible narrative evidence contradicts metadata: ${key}`);
    }
  }
}

function readVisibleNarrative(body, stage, key) {
  const start = `<!-- pr-human-review:${stage}:${key}:start -->`;
  const end = `<!-- pr-human-review:${stage}:${key}:end -->`;
  const firstStart = body.indexOf(start);
  const firstEnd = body.indexOf(end, firstStart + start.length);
  if (firstStart < 0 || firstEnd < 0 || body.indexOf(start, firstStart + 1) >= 0) {
    return undefined;
  }
  return body.slice(firstStart + start.length, firstEnd).trim();
}

function validateLegacyLedger(legacy, stage, errors) {
  if (!isPlainRecord(legacy) || !Array.isArray(legacy.items)) {
    errors.push(`${stage} review legacy ledger is required`);
    return;
  }
  if (!Number.isInteger(legacy.candidateCount) || legacy.candidateCount !== legacy.items.length) {
    errors.push(`${stage} review legacy candidate count must equal ledger items`);
  }
  const identifiers = new Set();
  for (const item of legacy.items) {
    if (!isPlainRecord(item)) {
      errors.push(`${stage} review legacy ledger contains a malformed item`);
      continue;
    }
    for (const field of ['id', 'path', 'symbol']) {
      validateText(item[field], `${stage} review legacy ${field}`, errors);
    }
    if (!validDispositions.has(item.disposition)) {
      errors.push(`${stage} review legacy disposition is invalid: ${String(item.disposition)}`);
    }
    if (identifiers.has(item.id)) {
      errors.push(`${stage} review legacy ledger has a duplicate item ID: ${item.id}`);
    }
    identifiers.add(item.id);
  }
}

function validateFinalFindings(review, errors) {
  if (!review || !isPlainRecord(review.unresolvedFindings)) {
    return;
  }
  if (review.verdict !== 'pass') {
    errors.push('final review verdict must be pass');
  }
  if (review.unresolvedFindings.critical !== 0) {
    errors.push('final review has unresolved Critical findings');
  }
  if (review.unresolvedFindings.important !== 0) {
    errors.push('final review has unresolved Important findings');
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

function validateText(value, label, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${label} is required`);
  } else if (isPlaceholder(value)) {
    errors.push(`${label} contains placeholder evidence`);
  }
}

function isPlaceholder(value) {
  const normalizedValue = value.trim().toLowerCase();
  return (
    ['todo', 'tbd', 'not applicable', 'not yet required', '...', '-'].includes(normalizedValue) ||
    normalizedValue.includes('<placeholder>') ||
    normalizedValue.includes('[placeholder]')
  );
}

function normalize(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

export function isExactSha(value) {
  return typeof value === 'string' && exactSha.test(value);
}

function isPlainRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
