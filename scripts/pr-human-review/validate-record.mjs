const recordFence = /```pr-human-review-record-v1\s*\n([\s\S]*?)\n```/u;
const exactSha = /^[0-9a-f]{40}$/u;
const allowedExemptPaths = [/^docs\//u, /^plans\//u, /^\.agents\//u, /^AGENTS\.md$/u];
const requiredNarrativeLabels = [
  '## PR Human Review Record v1',
  '### PR classification',
  '### Initial independent review',
  'Production owner-to-result trace:',
  'Cognitive-indirection findings:',
  'Complete review findings and resolution/status:',
  'Tests rewritten or removed:',
  'Production was not compromised for tests:',
  'Behavior and judgment not proven by automation:',
  'Legacy candidate count:',
  'Legacy ledger and dispositions:',
  '### Complete code and legacy review',
];
const requiredNarrativeKeys = [
  'productionOwnerToResultTrace',
  'cognitiveIndirectionFindings',
  'testsRewrittenOrRemoved',
  'productionNotCompromisedForTests',
  'automationGaps',
  'completeFindings',
];
const validDispositions = new Set([
  'removed',
  'minimized-boundary',
  'resolved',
  'retained-pending-human-approval',
]);
const requiredRetainedFields = [
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
  'approvedHeadSha',
  'humanApprover',
  'approvalDate',
];
const requiredRegistryLabels = [
  'Repository-relative path and symbol',
  'Purpose',
  'Canonical implementation owner',
  'Consumer or operational dependency',
  'Why removal is unsafe now',
  'Minimization already performed',
  'Approval date and human reviewer',
  'Approved candidate head SHA',
  'Compatibility tests',
  'Named owner',
  'Review or removal condition',
];
export function validateReviewRecord(input) {
  const errors = [];
  const record = readRecord(input.body, errors);
  if (!record) {
    return errors;
  }
  validateNarrative(input.body, errors);
  validateCurrentShas(input, errors);
  validateRecordShape(record, errors);
  if (record.scope === 'exempt') {
    validateExemption(record, input.changedPaths, errors);
    return errors;
  }
  if (record.scope !== 'code-changing') {
    return errors;
  }
  const initialReview = validateReview(record.initialReview, 'initial', errors);
  if (input.draft) {
    validateFreshReview({ review: initialReview, stage: 'initial', input, errors });
    return errors;
  }

  const finalReview = validateReview(record.finalReview, 'final', errors);
  validateFreshReview({ review: finalReview, stage: 'final', input, errors });
  validateFinalFindings(finalReview, errors);
  validateRetainedLegacy({ record, finalReview, input, errors });
  return errors;
}

function readRecord(body, errors) {
  const match = body.match(recordFence);
  if (!match) {
    errors.push('PR Human Review Record v1 metadata block is missing');
    return undefined;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    errors.push('PR Human Review Record v1 metadata block is not valid JSON');
    return undefined;
  }
}

function validateNarrative(body, errors) {
  for (const label of requiredNarrativeLabels) {
    if (!body.includes(label)) {
      errors.push(`required narrative section is missing: ${label}`);
    }
  }
}

function validateCurrentShas(input, errors) {
  if (!isExactSha(input.baseSha)) {
    errors.push('current base SHA must be a full 40-character lowercase SHA');
  }
  if (!isExactSha(input.headSha)) {
    errors.push('current head SHA must be a full 40-character lowercase SHA');
  }
}

function validateRecordShape(record, errors) {
  if (!isRecord(record) || record.version !== 1) {
    errors.push('PR Human Review Record v1 metadata must be an object with version 1');
    return;
  }
  if (record.scope !== 'code-changing' && record.scope !== 'exempt') {
    errors.push('review scope must be code-changing or exempt');
  }
  if (!Array.isArray(record.retainedLegacy)) {
    errors.push('retainedLegacy must be an array');
  }
}

function validateExemption(record, changedPaths, errors) {
  if (!isRecord(record.exemption)) {
    errors.push('explicit exemption evidence is required for an exempt pull request');
    return;
  }

  const exemption = record.exemption;
  if (!['plan-only', 'documentation-only', 'agent-guidance-only'].includes(exemption.kind)) {
    errors.push('exemption kind must be plan-only, documentation-only, or agent-guidance-only');
  }
  if (!Array.isArray(exemption.changedPaths) || exemption.changedPaths.length === 0) {
    errors.push('exemption must name every changed path');
    return;
  }
  if (!samePaths(exemption.changedPaths, changedPaths)) {
    errors.push('exemption changed paths must exactly match the observed changed paths');
  }

  for (const changedPath of changedPaths) {
    if (
      typeof changedPath !== 'string' ||
      !allowedExemptPaths.some((pattern) => pattern.test(changedPath))
    ) {
      errors.push(`exemption path is not allowed: ${String(changedPath)}`);
    }
  }
}

function validateReview(review, stage, errors) {
  if (!isRecord(review)) {
    errors.push(`${stage} review metadata is required`);
    return undefined;
  }

  validateText(review.reviewer, `${stage} reviewer`, errors);
  if (review.independence !== 'separate-agent-or-human') {
    errors.push(`${stage} review must identify a separate agent or human`);
  }
  if (!isExactSha(review.baseSha)) {
    errors.push(`${stage} review base SHA must be a full 40-character lowercase SHA`);
  }
  if (!isExactSha(review.headSha)) {
    errors.push(`${stage} review head SHA must be a full 40-character lowercase SHA`);
  }
  if (!['pass', 'changes-requested'].includes(review.verdict)) {
    errors.push(`${stage} review verdict must be pass or changes-requested`);
  }
  validateFindings(review.unresolvedFindings, stage, errors);
  validateNarrativeEvidence(review.narrative, stage, errors);
  validateLegacyLedger(review.legacy, stage, errors);
  return review;
}

function validateFreshReview({ review, stage, input, errors }) {
  if (!review) {
    return;
  }
  if (review.baseSha !== input.baseSha) {
    errors.push(`${stage} review base SHA must match current base`);
  }
  if (review.headSha !== input.headSha) {
    errors.push(`${stage} review head SHA must match current head`);
  }
}

function validateFindings(findings, stage, errors) {
  if (!isRecord(findings)) {
    errors.push(`${stage} review unresolved findings are required`);
    return;
  }
  for (const severity of ['critical', 'important']) {
    if (!Number.isInteger(findings[severity]) || findings[severity] < 0) {
      errors.push(`${stage} review ${severity} finding count must be a non-negative integer`);
    }
  }
}

function validateNarrativeEvidence(narrative, stage, errors) {
  if (!isRecord(narrative)) {
    errors.push(`${stage} review narrative evidence is required`);
    return;
  }
  for (const key of requiredNarrativeKeys) {
    validateText(narrative[key], `${stage} review ${key}`, errors);
  }
}

function validateLegacyLedger(legacy, stage, errors) {
  if (!isRecord(legacy)) {
    errors.push(`${stage} review legacy ledger is required`);
    return;
  }
  if (!Number.isInteger(legacy.candidateCount) || legacy.candidateCount < 0) {
    errors.push(`${stage} review legacy candidate count must be a non-negative integer`);
  }
  if (!Array.isArray(legacy.items)) {
    errors.push(`${stage} review legacy ledger items must be an array`);
    return;
  }
  if (legacy.candidateCount !== legacy.items.length) {
    errors.push(`${stage} review legacy candidate count must equal ledger items`);
  }

  const identifiers = new Set();
  for (const item of legacy.items) {
    if (!isRecord(item)) {
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
  if (!review || !isRecord(review.unresolvedFindings)) {
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

function validateRetainedLegacy({ record, finalReview, input, errors }) {
  if (!finalReview || !isRecord(finalReview.legacy) || !Array.isArray(finalReview.legacy.items)) {
    return;
  }
  const retainedItems = finalReview.legacy.items.filter(
    (item) => isRecord(item) && item.disposition === 'retained-pending-human-approval',
  );
  const approvals = Array.isArray(record.retainedLegacy) ? record.retainedLegacy : [];
  const approvalById = new Map(approvals.map((approval) => [approval?.id, approval]));

  if (approvalById.size !== approvals.length) {
    errors.push('retained legacy approval IDs must be unique');
  }

  for (const item of retainedItems) {
    const approval = approvalById.get(item.id);
    if (!approval) {
      errors.push(`retained legacy is missing human approval evidence: ${item.id}`);
      continue;
    }
    validateRetainedApproval({ approval, ledgerItem: item, input, errors });
    validateRegistryEntry({ registry: input.registry, approval, headSha: input.headSha, errors });
  }

  for (const approval of approvals) {
    if (!retainedItems.some((item) => item.id === approval?.id)) {
      errors.push(
        `retained legacy approval does not match a final ledger item: ${String(approval?.id)}`,
      );
    }
  }
}

function validateRetainedApproval({ approval, ledgerItem, input, errors }) {
  if (!isRecord(approval)) {
    errors.push('retained legacy approval evidence must be an object');
    return;
  }
  for (const field of requiredRetainedFields) {
    validateText(approval[field], `retained legacy ${field}`, errors);
  }
  if (approval.path !== ledgerItem.path || approval.symbol !== ledgerItem.symbol) {
    errors.push(
      `retained legacy approval must match final ledger path and symbol: ${ledgerItem.id}`,
    );
  }
  if (approval.approvedHeadSha !== input.headSha) {
    errors.push(`retained legacy approval must match current head: ${ledgerItem.id}`);
  }
  if (!isExactSha(approval.approvedHeadSha)) {
    errors.push(
      `retained legacy approval SHA must be a full 40-character lowercase SHA: ${ledgerItem.id}`,
    );
  }
}

function validateRegistryEntry({ registry, approval, headSha, errors }) {
  const section = readRegistrySection(registry, approval.id);
  if (!section) {
    errors.push(`retained legacy registry entry is missing: ${approval.id}`);
    return;
  }
  for (const label of requiredRegistryLabels) {
    const value = readRegistryField(section, label);
    validateText(value, `retained legacy registry ${label}`, errors);
  }
  if (readRegistryField(section, 'Approved candidate head SHA') !== headSha) {
    errors.push(`retained legacy registry approval must match current head: ${approval.id}`);
  }
}

function readRegistrySection(registry, identifier) {
  const heading = new RegExp(`^### ${escapeRegExp(identifier)}\\s*$`, 'mu');
  const match = heading.exec(registry);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const nextHeading = registry.indexOf('\n### ', match.index + match[0].length);
  return registry.slice(match.index, nextHeading === -1 ? undefined : nextHeading);
}

function readRegistryField(section, label) {
  const field = new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+)$`, 'mu');
  return section.match(field)?.[1];
}

function validateText(value, label, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${label} is required`);
    return;
  }
  if (isPlaceholder(value)) {
    errors.push(`${label} contains placeholder evidence`);
  }
}

function isPlaceholder(value) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'todo' ||
    normalized === 'tbd' ||
    normalized === 'not applicable' ||
    normalized === 'not yet required' ||
    normalized === '...' ||
    normalized === '-' ||
    normalized.includes('<placeholder>') ||
    normalized.includes('[placeholder]')
  );
}

function samePaths(expectedPaths, actualPaths) {
  if (!Array.isArray(actualPaths) || expectedPaths.length !== actualPaths.length) {
    return false;
  }
  return expectedPaths.every((path, index) => path === actualPaths[index]);
}

export function isExactSha(value) {
  return typeof value === 'string' && exactSha.test(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
