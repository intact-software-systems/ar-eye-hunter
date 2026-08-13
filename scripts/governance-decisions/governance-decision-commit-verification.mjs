import { computeSha256, toCanonicalJson } from './canonical-json.mjs';
import {
  computeGovernanceDecisionId,
  decodeGovernanceDecisionRequest,
} from './governance-decision-request.mjs';
import {
  serializeGovernanceDecisionReceipt,
  toGovernanceDecisionReceiptPath,
} from './governance-decision-receipt.mjs';

const receiptPathPattern = /^governance\/decisions\/[0-9a-f]{64}\.json$/u;

export function verifyGovernanceDecisionCommit(verificationInput) {
  if (typeof verificationInput.readRepositorySnapshot !== 'function') {
    throw new Error('commit verification requires an injected repository reader');
  }
  const parentSnapshot = verificationInput.readRepositorySnapshot(verificationInput.parentOid);
  const commitSnapshot = verificationInput.readRepositorySnapshot(verificationInput.commitOid);
  validateReadSnapshots(verificationInput, parentSnapshot, commitSnapshot);
  const changes = computeSnapshotChanges(parentSnapshot, commitSnapshot);
  if (changes.some((change) => receiptPathPattern.test(change.path) && change.before !== null)) {
    throw new Error('existing governance decision receipts are immutable');
  }
  const receiptAdditions = changes.filter(
    (change) => receiptPathPattern.test(change.path) && change.before === null,
  );
  if (receiptAdditions.length !== 1) {
    throw new Error('commit must add exactly one governance decision receipt');
  }

  const receiptChange = receiptAdditions[0];
  const receiptEntry = commitSnapshot.entries.find((entry) => entry.path === receiptChange.path);
  if (receiptEntry?.mode !== '100644') {
    throw new Error('new governance decision receipt must be a regular file');
  }
  const receipt = parseCanonicalReceipt(receiptEntry.content);
  const request = decodeGovernanceDecisionRequest(receipt.request);
  validateReceiptIdentity({
    receipt,
    request,
    receiptPath: receiptChange.path,
    parentOid: parentSnapshot.headOid,
  });
  const nonReceiptChanges = changes.filter((change) => change.path !== receiptChange.path);
  validateDeclaredChanges(receipt, nonReceiptChanges);
  validateAllowedOperationPaths(request, receipt.stateChanges);
  validateRequiredOperationChanges(request, receipt.stateChanges);
  validateOperationResult(request.operation, receipt.result);

  return {
    decisionOnly: true,
    decisionId: receipt.decisionId,
    operation: request.operation,
    receiptPath: receiptChange.path,
    receipt,
  };
}

function parseCanonicalReceipt(content) {
  let receipt;
  try {
    receipt = JSON.parse(content);
  } catch (error) {
    throw new Error(`governance decision receipt contains invalid JSON: ${toError(error).message}`);
  }
  if (serializeGovernanceDecisionReceipt(receipt) !== content) {
    throw new Error('receipt serialization must be canonical JSON plus one newline');
  }
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'decisionId',
      'requestDigest',
      'request',
      'actor',
      'transport',
      'result',
      'bypassedInvariants',
      'stateChanges',
    ],
    'receipt',
  );
  if (receipt.schemaVersion !== 'governance-decision-receipt-v1') {
    throw new Error('receipt schemaVersion must be governance-decision-receipt-v1');
  }
  if (
    receipt.actor?.permission !== 'admin' ||
    typeof receipt.actor.login !== 'string' ||
    receipt.actor.login.trim() === ''
  ) {
    throw new Error('receipt actor must be an authenticated administrator');
  }
  requireExactKeys(receipt.actor, ['login', 'permission'], 'receipt actor');
  if (!Array.isArray(receipt.stateChanges) || !Array.isArray(receipt.bypassedInvariants)) {
    throw new Error('receipt must declare stateChanges and bypassedInvariants arrays');
  }
  if (!isSortedUnique(receipt.bypassedInvariants)) {
    throw new Error('receipt bypassedInvariants must be sorted and unique');
  }
  return receipt;
}

function validateReceiptIdentity(identityInput) {
  const decisionId = computeGovernanceDecisionId(identityInput.request);
  if (identityInput.receipt.requestDigest !== decisionId) {
    throw new Error('receipt requestDigest must equal the canonical request digest');
  }
  if (identityInput.receipt.decisionId !== decisionId) {
    throw new Error('receipt decisionId must equal the canonical request digest');
  }
  if (identityInput.receiptPath !== toGovernanceDecisionReceiptPath(decisionId)) {
    throw new Error('receipt path must equal the canonical decision path');
  }
  if (identityInput.request.expectedHeadOid !== identityInput.parentOid) {
    throw new Error('receipt request expectedHeadOid must equal the commit parent');
  }
}

function validateDeclaredChanges(receipt, changes) {
  for (const stateChange of receipt.stateChanges) {
    requireExactKeys(stateChange, ['path', 'before', 'after'], 'receipt state change');
    validateIdentity(stateChange.before, 'receipt state change before');
    validateIdentity(stateChange.after, 'receipt state change after');
  }
  const actualChanges = changes.map((change) => ({
    path: change.path,
    before: change.before,
    after: change.after,
  }));
  if (toCanonicalJson(receipt.stateChanges) !== toCanonicalJson(actualChanges)) {
    throw new Error('commit changes do not match receipt stateChanges');
  }
  const paths = receipt.stateChanges.map((change) => change.path);
  if (!isSortedUnique(paths)) {
    throw new Error('receipt stateChanges must be sorted with unique paths');
  }
}

function validateAllowedOperationPaths(request, stateChanges) {
  const allowedPaths = new Set(['plans/README.md', request.target.planPath]);
  if (request.operation === 'plan.supersede') {
    allowedPaths.add(request.payload.successorPlanPath);
  }
  for (const stateChange of stateChanges) {
    if (!allowedPaths.has(stateChange.path)) {
      throw new Error(
        `receipt declares a path that ${request.operation} cannot change: ${stateChange.path}`,
      );
    }
  }
}

function validateRequiredOperationChanges(request, stateChanges) {
  const byPath = new Map(stateChanges.map((change) => [change.path, change]));
  const registryChange = byPath.get('plans/README.md');
  if (registryChange?.after === null) {
    throw new Error(`${request.operation} must retain and regenerate plans/README.md`);
  }
  const targetChange = byPath.get(request.target.planPath);
  if (request.operation === 'plan.repair') {
    if (targetChange?.before === null || targetChange?.after === null) {
      throw new Error('plan.repair must replace its target plan');
    }
    return;
  }
  if (targetChange?.before === null || targetChange?.after !== null) {
    throw new Error(`${request.operation} must delete its target plan`);
  }
  if (request.operation === 'plan.supersede') {
    const successorChange = byPath.get(request.payload.successorPlanPath);
    if (successorChange?.before !== null || successorChange?.after === null) {
      throw new Error('plan.supersede must add exactly its successor plan');
    }
  }
}

function validateOperationResult(operation, result) {
  const expectedStatus = {
    'plan.repair': 'repaired',
    'plan.cancel': 'not-achieved',
    'plan.supersede': 'transferred',
    'plan.complete': 'admin-attested',
    'plan.quarantine': 'unknown',
  }[operation];
  if (
    !isRecord(result) ||
    Object.keys(result).length !== 1 ||
    result.acceptanceStatus !== expectedStatus
  ) {
    throw new Error(`${operation} receipt result must record ${expectedStatus}`);
  }
}

function computeSnapshotChanges(parentSnapshot, commitSnapshot) {
  const beforeByPath = new Map(parentSnapshot.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(commitSnapshot.entries.map((entry) => [entry.path, entry]));
  const allPaths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  const changes = [];
  for (const entryPath of [...allPaths].sort(compareText)) {
    const before = beforeByPath.get(entryPath);
    const after = afterByPath.get(entryPath);
    if (before?.mode === after?.mode && before?.blobOid === after?.blobOid) {
      continue;
    }
    changes.push({
      path: entryPath,
      before: before ? toIdentity(before) : null,
      after: after ? toIdentity(after) : null,
    });
  }
  return changes;
}

function toIdentity(entry) {
  return { blobOid: entry.blobOid, sha256: computeSha256(entry.content) };
}

function validateReadSnapshots(verificationInput, parentSnapshot, commitSnapshot) {
  if (parentSnapshot?.headOid !== verificationInput.parentOid) {
    throw new Error('repository reader returned the wrong parent snapshot');
  }
  if (commitSnapshot?.headOid !== verificationInput.commitOid) {
    throw new Error('repository reader returned the wrong commit snapshot');
  }
  if (!Array.isArray(parentSnapshot.entries) || !Array.isArray(commitSnapshot.entries)) {
    throw new Error('repository reader returned malformed snapshot entries');
  }
}

function isSortedUnique(values) {
  return (
    values.every((value) => typeof value === 'string') &&
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || compareText(values[index - 1], value) < 0)
  );
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateIdentity(identity, name) {
  if (identity === null) {
    return;
  }
  requireExactKeys(identity, ['blobOid', 'sha256'], name);
  if (!/^[0-9a-f]{40}$/u.test(identity.blobOid) || !/^[0-9a-f]{64}$/u.test(identity.sha256)) {
    throw new Error(`${name} must contain canonical content identities`);
  }
}

function requireExactKeys(value, expectedKeys, name) {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  const actualKeys = Object.keys(value).sort(compareText);
  const sortedExpectedKeys = [...expectedKeys].sort(compareText);
  if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpectedKeys)) {
    throw new Error(`${name} must contain exactly: ${expectedKeys.join(', ')}`);
  }
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
