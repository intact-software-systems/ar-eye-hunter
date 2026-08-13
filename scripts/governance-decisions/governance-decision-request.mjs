import { computeSha256, toCanonicalJson } from './canonical-json.mjs';

const commonKeys = [
  'schemaVersion',
  'operation',
  'repository',
  'defaultBranch',
  'expectedHeadOid',
  'force',
  'reason',
  'target',
  'payload',
];
const operationNames = new Set([
  'plan.repair',
  'plan.cancel',
  'plan.supersede',
  'plan.complete',
  'plan.quarantine',
]);
const planDigestPattern = /^[0-9a-f]{64}$/u;
const gitObjectIdPattern = /^[0-9a-f]{40}$/u;
const planPathPattern = /^plans\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;

export function decodeGovernanceDecisionRequest(value) {
  requireExactKeys(value, commonKeys, 'request');
  if (value.schemaVersion !== 'governance-decision-request-v1') {
    throw new Error('schemaVersion must be governance-decision-request-v1');
  }
  if (!operationNames.has(value.operation)) {
    throw new Error('operation must be one of the five plan governance decisions');
  }
  if (value.repository !== 'intact-software-systems/ar-eye-hunter') {
    throw new Error('repository must be intact-software-systems/ar-eye-hunter');
  }
  if (value.defaultBranch !== 'main') {
    throw new Error('defaultBranch must be main');
  }
  requireGitObjectId(value.expectedHeadOid, 'expectedHeadOid');
  if (value.force !== true) {
    throw new Error('force must be true');
  }
  if (typeof value.reason !== 'string' || value.reason.trim() === '') {
    throw new Error('reason must be a non-empty string');
  }

  validateOperationShape(value.operation, value.target, value.payload);
  return JSON.parse(
    toCanonicalJson(Object.fromEntries(commonKeys.map((key) => [key, value[key]]))),
  );
}

export function computeGovernanceDecisionId(request) {
  return computeSha256(toCanonicalJson(request));
}

export function isDirectPlanPath(planPath) {
  return typeof planPath === 'string' && planPathPattern.test(planPath);
}

function validateOperationShape(operation, target, payload) {
  if (operation === 'plan.quarantine') {
    requireExactKeys(target, ['planPath', 'planBlobOid'], `${operation} target`);
    requirePlanPath(target.planPath);
    requireGitObjectId(target.planBlobOid, 'planBlobOid');
    requireEmptyPayload(payload, operation);
    return;
  }

  requireExactKeys(target, ['planPath', 'planDigest'], `${operation} target`);
  requirePlanPath(target.planPath);
  if (typeof target.planDigest !== 'string' || !planDigestPattern.test(target.planDigest)) {
    throw new Error('planDigest must be a SHA-256 digest');
  }
  if (operation === 'plan.repair') {
    requireExactKeys(payload, ['checkpoint'], `${operation} payload`);
    validateCheckpoint(payload.checkpoint);
    return;
  }
  if (operation === 'plan.supersede') {
    requireExactKeys(
      payload,
      ['successorPlanPath', 'successorPlanBlobOid'],
      `${operation} payload`,
    );
    requirePlanPath(payload.successorPlanPath, 'successorPlanPath');
    requireGitObjectId(payload.successorPlanBlobOid, 'successorPlanBlobOid');
    if (payload.successorPlanPath === target.planPath) {
      throw new Error('successorPlanPath must differ from the predecessor planPath');
    }
    return;
  }
  requireEmptyPayload(payload, operation);
}

function validateCheckpoint(checkpoint) {
  const keys = ['outcome', 'learning', 'structure', 'decision', 'nextSlices'];
  requireExactKeys(checkpoint, keys, 'plan.repair checkpoint');
  for (const key of ['outcome', 'learning', 'structure']) {
    if (typeof checkpoint[key] !== 'string' || checkpoint[key].trim() === '') {
      throw new Error(`plan.repair checkpoint.${key} must be a non-empty string`);
    }
  }
  if (!['continue', 'amend', 'consolidate', 'stop'].includes(checkpoint.decision)) {
    throw new Error('plan.repair checkpoint.decision is invalid');
  }
  if (
    !Array.isArray(checkpoint.nextSlices) ||
    checkpoint.nextSlices.length > 2 ||
    checkpoint.nextSlices.some((slice) => typeof slice !== 'string' || slice.trim() === '') ||
    new Set(checkpoint.nextSlices).size !== checkpoint.nextSlices.length
  ) {
    throw new Error('plan.repair checkpoint.nextSlices must contain at most two unique slices');
  }
}

function requireEmptyPayload(payload, operation) {
  requireExactKeys(payload, [], `${operation} payload`);
}

function requirePlanPath(planPath, name = 'planPath') {
  if (!isDirectPlanPath(planPath) || planPath === 'plans/README.md') {
    throw new Error(`${name} must identify a direct plans/<kebab>.md file`);
  }
}

function requireGitObjectId(value, name) {
  if (typeof value !== 'string' || !gitObjectIdPattern.test(value)) {
    throw new Error(`${name} must be 40 lowercase hexadecimal characters`);
  }
}

function requireExactKeys(value, expectedKeys, name) {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  const actualKeys = Object.keys(value);
  const expected = new Set(expectedKeys);
  const unsupported = actualKeys.filter((key) => !expected.has(key)).sort();
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  if (name === 'request' && unsupported.length > 0) {
    throw new Error(`unsupported request keys: ${unsupported.join(', ')}`);
  }
  if (unsupported.length > 0 || missing.length > 0) {
    if (expectedKeys.length === 0) {
      throw new Error(`${name} must be empty`);
    }
    throw new Error(`${name} must contain exactly: ${expectedKeys.join(', ')}`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
