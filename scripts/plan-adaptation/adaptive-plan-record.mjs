import { createHash } from 'node:crypto';

const recordPattern = /```plan-adaptation-v1\s*\n([\s\S]*?)\n```/gu;

export function parseAdaptivePlanRecord(markdown, sourceName = 'adaptive plan') {
  const matches = [...markdown.matchAll(recordPattern)];
  if (matches.length !== 1) {
    throw new Error(`${sourceName} must contain exactly one plan-adaptation-v1 block`);
  }

  try {
    return JSON.parse(matches[0][1]);
  } catch (error) {
    throw new Error(`${sourceName} contains invalid JSON: ${toError(error).message}`);
  }
}

export function replaceAdaptivePlanRecord(markdown, record, sourceName = 'adaptive plan') {
  parseAdaptivePlanRecord(markdown, sourceName);
  const replacement = `\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\``;
  return markdown.replace(recordPattern, replacement);
}

export function computeAdaptivePlanRecordDigest(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export function validateAdaptivePlanRecord(record) {
  const issues = [];
  if (!isRecord(record) || record.version !== 1) {
    return ['record.version must be 1'];
  }
  if (typeof record.planId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.planId)) {
    issues.push('record.planId must use lowercase letters, digits, and single hyphens');
  }
  if (record.status !== 'active') {
    issues.push('record.status must be active');
  }
  requireText(issues, record.goal, 'record.goal');
  requireTextArray(issues, record.acceptanceCriteria, 'record.acceptanceCriteria');
  validateCapabilities(issues, record.capabilities);
  validateTextArray(
    issues,
    record.completedSlicesSinceCheckpoint,
    'record.completedSlicesSinceCheckpoint',
  );
  validateFacts(issues, record.facts);
  if (!isRecord(record.checkpoint)) {
    issues.push('record.checkpoint must be an object');
  }
  validateStructuralDispositions(issues, record.structuralDispositions);
  validateStructuralReview(issues, record.freshStructuralReview);
  validateColdNavigationEvidence(issues, record.coldNavigationEvidence);
  validateMaterialDecisions(issues, record.materialDecisions);
  return issues;
}

function validateCapabilities(issues, capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    issues.push('record.capabilities must contain at least one capability');
    return;
  }
  for (const [index, capability] of capabilities.entries()) {
    if (!isRecord(capability)) {
      issues.push(`record.capabilities[${index}] must be an object`);
      continue;
    }
    for (const field of ['owner', 'root', 'entry', 'testRoot', 'focusedCommand']) {
      requireText(issues, capability[field], `record.capabilities[${index}].${field}`);
    }
    for (const field of ['root', 'entry', 'testRoot']) {
      if (!isSafeRepositoryPath(capability[field])) {
        issues.push(
          `record.capabilities[${index}].${field} must be a safe repository-relative path`,
        );
      }
    }
    if (capability.navigationMap !== null && !isSafeRepositoryPath(capability.navigationMap)) {
      const name = `record.capabilities[${index}].navigationMap`;
      issues.push(`${name} must be null or a safe repository-relative path`);
    }
  }
}

function validateFacts(issues, facts) {
  if (!isRecord(facts)) {
    issues.push('record.facts must be an object');
    return;
  }
  requireText(issues, facts.diffBase, 'record.facts.diffBase');
  if (
    facts.affectedCodeDigest !== null &&
    !/^[a-f0-9]{64}$/u.test(facts.affectedCodeDigest ?? '')
  ) {
    issues.push('record.facts.affectedCodeDigest must be null or a SHA-256 digest');
  }
  validateTextArray(issues, facts.computedTriggers, 'record.facts.computedTriggers');
  if (!Array.isArray(facts.undeclaredChangedPaths)) {
    issues.push('record.facts.undeclaredChangedPaths must be an array');
  } else if (facts.undeclaredChangedPaths.some((value) => !isSafeRepositoryPath(value))) {
    issues.push('record.facts.undeclaredChangedPaths must contain safe repository-relative paths');
  }
}

function validateStructuralDispositions(issues, dispositions) {
  if (!Array.isArray(dispositions)) {
    issues.push('record.structuralDispositions must be an array');
    return;
  }
  for (const [index, disposition] of dispositions.entries()) {
    if (!isRecord(disposition)) {
      issues.push(`record.structuralDispositions[${index}] must be an object`);
      continue;
    }
    requireText(issues, disposition.target, `record.structuralDispositions[${index}].target`);
    if (!['keep', 'split', 'move', 'consolidate'].includes(disposition.disposition)) {
      const name = `record.structuralDispositions[${index}].disposition`;
      issues.push(`${name} must be keep, split, move, or consolidate`);
    }
    requireText(issues, disposition.rationale, `record.structuralDispositions[${index}].rationale`);
  }
}

function validateStructuralReview(issues, review) {
  if (review === null) {
    return;
  }
  if (!isRecord(review) || !['complete', 'failed'].includes(review.status)) {
    issues.push('record.freshStructuralReview must be null or have status complete or failed');
    return;
  }
  if (!Array.isArray(review.failures)) {
    issues.push('record.freshStructuralReview.failures must be an array');
    return;
  }
  for (const [index, failure] of review.failures.entries()) {
    if (!isRecord(failure) || !['navigation', 'ownership'].includes(failure.kind)) {
      issues.push(
        `record.freshStructuralReview.failures[${index}].kind must be navigation or ownership`,
      );
      continue;
    }
    requireText(issues, failure.summary, `record.freshStructuralReview.failures[${index}].summary`);
    if (typeof failure.recoverable !== 'boolean') {
      issues.push(`record.freshStructuralReview.failures[${index}].recoverable must be boolean`);
    }
    validateTextArray(
      issues,
      failure.deepenedBySlices,
      `record.freshStructuralReview.failures[${index}].deepenedBySlices`,
    );
  }
}

function validateColdNavigationEvidence(issues, evidence) {
  if (evidence === null) {
    return;
  }
  if (!isRecord(evidence) || !['passed', 'failed'].includes(evidence.status)) {
    issues.push('record.coldNavigationEvidence must be null or have status passed or failed');
    return;
  }
  requireText(issues, evidence.summary, 'record.coldNavigationEvidence.summary');
  if (
    evidence.consolidationDecisionIndex !== undefined &&
    (!Number.isInteger(evidence.consolidationDecisionIndex) ||
      evidence.consolidationDecisionIndex < 0)
  ) {
    issues.push(
      'record.coldNavigationEvidence.consolidationDecisionIndex must be a non-negative integer',
    );
  }
}

function validateMaterialDecisions(issues, decisions) {
  if (!Array.isArray(decisions)) {
    issues.push('record.materialDecisions must be an array');
    return;
  }
  for (const [index, decision] of decisions.entries()) {
    if (!isRecord(decision)) {
      issues.push(`record.materialDecisions[${index}] must be an object`);
      continue;
    }
    if (typeof decision.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(decision.date)) {
      issues.push(`record.materialDecisions[${index}].date must use YYYY-MM-DD`);
    }
    requireText(issues, decision.decision, `record.materialDecisions[${index}].decision`);
    if (decision.summary !== undefined) {
      requireText(issues, decision.summary, `record.materialDecisions[${index}].summary`);
    }
  }
}

function requireTextArray(issues, value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${name} must be a non-empty array`);
    return;
  }
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    issues.push(`${name} must contain only non-empty strings`);
  }
}

function validateTextArray(issues, value, name) {
  if (!Array.isArray(value)) {
    issues.push(`${name} must be an array`);
    return;
  }
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    issues.push(`${name} must contain only non-empty strings`);
  }
}

export function isSafeRepositoryPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return false;
  }
  return true;
}

function requireText(issues, value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${name} must be a non-empty string`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
