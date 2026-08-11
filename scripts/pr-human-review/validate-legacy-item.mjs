const validDispositions = new Set([
  'removed',
  'minimized-boundary',
  'resolved',
  'retained-pending-human-approval',
]);
const exactSha = /^[0-9a-f]{40}$/u;
const exactHash = /^[0-9a-f]{64}$/u;

export const retainedApprovalFields = [
  'id',
  'path',
  'symbol',
  'purpose',
  'consumerDependency',
  'unsafeRemovalReason',
  'minimization',
  'canonicalOwner',
  'compatibilityTests',
  'owner',
  'removalCondition',
  'approvedProductionSha',
  'reviewId',
  'reviewerLogin',
  'approvalDate',
  'ledgerSha256',
];
const retainedApprovalOnlyFields = retainedApprovalFields.filter(
  (field) => !['id', 'path', 'symbol'].includes(field),
);

export function validateLegacyItemShape(input) {
  const { item, label, errors } = input;
  const retainedApproval = input.retainedApproval;
  if (item.classification === 'not-legacy') {
    if (!isConcreteRationale(item.rationale)) {
      errors.push(`${label} not-legacy candidate requires a concrete rationale: ${item.id}`);
    }
    if (
      item.disposition !== undefined ||
      retainedApproval !== undefined ||
      retainedApprovalOnlyFields.some((field) => item[field] !== undefined)
    ) {
      errors.push(`${label} not-legacy item must not contain legacy disposition or approval`);
    }
    return;
  }
  if (item.classification !== 'legacy' && item.classification !== undefined) {
    errors.push(`${label} ledger classification is invalid: ${String(item.classification)}`);
    return;
  }
  if (!validDispositions.has(item.disposition)) {
    errors.push(`${label} ledger contains a malformed disposition`);
  }
  if (item.rationale !== undefined) {
    errors.push(`${label} legacy item must not contain a not-legacy rationale: ${item.id}`);
  }
  if (item.disposition === 'retained-pending-human-approval' && input.requireRetainedApproval) {
    validateRetainedApprovalShape({
      approval: retainedApproval,
      itemId: item.id,
      errors,
    });
  }
}

export function validateRetainedApprovalShape({ approval, itemId, errors }) {
  if (!isPlainRecord(approval)) {
    errors.push(`retained legacy is missing complete approval evidence: ${itemId}`);
    return false;
  }
  let valid = true;
  for (const field of retainedApprovalFields) {
    if (field === 'reviewId') {
      if (!Number.isInteger(approval[field]) || approval[field] <= 0) {
        errors.push('retained legacy reviewId must be a positive integer');
        valid = false;
      }
      continue;
    }
    if (!isEvidenceText(approval[field])) {
      errors.push(`retained legacy ${field} is required`);
      valid = false;
    }
  }
  if (!exactSha.test(approval.approvedProductionSha ?? '')) {
    errors.push(`retained legacy approval SHA must be exact: ${itemId}`);
    valid = false;
  }
  if (!exactHash.test(approval.ledgerSha256 ?? '')) {
    errors.push(`retained legacy ledger SHA-256 must be exact: ${itemId}`);
    valid = false;
  }
  return valid;
}

function isConcreteRationale(value) {
  if (typeof value !== 'string' || value.trim().length < 12) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return !['todo', 'tbd', 'not applicable', 'false positive', '...'].includes(normalized);
}

function isEvidenceText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return !(
    ['todo', 'tbd', 'not applicable', 'not yet required', '...', '-'].includes(normalized) ||
    normalized.includes('<placeholder>') ||
    normalized.includes('[placeholder]')
  );
}

function isPlainRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
