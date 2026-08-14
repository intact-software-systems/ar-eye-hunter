import { retainedLedgerProjection } from './trusted-retained-legacy.mjs';
import {
  notLegacyAggregateFields,
  resolveNotLegacyAggregateCount,
  validateLegacyItemShape,
  validateNotLegacyAggregateShape,
} from './validate-legacy-item.mjs';

const exactSha = /^[0-9a-f]{40}$/u;
const exactDigest = /^[0-9a-f]{64}$/u;

export function validateInitialReview({ review, reviewedPlanContext, section, errors }) {
  if (!isPlainRecord(review)) {
    errors.push('initial review metadata is required');
    return undefined;
  }
  if (review.status !== 'complete') {
    errors.push('initial review status must be complete');
  }
  validateReviewer(review, 'initial', errors);
  validateDigest(review.adaptivePlanDigest, 'initial review adaptive-plan digest', errors);
  validateExactSha(review.mergeBaseSha, 'initial review merge base SHA', errors);
  validateExactSha(review.headSha, 'initial review head SHA', errors);
  validateText(review.goal, 'initial review goal', errors);
  validateTextArray(review.acceptanceCriteria, 'initial review acceptanceCriteria', errors);
  validateText(review.capabilityTreeHypothesis, 'initial review capabilityTreeHypothesis', errors);
  validateOwnerEntries(
    review.canonicalOwnerEntries,
    'initial review canonicalOwnerEntries',
    errors,
  );
  if (
    !Array.isArray(review.firstSlices) ||
    review.firstSlices.length < 1 ||
    review.firstSlices.length > 2
  ) {
    errors.push('initial review firstSlices must contain one or two slices');
  } else {
    validateTextArray(review.firstSlices, 'initial review firstSlices', errors);
  }
  validateText(review.completeFindings, 'initial review completeFindings', errors);
  validateText(review.automationGaps, 'initial review automationGaps', errors);
  validateInitialPlanBinding(review, reviewedPlanContext, errors);
  validateFindings(review, 'initial', errors);
  validateLegacyLedger({ legacy: review.legacy, stage: 'initial', errors });
  validateVisibleFields({
    section,
    stage: 'initial',
    fields: [
      ['Record status', review.status, 'status'],
      [
        'Reviewer and independence (separate agent or human)',
        `${review.reviewer} — ${review.independence}`,
        'reviewer',
      ],
      ['Reviewed adaptive-plan digest', review.adaptivePlanDigest, 'adaptivePlanDigest'],
      ['Goal', review.goal, 'goal'],
      ['Acceptance criteria', JSON.stringify(review.acceptanceCriteria), 'acceptanceCriteria'],
      ['Capability-tree hypothesis', review.capabilityTreeHypothesis, 'capabilityTreeHypothesis'],
      [
        'Canonical owners and entries',
        JSON.stringify(review.canonicalOwnerEntries),
        'canonicalOwnerEntries',
      ],
      ['First two slices', JSON.stringify(review.firstSlices), 'firstSlices'],
      [
        'Complete review findings and resolution/status',
        review.completeFindings,
        'completeFindings',
      ],
      ['Behavior and judgment not proven by automation', review.automationGaps, 'automationGaps'],
      ['Legacy candidate count', String(review.legacy?.candidateCount), 'legacyCandidateCount'],
      [
        'Legacy ledger and dispositions',
        JSON.stringify(visibleLegacyLedger(review.legacy, 'initial', [])),
        'legacyLedger',
      ],
      ['Critical findings unresolved', String(review.unresolvedFindings?.critical), 'critical'],
      ['Important findings unresolved', String(review.unresolvedFindings?.important), 'important'],
      ['Verdict', review.verdict, 'verdict'],
    ],
    errors,
  });
  return review;
}

function validateInitialPlanBinding(review, reviewedPlanContext, errors) {
  if (!isPlainRecord(reviewedPlanContext)) {
    errors.push('initial review plan snapshot evidence is required');
    return;
  }
  if (review.adaptivePlanDigest !== reviewedPlanContext.digest) {
    errors.push('initial review adaptive-plan digest must match the reviewed plan');
  }
  if (review.goal !== reviewedPlanContext.goal) {
    errors.push('initial review goal must match the reviewed plan');
  }
  if (!sameTextArray(review.acceptanceCriteria, reviewedPlanContext.acceptanceCriteria)) {
    errors.push('initial review acceptance criteria must match the reviewed plan');
  }
  if (review.capabilityTreeHypothesis !== reviewedPlanContext.capabilityTreeHypothesis) {
    errors.push('initial review capability-tree hypothesis must match the reviewed plan');
  }
  if (!sameOwnerEntries(review.canonicalOwnerEntries, reviewedPlanContext.initialOwnerEntries)) {
    errors.push('initial review canonical owners and entries must match the reviewed plan');
  }
  if (!sameTextArray(review.firstSlices, reviewedPlanContext.firstSlices)) {
    errors.push('initial review first slices must match the reviewed plan');
  }
}

export function validateCheckpointReview({ checkpointReview, currentPlan, section, errors }) {
  if (!isPlainRecord(checkpointReview)) {
    errors.push('checkpoint review metadata is required');
    return;
  }
  const unsupportedFields = Object.keys(checkpointReview).filter(
    (field) => field !== 'adaptivePlanDigest',
  );
  if (unsupportedFields.length > 0) {
    errors.push(`checkpoint review contains unsupported fields: ${unsupportedFields.join(', ')}`);
  }
  validateDigest(
    checkpointReview.adaptivePlanDigest,
    'checkpoint review adaptive-plan digest',
    errors,
  );
  if (checkpointReview.adaptivePlanDigest !== currentPlan?.digest) {
    errors.push('checkpoint review adaptive-plan digest must match the current plan');
  }
  validateVisibleFields({
    section,
    stage: 'checkpoint',
    fields: [
      ['Current adaptive-plan digest', checkpointReview.adaptivePlanDigest, 'adaptivePlanDigest'],
    ],
    errors,
  });
  validateCheckpointSectionShape(section, checkpointReview.adaptivePlanDigest, errors);
}

function validateCheckpointSectionShape(section, adaptivePlanDigest, errors) {
  if (typeof section !== 'string') {
    return;
  }
  const visibleLines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const expectedLines = [
    '### Current checkpoint review',
    `- Current adaptive-plan digest: ${adaptivePlanDigest}`,
  ];
  if (!sameTextArray(visibleLines, expectedLines)) {
    errors.push('visible checkpoint review must contain only the current adaptive-plan digest');
  }
}

export function validateFinalReview(input) {
  const { review, currentPlan, currentBuildTreeDigest, reviewedBuildTreeDigestBySha, section } =
    input;
  const { retainedLegacy, errors } = input;
  if (!isPlainRecord(review)) {
    errors.push('final review metadata is required');
    return undefined;
  }
  validateReviewer(review, 'final', errors);
  validateExactSha(review.mergeBaseSha, 'final review merge base SHA', errors);
  validateExactSha(review.headSha, 'final review head SHA', errors);
  validateFinalFreshness({
    freshness: review.freshness,
    reviewHeadSha: review.headSha,
    currentPlan,
    currentBuildTreeDigest,
    reviewedBuildTreeDigestBySha,
    errors,
  });
  for (const field of [
    'declaredOutcomes',
    'navigationEvidence',
    'testEvidence',
    'compatibilityEvidence',
    'proportionalValidation',
    'touchedFileStandardsClosure',
    'legacyClosure',
    'completeFindings',
    'automationGaps',
  ]) {
    validateText(review[field], `final review ${field}`, errors);
  }
  validateFinalOwnerPaths(review.ownerToResultPaths, currentPlan?.ownerEntries, errors);
  validateFindings(review, 'final', errors);
  validateLegacyLedger({ legacy: review.legacy, stage: 'final', retainedLegacy, errors });
  validateVisibleFields({
    section,
    stage: 'final',
    fields: finalVisibleFields(review, retainedLegacy),
    errors,
  });
  return review;
}

export function validateFinalFindings(review, errors) {
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

export function readVisibleReviewSections(body, errors) {
  const headings = [
    '### Initial architecture review',
    '### Current checkpoint review',
    '### Complete code, structure, tests, and legacy review',
  ];
  const positions = headings.map((heading) => findUniqueHeading(body, heading, errors));
  if (positions.some((position) => position === undefined)) {
    return {};
  }
  if (!(positions[0] < positions[1] && positions[1] < positions[2])) {
    errors.push('visible PR review sections must be ordered initial, checkpoint, final');
    return {};
  }
  return {
    initial: body.slice(positions[0], positions[1]),
    checkpoint: body.slice(positions[1], positions[2]),
    final: readHeadingSection(body, positions[2], headings[2]),
  };
}

function validateFinalFreshness(input) {
  const { freshness, currentPlan, errors } = input;
  if (!isPlainRecord(freshness)) {
    errors.push('final review freshness evidence is required');
    return;
  }
  validateDigest(freshness.buildTreeDigest, 'final review build-affecting tree digest', errors);
  if (freshness.buildTreeDigest !== input.currentBuildTreeDigest) {
    errors.push('final review build-affecting tree digest must match the current tree');
  }
  if (input.reviewedBuildTreeDigestBySha?.[input.reviewHeadSha] !== freshness.buildTreeDigest) {
    errors.push('final review build-affecting tree digest must match its reviewed head');
  }
  if (freshness.planGoal !== currentPlan?.goal) {
    errors.push('final review plan goal must match the current adaptive plan');
  }
  if (!sameTextArray(freshness.acceptanceCriteria, currentPlan?.acceptanceCriteria)) {
    errors.push('final review acceptance criteria must match the current adaptive plan');
  }
  if (freshness.structuralDecision !== currentPlan?.structuralDecision) {
    errors.push('final review structural decision must match the current adaptive plan');
  }
}

function validateFinalOwnerPaths(ownerToResultPaths, expectedOwnerEntries, errors) {
  if (!Array.isArray(ownerToResultPaths)) {
    errors.push('final review ownerToResultPaths must be an array');
    return;
  }
  for (const [index, ownerPath] of ownerToResultPaths.entries()) {
    if (!isPlainRecord(ownerPath)) {
      errors.push(`final review ownerToResultPaths[${index}] must be an object`);
      continue;
    }
    for (const field of ['owner', 'entry', 'result', 'trace']) {
      validateText(ownerPath[field], `final review ownerToResultPaths[${index}].${field}`, errors);
    }
  }
  const actual = ownerToResultPaths.map(ownerEntryKey).sort();
  const expected = Array.isArray(expectedOwnerEntries)
    ? expectedOwnerEntries.map(ownerEntryKey).sort()
    : [];
  if (!sameTextArray(actual, expected)) {
    errors.push(
      'final review owner-to-result paths must cover every declared capability owner and entry',
    );
  }
}

function finalVisibleFields(review, retainedLegacy) {
  return [
    [
      'Reviewer and independence (separate agent or human)',
      `${review.reviewer} — ${review.independence}`,
      'reviewer',
    ],
    ['Build-affecting tree digest', review.freshness?.buildTreeDigest, 'buildTreeDigest'],
    ['Plan goal', review.freshness?.planGoal, 'planGoal'],
    [
      'Acceptance criteria',
      JSON.stringify(review.freshness?.acceptanceCriteria),
      'acceptanceCriteria',
    ],
    ['Current structural decision', review.freshness?.structuralDecision, 'structuralDecision'],
    ['Declared outcomes', review.declaredOutcomes, 'declaredOutcomes'],
    ['Owner-to-result paths', JSON.stringify(review.ownerToResultPaths), 'ownerToResultPaths'],
    ['Navigation evidence', review.navigationEvidence, 'navigationEvidence'],
    ['Test evidence', review.testEvidence, 'testEvidence'],
    ['Compatibility evidence', review.compatibilityEvidence, 'compatibilityEvidence'],
    ['Proportional validation', review.proportionalValidation, 'proportionalValidation'],
    [
      'Touched-file standards closure',
      review.touchedFileStandardsClosure,
      'touchedFileStandardsClosure',
    ],
    ['Legacy closure', review.legacyClosure, 'legacyClosure'],
    ['Complete review findings and resolution/status', review.completeFindings, 'completeFindings'],
    ['Behavior and judgment not proven by automation', review.automationGaps, 'automationGaps'],
    [
      'Legacy candidates inspected ' +
        '(baseline, automated report, changed files, and production call paths)',
      review.legacy?.candidatesInspected,
      'candidatesInspected',
    ],
    ['Legacy candidate count', String(review.legacy?.candidateCount), 'legacyCandidateCount'],
    [
      'Legacy ledger and dispositions',
      JSON.stringify(visibleLegacyLedger(review.legacy, 'final', retainedLegacy)),
      'legacyLedger',
    ],
    ['Critical findings unresolved', String(review.unresolvedFindings?.critical), 'critical'],
    ['Important findings unresolved', String(review.unresolvedFindings?.important), 'important'],
    ['Verdict', review.verdict, 'verdict'],
  ];
}

function validateReviewer(review, stage, errors) {
  validateText(review.reviewer, `${stage} reviewer`, errors);
  if (review.independence !== 'separate-agent-or-human') {
    errors.push(`${stage} review must identify a separate agent or human`);
  }
}

function validateFindings(review, stage, errors) {
  if (!isPlainRecord(review.unresolvedFindings)) {
    errors.push(`${stage} review unresolved findings are required`);
  } else {
    for (const severity of ['critical', 'important']) {
      const findingCount = review.unresolvedFindings[severity];
      if (!Number.isInteger(findingCount) || findingCount < 0) {
        errors.push(`${stage} review ${severity} finding count must be a non-negative integer`);
      }
    }
  }
  if (!['pass', 'changes-requested'].includes(review.verdict)) {
    errors.push(`${stage} review verdict must be pass or changes-requested`);
  }
}

function validateOwnerEntries(entries, label, errors) {
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  for (const [index, entry] of entries.entries()) {
    if (!isPlainRecord(entry)) {
      errors.push(`${label}[${index}] must be an object`);
      continue;
    }
    validateText(entry.owner, `${label}[${index}].owner`, errors);
    validateText(entry.entry, `${label}[${index}].entry`, errors);
  }
}

function validateVisibleFields({ section, stage, fields, errors }) {
  for (const [label, expected, name] of fields) {
    const visible = readVisibleField(section, label);
    validateText(visible, `${stage} visible review ${name}`, errors);
    if (normalize(visible) !== normalize(String(expected))) {
      errors.push(`visible ${stage} review contradicts metadata: ${name}`);
    }
  }
}

function visibleLegacyLedger(legacy, stage, retainedLegacy) {
  const items = visibleLedgerItems(legacy?.items ?? [], stage, retainedLegacy);
  const aggregate = legacy?.notLegacyAggregate;
  if (!isPlainRecord(aggregate)) {
    return items;
  }
  return {
    items,
    notLegacyAggregate: Object.fromEntries(
      notLegacyAggregateFields.map((field) => [field, aggregate[field]]),
    ),
  };
}

function visibleLedgerItems(items, stage, retainedLegacy) {
  if (stage !== 'final') {
    return [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }
  const approvals = Array.isArray(retainedLegacy) ? retainedLegacy : [];
  return retainedLedgerProjection({
    items,
    approvalById: new Map(approvals.map((approval) => [approval?.id, approval])),
  });
}

function validateLegacyLedger({ legacy, stage, retainedLegacy = [], errors }) {
  if (!isPlainRecord(legacy) || !Array.isArray(legacy.items)) {
    errors.push(`${stage} review legacy ledger is required`);
    return;
  }
  const aggregate = legacy.notLegacyAggregate;
  if (aggregate !== undefined) {
    validateNotLegacyAggregateShape({ aggregate, label: `${stage} review`, errors });
  }
  const expectedCount = legacy.items.length + resolveNotLegacyAggregateCount(aggregate);
  if (!Number.isInteger(legacy.candidateCount) || legacy.candidateCount !== expectedCount) {
    errors.push(`${stage} review legacy candidate count must equal ledger coverage`);
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
    validateLegacyItemShape({
      item,
      label: `${stage} review`,
      retainedApproval: retainedLegacy.find((approval) => approval?.id === item.id),
      requireRetainedApproval: stage === 'final',
      errors,
    });
    if (identifiers.has(item.id)) {
      errors.push(`${stage} review legacy ledger has a duplicate item ID: ${item.id}`);
    }
    identifiers.add(item.id);
  }
  if (stage === 'final') {
    validateText(legacy.candidatesInspected, 'final review legacy candidatesInspected', errors);
  }
}

function findUniqueHeading(body, heading, errors) {
  const matches = [...body.matchAll(new RegExp(`^${escapeRegExp(heading)}$`, 'gmu'))];
  if (matches.length !== 1 || matches[0].index === undefined) {
    errors.push(`visible PR record must contain exactly one ${heading} section`);
    return undefined;
  }
  return matches[0].index;
}

function readHeadingSection(body, start, heading) {
  const contentStart = start + heading.length;
  const nextHeading = body.slice(contentStart).search(/^### /mu);
  return body.slice(start, nextHeading === -1 ? undefined : contentStart + nextHeading);
}

function readVisibleField(section, label) {
  if (typeof section !== 'string') {
    return undefined;
  }
  const matches = [...section.matchAll(new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+)$`, 'gmu'))];
  return matches.length === 1 ? matches[0][1] : undefined;
}

function validateExactSha(value, label, errors) {
  if (!isExactSha(value)) {
    errors.push(`${label} must be exact`);
  }
}

function validateDigest(value, label, errors) {
  if (typeof value !== 'string' || !exactDigest.test(value)) {
    errors.push(`${label} must be a SHA-256 digest`);
  }
}

function validateTextArray(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  for (const [index, item] of value.entries()) {
    validateText(item, `${label}[${index}]`, errors);
  }
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

function ownerEntryKey(entry) {
  return `${entry?.owner ?? ''}\u0000${entry?.entry ?? ''}`;
}

function sameOwnerEntries(left, right) {
  const leftKeys = Array.isArray(left) ? left.map(ownerEntryKey).sort() : [];
  const rightKeys = Array.isArray(right) ? right.map(ownerEntryKey).sort() : [];
  return sameTextArray(leftKeys, rightKeys);
}

function sameTextArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalize(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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
