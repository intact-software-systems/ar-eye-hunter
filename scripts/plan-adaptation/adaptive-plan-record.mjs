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
  requireText(issues, record.planId, 'record.planId');
  requireText(issues, record.status, 'record.status');
  requireText(issues, record.goal, 'record.goal');
  requireTextArray(issues, record.acceptanceCriteria, 'record.acceptanceCriteria');
  validateCapabilities(issues, record.capabilities);
  if (!Array.isArray(record.completedSlicesSinceCheckpoint)) {
    issues.push('record.completedSlicesSinceCheckpoint must be an array');
  }
  if (!isRecord(record.facts)) {
    issues.push('record.facts must be an object');
  }
  if (!isRecord(record.checkpoint)) {
    issues.push('record.checkpoint must be an object');
  }
  if (!Array.isArray(record.materialDecisions)) {
    issues.push('record.materialDecisions must be an array');
  }
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
