import { computeSha256, toCanonicalJson } from './canonical-json.mjs';
import {
  computeGovernanceDecisionId,
  decodeGovernanceDecisionRequest,
} from './governance-decision-request.mjs';
import {
  createGovernanceDecisionReceipt,
  decodeGovernanceDecisionReceipt,
  toGovernanceDecisionReceiptPath,
} from './governance-decision-receipt.mjs';
import { computeGovernanceDecisionTransition } from './governance-decision-transition.mjs';

const receiptPathPattern = /^governance\/decisions\/[0-9a-f]{64}\.json$/u;

export function verifyGovernanceDecisionCommit(verificationInput) {
  if (typeof verificationInput.readRepositorySnapshot !== 'function') {
    throw new Error('commit verification requires an injected repository reader');
  }
  const commitSnapshot = verificationInput.readRepositorySnapshot(verificationInput.commitOid);
  if (
    commitSnapshot?.headOid !== verificationInput.commitOid ||
    !Array.isArray(commitSnapshot.entries)
  ) {
    throw new Error('repository reader returned the wrong commit snapshot');
  }
  if (!Array.isArray(commitSnapshot.parentOids) || commitSnapshot.parentOids.length !== 1) {
    throw new Error('governance decision commit must have exactly one actual parent');
  }
  const parentOid = commitSnapshot.parentOids[0];
  const parentSnapshot = verificationInput.readRepositorySnapshot(parentOid);
  if (parentSnapshot?.headOid !== parentOid || !Array.isArray(parentSnapshot.entries)) {
    throw new Error('repository reader returned the wrong parent snapshot');
  }
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
    parentOid,
  });
  const nonReceiptChanges = changes.filter((change) => change.path !== receiptChange.path);
  validateChangedFileModes(parentSnapshot, commitSnapshot, changes);
  validateDeclaredChanges(receipt, nonReceiptChanges);
  const normalizedReceipt = createGovernanceDecisionReceipt({
    request,
    actor: receipt.actor,
    transport: receipt.transport,
    result: receipt.result,
    bypassedInvariants: receipt.bypassedInvariants,
    stateChanges: receipt.stateChanges,
  });
  if (toCanonicalJson(normalizedReceipt) !== toCanonicalJson(receipt)) {
    throw new Error('receipt evidence must match the exact normalized receipt contract');
  }
  const transition = computeGovernanceDecisionTransition({
    request,
    snapshot: parentSnapshot,
    readChanges: verificationInput.readRepositoryChanges,
    readSnapshot: verificationInput.readRepositorySnapshot,
    readBlob: (blobOid) =>
      readCommitBlob({
        commitSnapshot,
        successorPlanPath: request.payload.successorPlanPath,
        blobOid,
      }),
    readGateEvidence: verificationInput.readGateEvidence,
  });
  validateReplayedTransition({
    transition,
    receipt,
    actualChanges: nonReceiptChanges,
    commitSnapshot,
  });
  return {
    decisionOnly: true,
    decisionId: receipt.decisionId,
    operation: request.operation,
    receiptPath: receiptChange.path,
    receipt,
  };
}

function validateReplayedTransition(replayInput) {
  requireReplayedEquality('result', replayInput.transition.result, replayInput.receipt.result);
  requireReplayedEquality(
    'bypassed invariants',
    replayInput.transition.bypassedInvariants,
    replayInput.receipt.bypassedInvariants,
  );
  requireReplayedEquality(
    'receipt state changes',
    replayInput.transition.stateChanges,
    replayInput.receipt.stateChanges,
  );
  requireReplayedEquality(
    'actual state changes',
    replayInput.transition.stateChanges,
    replayInput.actualChanges,
  );
  const actualEntries = new Map(
    replayInput.commitSnapshot.entries.map((entry) => [entry.path, entry]),
  );
  for (const addition of replayInput.transition.additions) {
    const actual = actualEntries.get(addition.path);
    if (actual?.mode !== '100644' || actual.content !== addition.content) {
      throw new Error('commit does not equal the deterministic governance transition');
    }
  }
  if (
    replayInput.transition.deletions.some((deletedPath) => actualEntries.has(deletedPath)) ||
    replayInput.transition.additions.length + replayInput.transition.deletions.length !==
      replayInput.actualChanges.length
  ) {
    throw new Error('commit does not equal the deterministic governance transition');
  }
}

function requireReplayedEquality(name, expected, actual) {
  if (toCanonicalJson(expected) !== toCanonicalJson(actual)) {
    throw new Error(`commit does not equal the deterministic governance transition: ${name}`);
  }
}

function readCommitBlob(blobInput) {
  const successorEntry = blobInput.commitSnapshot.entries.find(
    (entry) => entry.path === blobInput.successorPlanPath,
  );
  if (successorEntry?.blobOid !== blobInput.blobOid) {
    throw new Error('successor path must contain the requested successor blob');
  }
  return successorEntry.content;
}

function validateChangedFileModes(parentSnapshot, commitSnapshot, changes) {
  const beforeByPath = new Map(parentSnapshot.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(commitSnapshot.entries.map((entry) => [entry.path, entry]));
  for (const change of changes) {
    if (!(change.path.startsWith('plans/') || receiptPathPattern.test(change.path))) {
      continue;
    }
    const beforeMode = beforeByPath.get(change.path)?.mode;
    const afterMode = afterByPath.get(change.path)?.mode;
    if ((beforeMode && beforeMode !== '100644') || (afterMode && afterMode !== '100644')) {
      throw new Error(`changed governance path must be a regular 100644 file: ${change.path}`);
    }
  }
}

function parseCanonicalReceipt(content) {
  return decodeGovernanceDecisionReceipt(content);
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
