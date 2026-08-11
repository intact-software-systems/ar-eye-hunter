import { createHash } from 'node:crypto';

const requiredApprovalFields = [
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
const registryFields = [
  ['Repository-relative path and symbol', 'pathAndSymbol'],
  ['Purpose', 'purpose'],
  ['Canonical implementation owner', 'canonicalOwner'],
  ['Consumer or operational dependency', 'consumerDependency'],
  ['Why removal is unsafe now', 'unsafeRemovalReason'],
  ['Minimization already performed', 'minimization'],
  ['Approval date and human reviewer', 'approvalAndReviewer'],
  ['Approved production candidate SHA', 'approvedProductionSha'],
  ['Compatibility tests', 'compatibilityTests'],
  ['Named owner', 'owner'],
  ['Review or removal condition', 'removalCondition'],
  ['GitHub PR review ID', 'reviewId'],
];
const evidenceOnlyPaths = new Set(['docs/production-legacy-exceptions.md']);
const exactSha = /^[0-9a-f]{40}$/u;
const exactHash = /^[0-9a-f]{64}$/u;
const authorizedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function validateRetainedLegacy(input) {
  const retainedItems = input.finalReview.legacy.items.filter(
    (item) => item.disposition === 'retained-pending-human-approval',
  );
  const approvalById = new Map(
    input.record.retainedLegacy.map((approval) => [approval?.id, approval]),
  );

  if (approvalById.size !== input.record.retainedLegacy.length) {
    input.errors.push('retained legacy approval IDs must be unique');
  }
  const ledgerHash = retainedLedgerHash({ items: retainedItems, approvalById });
  const ledgerIds = retainedItems.map((item) => item.id).sort();

  for (const item of retainedItems) {
    const approval = approvalById.get(item.id);
    if (!approval) {
      input.errors.push(`retained legacy is missing trusted human approval: ${item.id}`);
      continue;
    }
    validateApproval({ approval, item, ledgerHash, ledgerIds, ...input });
  }

  for (const approval of input.record.retainedLegacy) {
    if (!retainedItems.some((item) => item.id === approval?.id)) {
      input.errors.push(
        `retained legacy approval does not match a final ledger item: ${String(approval?.id)}`,
      );
    }
  }
}

function validateApproval(input) {
  const { approval, item, errors } = input;
  if (!isRecord(approval)) {
    errors.push('retained legacy approval evidence must be an object');
    return;
  }
  for (const field of requiredApprovalFields) {
    if (field === 'reviewId') {
      if (!Number.isInteger(approval[field]) || approval[field] <= 0) {
        errors.push('retained legacy reviewId must be a positive integer');
      }
      continue;
    }
    validateText(approval[field], `retained legacy ${field}`, errors);
  }
  if (!exactSha.test(approval.approvedProductionSha ?? '')) {
    errors.push(`retained legacy approval SHA must be exact: ${item.id}`);
  }
  if (!exactHash.test(approval.ledgerSha256 ?? '')) {
    errors.push(`retained legacy ledger SHA-256 must be exact: ${item.id}`);
  }
  if (approval.path !== item.path || approval.symbol !== item.symbol) {
    errors.push(`retained legacy approval must match final ledger path and symbol: ${item.id}`);
  }
  if (approval.ledgerSha256 !== input.ledgerHash) {
    errors.push(`retained legacy ledger hash does not match the final ledger: ${item.id}`);
  }
  validateTrustedReview({
    approval,
    item,
    ledgerIds: input.ledgerIds,
    trustedReviews: input.trustedReviews,
    prAuthorLogin: input.prAuthorLogin,
    errors,
  });
  validatePostApprovalPaths({
    approval,
    currentHeadSha: input.headSha,
    historyBySha: input.approvalHistory,
    errors,
  });
  validateRegistry({ approval, registry: input.registry, errors });
}

function validateTrustedReview(input) {
  const review = input.trustedReviews.find(
    (candidate) => candidate?.id === input.approval.reviewId,
  );
  if (!isRecord(review)) {
    input.errors.push(`trusted GitHub approval review is missing: ${input.item.id}`);
    return;
  }
  if (review.state !== 'APPROVED') {
    input.errors.push(`trusted GitHub review is not approved: ${input.item.id}`);
  }
  if (review.user?.type !== 'User' || review.user?.login !== input.approval.reviewerLogin) {
    input.errors.push(`trusted GitHub review is not an approved human reviewer: ${input.item.id}`);
  }
  if (!authorizedAssociations.has(review.author_association)) {
    input.errors.push(
      `trusted GitHub review is not a repository-authorized reviewer: ${input.item.id}`,
    );
  }
  if (review.user?.login === input.prAuthorLogin) {
    input.errors.push(
      `trusted GitHub reviewer must not be the pull request author: ${input.item.id}`,
    );
  }
  if (!isLatestSubstantiveReview(review, input.trustedReviews)) {
    input.errors.push(
      `trusted GitHub review is not the actor's latest effective substantive review: ` +
        input.item.id,
    );
  }
  if (review.commit_id !== input.approval.approvedProductionSha) {
    input.errors.push(
      `trusted GitHub review does not approve the production SHA: ${input.item.id}`,
    );
  }
  if (review.submitted_at !== input.approval.approvalDate) {
    input.errors.push(`trusted GitHub review approval date does not match: ${input.item.id}`);
  }
  const approvalBody = [
    'PR-HUMAN-REVIEW-LEGACY-APPROVAL v1',
    `production-sha: ${input.approval.approvedProductionSha}`,
    `ledger-sha256: ${input.approval.ledgerSha256}`,
    `legacy-ids: ${input.ledgerIds.join(',')}`,
  ].join('\n');
  if (typeof review.body !== 'string' || !review.body.includes(approvalBody)) {
    input.errors.push(
      `trusted GitHub review does not bind the retained legacy ledger: ${input.item.id}`,
    );
  }
}

function isLatestSubstantiveReview(review, reviews) {
  const sameActor = reviews.filter(
    (candidate) =>
      candidate?.user?.login === review.user?.login &&
      ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(candidate?.state),
  );
  return sameActor.every(
    (candidate) => candidate.id === review.id || compareReview(candidate, review) <= 0,
  );
}

function compareReview(left, right) {
  const leftTime = Date.parse(left.submitted_at ?? '');
  const rightTime = Date.parse(right.submitted_at ?? '');
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return Number(left.id) - Number(right.id);
}

function validatePostApprovalPaths(input) {
  if (input.approval.approvedProductionSha === input.currentHeadSha) {
    return;
  }
  const history = input.historyBySha?.[input.approval.approvedProductionSha];
  if (!isRecord(history) || history.isAncestor !== true || !Array.isArray(history.changedPaths)) {
    input.errors.push(
      `post-approval path evidence is missing: ${input.itemId ?? input.approval.id}`,
    );
    return;
  }
  for (const path of history.changedPaths) {
    if (!evidenceOnlyPaths.has(path)) {
      input.errors.push(
        `production change invalidates retained legacy approval: ${input.approval.id}`,
      );
      return;
    }
  }
}

function validateRegistry(input) {
  const section = readRegistrySection(input.registry, input.approval.id);
  if (!section) {
    input.errors.push(`retained legacy registry entry is missing: ${input.approval.id}`);
    return;
  }
  const expectedByField = {
    pathAndSymbol: `${input.approval.path}#${input.approval.symbol}`,
    purpose: input.approval.purpose,
    canonicalOwner: input.approval.canonicalOwner,
    consumerDependency: input.approval.consumerDependency,
    unsafeRemovalReason: input.approval.unsafeRemovalReason,
    minimization: input.approval.minimization,
    approvalAndReviewer: `${input.approval.approvalDate} — ${input.approval.reviewerLogin}`,
    approvedProductionSha: input.approval.approvedProductionSha,
    compatibilityTests: input.approval.compatibilityTests,
    owner: input.approval.owner,
    removalCondition: input.approval.removalCondition,
    reviewId: String(input.approval.reviewId),
  };
  for (const [label, field] of registryFields) {
    const actual = readRegistryField(section, label);
    if (normalize(actual) !== normalize(expectedByField[field])) {
      input.errors.push(
        `retained legacy registry ${label} does not match approved ledger: ${input.approval.id}`,
      );
    }
  }
}

export function retainedLedgerHash(input) {
  return createHash('sha256')
    .update(JSON.stringify(retainedLedgerProjection(input)))
    .digest('hex');
}

export function retainedLedgerProjection(input) {
  const items = input.items ?? [input.item];
  const approvalById = input.approvalById ?? new Map([[input.approval?.id, input.approval]]);
  return items
    .map((item) => ledgerItem(item, approvalById.get(item.id)))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function ledgerItem(item, approval) {
  const canonicalItem = {
    id: item?.id,
    path: item?.path,
    symbol: item?.symbol,
    disposition: item?.disposition,
  };
  return approval ? { ...canonicalItem, ...approvalDetail(approval) } : canonicalItem;
}

function approvalDetail(approval) {
  const fields = [
    'purpose',
    'consumerDependency',
    'unsafeRemovalReason',
    'minimization',
    'canonicalOwner',
    'compatibilityTests',
    'owner',
    'removalCondition',
    'approvedProductionSha',
  ];
  return Object.fromEntries(fields.map((field) => [field, approval?.[field]]));
}

function readRegistrySection(registry, identifier) {
  const matches = [
    ...registry.matchAll(new RegExp(`^### ${escapeRegExp(identifier)}\\s*$`, 'gmu')),
  ];
  if (matches.length !== 1 || matches[0].index === undefined) {
    return undefined;
  }
  const start = matches[0].index;
  const nextHeading = registry.indexOf('\n### ', start + matches[0][0].length);
  return registry.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

function readRegistryField(section, label) {
  const matches = [...section.matchAll(new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+)$`, 'gmu'))];
  return matches.length === 1 ? matches[0][1] : undefined;
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
