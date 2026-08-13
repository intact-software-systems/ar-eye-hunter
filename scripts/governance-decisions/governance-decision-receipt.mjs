import { computeSha256, toCanonicalJson } from './canonical-json.mjs';
import {
  computeGovernanceDecisionId,
  decodeGovernanceDecisionRequest,
} from './governance-decision-request.mjs';

export function createGovernanceDecisionReceipt(receiptInput) {
  requireExactKeys(receiptInput.actor, ['login', 'permission'], 'authenticated actor');
  if (
    receiptInput.actor?.permission !== 'admin' ||
    typeof receiptInput.actor.login !== 'string' ||
    receiptInput.actor.login.trim() === ''
  ) {
    throw new Error('authenticated actor permission must be admin');
  }
  const request = decodeGovernanceDecisionRequest(receiptInput.request);
  const decisionId = computeGovernanceDecisionId(request);
  const stateChanges = receiptInput.stateChanges
    .map(toStateChange)
    .sort((left, right) => compareText(left.path, right.path));
  if (new Set(stateChanges.map((change) => change.path)).size !== stateChanges.length) {
    throw new Error('state change paths must be unique');
  }
  return {
    schemaVersion: 'governance-decision-receipt-v1',
    decisionId,
    requestDigest: decisionId,
    request,
    actor: {
      login: receiptInput.actor.login,
      permission: 'admin',
    },
    transport: receiptInput.transport,
    result: receiptInput.result,
    bypassedInvariants: [...new Set(receiptInput.bypassedInvariants)].sort(compareText),
    stateChanges,
  };
}

export function serializeGovernanceDecisionReceipt(receipt) {
  return `${toCanonicalJson(receipt)}\n`;
}

export function toGovernanceDecisionReceiptPath(decisionId) {
  if (typeof decisionId !== 'string' || !/^[0-9a-f]{64}$/u.test(decisionId)) {
    throw new Error('decision ID must be a SHA-256 digest');
  }
  return `governance/decisions/${decisionId}.json`;
}

export function toContentIdentity(content, blobOid) {
  return { blobOid, sha256: computeSha256(content) };
}

function toStateChange(change) {
  requireExactKeys(change, ['path', 'before', 'after'], 'state change');
  if (typeof change?.path !== 'string' || change.path === '') {
    throw new Error('state change path must be a non-empty string');
  }
  if (change.before === null && change.after === null) {
    throw new Error(`state change ${change.path} must change content identity`);
  }
  return {
    path: change.path,
    before: toNullableIdentity(change.before, `${change.path} before`),
    after: toNullableIdentity(change.after, `${change.path} after`),
  };
}

function toNullableIdentity(identity, name) {
  if (identity === null) {
    return null;
  }
  requireExactKeys(identity, ['blobOid', 'sha256'], name);
  if (
    typeof identity?.blobOid !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(identity.blobOid) ||
    typeof identity.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(identity.sha256)
  ) {
    throw new Error(`${name} must contain a Git blob OID and SHA-256 digest`);
  }
  return { blobOid: identity.blobOid, sha256: identity.sha256 };
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function requireExactKeys(value, expectedKeys, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const actualKeys = Object.keys(value).sort(compareText);
  const sortedExpectedKeys = [...expectedKeys].sort(compareText);
  if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpectedKeys)) {
    throw new Error(`${name} must contain exactly: ${expectedKeys.join(', ')}`);
  }
}
