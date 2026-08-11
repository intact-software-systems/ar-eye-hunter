import { retainedLedgerProjection } from './trusted-retained-legacy.mjs';

const exactSha = /^[0-9a-f]{40}$/u;
const validDispositions = new Set([
  'removed',
  'minimized-boundary',
  'resolved',
  'retained-pending-human-approval',
]);

export function validateReviewEvidence({ review, stage, section, retainedLegacy, errors }) {
  if (!isPlainRecord(review)) {
    errors.push(`${stage} review metadata is required`);
    return undefined;
  }
  if (stage === 'initial' && review.status !== 'complete') {
    errors.push('initial review status must be complete');
  }
  validateText(review.reviewer, `${stage} reviewer`, errors);
  if (review.independence !== 'separate-agent-or-human') {
    errors.push(`${stage} review must identify a separate agent or human`);
  }
  if (!isExactSha(review.mergeBaseSha)) {
    errors.push(`${stage} review merge base SHA must be exact`);
  }
  if (!isExactSha(review.headSha)) {
    errors.push(`${stage} review head SHA must be exact`);
  }
  if (!['pass', 'changes-requested'].includes(review.verdict)) {
    errors.push(`${stage} review verdict must be pass or changes-requested`);
  }
  validateFindings(review.unresolvedFindings, stage, errors);
  validateVisibleReview({ review, stage, section, retainedLegacy, errors });
  validateLegacyLedger({ legacy: review.legacy, stage, retainedLegacy, errors });
  return review;
}

export function validateFreshReview({ review, stage, input, errors }) {
  if (!review) {
    return;
  }
  if (review.mergeBaseSha !== input.mergeBaseSha) {
    errors.push(`${stage} review merge base SHA must match the computed merge base`);
  }
  if (review.headSha !== input.headSha) {
    errors.push(`${stage} review head SHA must match current head`);
  }
}

export function readVisibleReviewSections(body, errors) {
  const headings = [
    '### Initial independent review',
    '### Milestone review',
    '### Complete code and legacy review',
  ];
  const positions = headings.map((heading) => {
    const matches = [...body.matchAll(new RegExp(`^${escapeRegExp(heading)}$`, 'gmu'))];
    if (matches.length !== 1 || matches[0].index === undefined) {
      errors.push(`visible PR record must contain exactly one ${heading} section`);
      return undefined;
    }
    return matches[0].index;
  });
  if (positions.some((position) => position === undefined)) {
    return {};
  }
  if (!(positions[0] < positions[1] && positions[1] < positions[2])) {
    errors.push('visible PR review sections must be ordered initial, milestone, final');
    return {};
  }
  return {
    initial: body.slice(positions[0], positions[1]),
    milestone: body.slice(positions[1], positions[2]),
    final: readHeadingSection(body, positions[2], headings[2]),
  };
}

export function validateMilestoneReview(milestone, section, errors) {
  if (!isPlainRecord(milestone) || !['none', 'reviewed'].includes(milestone.classification)) {
    errors.push('milestone metadata classification must be none or reviewed');
    return;
  }
  const visible = readVisibleField(section, 'Milestone classification');
  if (normalize(visible) !== milestone.classification) {
    errors.push('visible milestone classification contradicts metadata');
  }
  const entries = Array.isArray(milestone.entries) ? milestone.entries : [];
  const entrySections = readMilestoneEntrySections(section);
  if (milestone.classification === 'none') {
    if (entries.length > 0) {
      errors.push('none milestone metadata must not contain reviewed entries');
    }
    if (entrySections.length > 0) {
      errors.push('none milestone visible record must not contain reviewed entries');
    }
    return;
  }
  if (entries.length === 0) {
    errors.push('reviewed milestone metadata requires at least one entry');
  }
  if (entrySections.length !== entries.length) {
    errors.push('reviewed milestone visible entry count must match metadata');
  }
  for (const [index, entry] of entries.entries()) {
    const entrySection = entrySections[index];
    validateReviewEvidence({
      review: entry,
      stage: 'milestone',
      section: entrySection,
      errors,
    });
    validateText(entry?.newFamily, 'milestone review newFamily', errors);
    const visibleFamily = readVisibleField(
      entrySection,
      'New ownership, control-flow, or legacy family',
    );
    validateText(visibleFamily, 'milestone visible review newFamily', errors);
    if (normalize(visibleFamily) !== normalize(entry?.newFamily)) {
      errors.push('milestone visible review newFamily contradicts metadata');
    }
  }
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

function validateFindings(findings, stage, errors) {
  if (!isPlainRecord(findings)) {
    errors.push(`${stage} review unresolved findings are required`);
    return;
  }
  for (const severity of ['critical', 'important']) {
    if (!Number.isInteger(findings[severity]) || findings[severity] < 0) {
      errors.push(`${stage} review ${severity} finding count must be a non-negative integer`);
    }
  }
}

function readHeadingSection(body, start, heading) {
  const contentStart = start + heading.length;
  const nextHeading = body.slice(contentStart).search(/^### /mu);
  return body.slice(start, nextHeading === -1 ? undefined : contentStart + nextHeading);
}

function readMilestoneEntrySections(section) {
  if (typeof section !== 'string') {
    return [];
  }
  const heading = '#### Milestone review entry';
  const matches = [...section.matchAll(new RegExp(`^${escapeRegExp(heading)}$`, 'gmu'))];
  return matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index;
    return section.slice(start, end);
  });
}

function validateVisibleReview({ review, stage, section, retainedLegacy, errors }) {
  if (!isPlainRecord(review.narrative)) {
    errors.push(`${stage} review narrative evidence is required`);
    return;
  }
  for (const [label, expected, name] of visibleFields(review, stage, retainedLegacy)) {
    validateText(expected, `${stage} review ${name}`, errors);
    const visible = readVisibleField(section, label);
    validateText(visible, `${stage} visible review ${name}`, errors);
    if (normalize(visible) !== normalize(String(expected))) {
      errors.push(`${stage} visible review contradicts metadata: ${name}`);
    }
  }
}

function visibleFields(review, stage, retainedLegacy) {
  const labels = visibleReviewLabels(stage);
  return [
    ...(stage === 'initial' ? [['Record status', review.status, 'recordStatus']] : []),
    [
      'Reviewer and independence (separate agent or human)',
      `${review.reviewer} — ${review.independence}`,
      'reviewer',
    ],
    ['Exact merge base SHA', review.mergeBaseSha, 'mergeBaseSha'],
    ['Exact candidate head SHA', review.headSha, 'headSha'],
    [
      labels.ownerTrace,
      review.narrative.productionOwnerToResultTrace,
      'productionOwnerToResultTrace',
    ],
    [
      labels.cognitive,
      review.narrative.cognitiveIndirectionFindings,
      'cognitiveIndirectionFindings',
    ],
    [
      'Complete review findings and resolution/status ' +
        '(correctness, safety, contracts, and other human-review findings)',
      review.narrative.completeFindings,
      'completeFindings',
    ],
    [labels.tests, review.narrative.testsRewrittenOrRemoved, 'testsRewrittenOrRemoved'],
    [
      'Production was not compromised for tests',
      review.narrative.productionNotCompromisedForTests,
      'productionNotCompromisedForTests',
    ],
    [
      'Behavior and judgment not proven by automation',
      review.narrative.automationGaps,
      'automationGaps',
    ],
    ['Legacy candidate count', String(review.legacy?.candidateCount), 'legacyCandidateCount'],
    [
      'Legacy ledger and dispositions',
      JSON.stringify(visibleLegacyLedger(review.legacy.items, stage, retainedLegacy)),
      'legacyLedger',
    ],
    ...(stage === 'final'
      ? [
          [
            'Legacy candidates inspected (baseline, automated report, changed files, ' +
              'and production call paths)',
            review.legacy.candidatesInspected,
            'candidatesInspected',
          ],
        ]
      : []),
    [
      'Critical findings unresolved',
      String(review.unresolvedFindings?.critical),
      'criticalFindings',
    ],
    [
      'Important findings unresolved',
      String(review.unresolvedFindings?.important),
      'importantFindings',
    ],
    ['Verdict', review.verdict, 'verdict'],
  ];
}

function visibleReviewLabels(stage) {
  if (stage !== 'final') {
    return {
      ownerTrace: 'Production owner-to-result trace',
      cognitive: 'Cognitive-indirection findings',
      tests: 'Tests rewritten or removed',
    };
  }
  return {
    ownerTrace:
      'Changed production owner-to-result trace, including decisions, effects, failures, ' +
      'callbacks, compatibility branches, and tests',
    cognitive: 'Cognitive-indirection findings and resolution',
    tests: 'Tests rewritten or removed, with independent behavior retained',
  };
}

function visibleLegacyLedger(items, stage, retainedLegacy) {
  if (stage !== 'final') {
    return [...items].sort((left, right) => left.id.localeCompare(right.id));
  }
  const approvals = Array.isArray(retainedLegacy) ? retainedLegacy : [];
  return retainedLedgerProjection({
    items,
    approvalById: new Map(approvals.map((approval) => [approval?.id, approval])),
  });
}

function readVisibleField(section, label) {
  if (typeof section !== 'string') {
    return undefined;
  }
  const matches = [...section.matchAll(new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+)$`, 'gmu'))];
  return matches.length === 1 ? matches[0][1] : undefined;
}

function validateLegacyLedger({ legacy, stage, retainedLegacy, errors }) {
  if (!isPlainRecord(legacy) || !Array.isArray(legacy.items)) {
    errors.push(`${stage} review legacy ledger is required`);
    return;
  }
  if (!Number.isInteger(legacy.candidateCount) || legacy.candidateCount !== legacy.items.length) {
    errors.push(`${stage} review legacy candidate count must equal ledger items`);
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
    if (item.classification === 'not-legacy') {
      validateText(item.rationale, `${stage} review not-legacy rationale`, errors);
      if (
        item.disposition !== undefined ||
        retainedLegacy?.some((approval) => approval?.id === item.id)
      ) {
        errors.push(
          `${stage} review not-legacy item must not contain legacy disposition or approval`,
        );
      }
    } else if (item.classification === 'legacy' || item.classification === undefined) {
      if (!validDispositions.has(item.disposition)) {
        errors.push(`${stage} review legacy disposition is invalid: ${String(item.disposition)}`);
      }
    } else {
      errors.push(
        `${stage} review legacy classification is invalid: ${String(item.classification)}`,
      );
    }
    if (identifiers.has(item.id)) {
      errors.push(`${stage} review legacy ledger has a duplicate item ID: ${item.id}`);
    }
    identifiers.add(item.id);
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
