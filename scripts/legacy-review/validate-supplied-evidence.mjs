import { readFileSync } from 'node:fs';

import { readRegistrySection } from '../pr-human-review/trusted-retained-legacy.mjs';
import { validateLegacyItemShape } from '../pr-human-review/validate-legacy-item.mjs';

export function validateSuppliedEvidence(input, candidates) {
  if (!input.reviewRecord) {
    return [];
  }
  let record;
  try {
    record = readReviewRecord(readFileSync(input.reviewRecord, 'utf8'));
  } catch {
    return ['review record must be readable JSON'];
  }
  if (record?.scope === 'exempt') {
    return [];
  }
  const stage = input.stage ?? 'final';
  const reviews = reviewsForStage(record, stage);
  if (reviews.length === 0) {
    return stage === 'milestone' ? [] : [`${stage} review legacy ledger is required`];
  }
  const errors = [];
  for (const [index, review] of reviews.entries()) {
    validateLedger({
      legacy: review?.legacy,
      candidates,
      errors,
      label: stage === 'milestone' ? `milestone review ${index + 1}` : `${stage} review`,
      registryPath: input.registry,
      retainedLegacy: record.retainedLegacy,
      requireRetainedApproval: stage === 'final',
    });
  }
  return errors;
}

function reviewsForStage(record, stage) {
  if (stage === 'initial') {
    return [record?.initialReview];
  }
  if (stage === 'milestone') {
    return record?.milestoneReview?.classification === 'reviewed'
      ? (record.milestoneReview.entries ?? [])
      : [];
  }
  return [record?.finalReview];
}

function validateLedger({
  legacy,
  candidates,
  errors,
  label,
  registryPath,
  retainedLegacy,
  requireRetainedApproval,
}) {
  if (!legacy || !Array.isArray(legacy.items) || !Number.isInteger(legacy.candidateCount)) {
    errors.push(`${label} legacy ledger is required and must include candidateCount and items`);
    return;
  }
  if (legacy.candidateCount !== legacy.items.length) {
    errors.push(`${label} ledger candidate count must equal items`);
  }
  if (legacy.items.length !== candidates.length) {
    errors.push(`${label} ledger candidate count must equal report count (${candidates.length})`);
  }
  const itemsById = collectLedgerItems({
    items: legacy.items,
    errors,
    label,
    retainedLegacy,
    requireRetainedApproval,
  });
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    validateCandidateDisposition({ candidate, itemsById, errors, label });
  }
  for (const identifier of itemsById.keys()) {
    if (!candidateIds.has(identifier)) {
      errors.push(`${label} ledger contains an unreported candidate ID: ${identifier}`);
    }
  }
  if (requireRetainedApproval) {
    validateRetainedRegistry(registryPath, itemsById, errors);
  }
}

export function readReviewRecord(source) {
  try {
    const parsed = JSON.parse(source);
    return typeof parsed?.pull_request?.body === 'string'
      ? readReviewRecord(parsed.pull_request.body)
      : parsed;
  } catch {
    const match = source.match(/```pr-human-review-record-v1\s*\n([\s\S]*?)\n```/u);
    if (!match) {
      throw new Error('review record is not JSON or a PR Human Review Record v1 fence');
    }
    return JSON.parse(match[1]);
  }
}

function collectLedgerItems({ items, errors, label, retainedLegacy, requireRetainedApproval }) {
  const itemsById = new Map();
  const approvalById = new Map(
    (Array.isArray(retainedLegacy) ? retainedLegacy : []).map((approval) => [
      approval?.id,
      approval,
    ]),
  );
  for (const item of items) {
    if (!item || typeof item.id !== 'string') {
      errors.push(`${label} ledger contains a malformed item`);
      continue;
    }
    validateLegacyItemShape({
      item,
      label,
      retainedApproval: approvalById.get(item.id),
      requireRetainedApproval,
      errors,
    });
    if (itemsById.has(item.id)) {
      errors.push(`final review ledger has a duplicate candidate ID: ${item.id}`);
    }
    itemsById.set(item.id, item);
  }
  return itemsById;
}

function validateCandidateDisposition({ candidate, itemsById, errors, label }) {
  const item = itemsById.get(candidate.id);
  if (!item) {
    errors.push(`${label} ledger is missing disposition: ${candidate.id}`);
    return;
  }
  if (item.path !== candidate.path || item.symbol !== candidate.symbol) {
    errors.push(`${label} ledger candidate location does not match report: ${candidate.id}`);
  }
}

function validateRetainedRegistry(registryPath, itemsById, errors) {
  const retained = [...itemsById.values()].filter(
    (item) =>
      item.classification !== 'not-legacy' &&
      item.disposition === 'retained-pending-human-approval',
  );
  if (retained.length === 0) {
    return;
  }
  if (!registryPath) {
    errors.push('retained legacy requires a durable registry supplied with --registry');
    return;
  }
  let registry;
  try {
    registry = readFileSync(registryPath, 'utf8');
  } catch {
    errors.push('production legacy registry must be readable');
    return;
  }
  for (const item of retained) {
    validateRegistryEntry(registry, item.id, errors);
  }
}

function validateRegistryEntry(registry, id, errors) {
  const section = readRegistrySection(registry, id);
  if (!section) {
    errors.push(`retained legacy candidate is absent from registry: ${id}`);
    return;
  }
  for (const field of requiredRegistryFields) {
    if (!new RegExp(`^- ${escapeRegExp(field)}:\\s*\\S`, 'mu').test(section)) {
      errors.push(`retained legacy registry entry is missing ${field}: ${id}`);
    }
  }
}

const requiredRegistryFields = [
  'Repository-relative path and symbol',
  'Purpose',
  'Canonical implementation owner',
  'Consumer or operational dependency',
  'Why removal is unsafe now',
  'Minimization already performed',
  'Approval date and human reviewer',
  'Approved production candidate SHA',
  'Compatibility tests',
  'Named owner',
  'Review or removal condition',
  'GitHub PR review ID',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
