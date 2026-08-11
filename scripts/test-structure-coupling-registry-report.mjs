import { existsSync, readFileSync } from 'node:fs';

import { readRevisionFile } from './test-structure-coupling-range-evidence.mjs';

const registryPath = 'docs/test-structure-coupling-exceptions.md';

export function readRegistry(reviewInput) {
  const source =
    reviewInput.mode === 'changed-range'
      ? readRevisionFile(reviewInput.head, registryPath)
      : existsSync(registryPath)
        ? readFileSync(registryPath, 'utf8')
        : undefined;
  if (!source) {
    return { entries: [], errors: [`registry is missing: ${registryPath}`] };
  }
  const matches = [
    ...source.matchAll(/```test-structure-coupling-registry-v1\s*\n([\s\S]*?)\n```/gu),
  ];
  if (matches.length !== 1) {
    return { entries: [], errors: ['registry must contain exactly one v1 metadata fence'] };
  }
  try {
    const parsed = JSON.parse(matches[0][1]);
    return isPlainObject(parsed) && parsed.version === 1 && Array.isArray(parsed.entries)
      ? { entries: parsed.entries, errors: [] }
      : { entries: [], errors: ['registry metadata must be { version: 1, entries: [] }'] };
  } catch {
    return { entries: [], errors: ['registry metadata must contain valid JSON'] };
  }
}

export function validateRegistry(registry, candidates) {
  const errors = [...registry.errors];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set();
  for (const entry of registry.entries) {
    if (!isPlainObject(entry)) {
      errors.push('registry entry must be an object');
      continue;
    }
    if (!hasMeaningfulText(entry.id)) {
      errors.push('registry entry requires id');
      continue;
    }
    if (seen.has(entry.id)) {
      errors.push(`registry entry has duplicate id: ${entry.id}`);
    }
    seen.add(entry.id);
    const candidate = byId.get(entry.id);
    if (!candidate) {
      errors.push(`registry entry is stale: ${entry.id}`);
      continue;
    }
    for (const field of ['path', 'line', 'column', 'kind']) {
      if (entry[field] !== candidate[field]) {
        errors.push(`registry entry ${entry.id} has stale ${field}`);
      }
    }
    validateDisposition(errors, entry);
  }
  return errors.toSorted();
}

function validateDisposition(errors, entry) {
  if (!hasMeaningfulText(entry.rationale) || !hasMeaningfulText(entry.semanticCoverage)) {
    errors.push(
      `registry entry ${entry.id} requires non-placeholder rationale and semanticCoverage`,
    );
  }
  if (!hasMeaningfulText(entry.owner)) {
    const kind =
      entry.disposition === 'durable-boundary' ? 'durable boundary' : 'temporary ratchet';
    errors.push(`${kind} entry requires owner: ${entry.id}`);
  }
  if (entry.disposition === 'durable-boundary') {
    if (!['public', 'security', 'compatibility'].includes(entry.boundary)) {
      errors.push(
        `durable boundary entry requires public, security, or compatibility boundary: ${entry.id}`,
      );
    }
  } else if (entry.disposition === 'temporary-ratchet') {
    if (!hasMeaningfulText(entry.removalCondition)) {
      errors.push(`temporary ratchet entry requires removalCondition: ${entry.id}`);
    }
  } else {
    errors.push(`registry entry has unsupported disposition: ${entry.id}`);
  }
}

export function printReport({
  reviewInput,
  reportCandidates,
  reviewedPaths,
  registry,
  hasFailures,
}) {
  console.log(
    [
      'WARN: test structure-coupling review is advisory;',
      'it identifies review evidence, not failures.',
    ].join(' '),
  );
  console.log(`mode=${reviewInput.mode}`);
  if (reviewInput.mode === 'changed-range') {
    console.log(`base=${reviewInput.base}`);
    console.log(`head=${reviewInput.head}`);
  }
  const entries = new Map(registry.entries.filter(isPlainObject).map((entry) => [entry.id, entry]));
  if (reviewInput.mode === 'changed-files') {
    printSelectedPathEvidence(reviewedPaths, reportCandidates);
  }
  for (const candidate of reportCandidates) {
    console.log(toCandidateReport(candidate, entries.get(candidate.id)));
  }
  const unclassified = reportCandidates.filter(
    (candidate) => candidate.change !== 'deleted' && !entries.has(candidate.id),
  );
  if (reportCandidates.length === 0 && !hasFailures) {
    console.log('PASS: no current structure-coupled test candidates');
  } else if (reportCandidates.length === 0) {
    console.log('WARN: no candidates reported because validation did not complete successfully.');
  } else if (unclassified.length === 0) {
    console.log(
      `PASS: all ${reportCandidates.length} current structure-coupling candidates are individually classified`,
    );
  } else {
    console.log(
      [
        `WARN: ${unclassified.length} reported candidates await individual human classification;`,
        'this command does not create a baseline or grandfather findings.',
      ].join(' '),
    );
  }
  if (reviewInput.mode === 'changed-range') {
    console.log(
      unclassified.length === 0
        ? 'PASS: changed-range structure-coupling review has complete individual classifications'
        : 'WARN: changed-range structure-coupling review blocks unclassified current evidence.',
    );
  }
}

function printSelectedPathEvidence(reviewedPaths, candidates) {
  const countByPath = new Map();
  for (const candidate of candidates) {
    countByPath.set(candidate.path, (countByPath.get(candidate.path) ?? 0) + 1);
  }
  for (const path of reviewedPaths) {
    console.log(`REVIEWED ${path} | candidates=${countByPath.get(path) ?? 0}`);
  }
}

function toCandidateReport(candidate, registryEntry) {
  const fields = [
    `CANDIDATE ${candidate.id}`,
    `${candidate.path}:${candidate.line}:${candidate.column}`,
    candidate.kind,
    candidate.reason,
    `change=${candidate.change ?? 'current'}`,
  ];
  if (candidate.origin) {
    fields.push(`origin=${candidate.origin}`);
  }
  fields.push(`evidence=${evidenceStatus(registryEntry)}`);
  return fields.join(' | ');
}

function evidenceStatus(entry) {
  if (!isPlainObject(entry)) {
    return 'unreviewed';
  }
  if (entry.disposition === 'durable-boundary') {
    return `durable-${entry.boundary}-boundary`;
  }
  if (entry.disposition === 'temporary-ratchet') {
    return 'temporary-ratchet';
  }
  return 'invalid-registration';
}

function hasMeaningfulText(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const text = value.trim();
  return (
    text.length > 0 && !/^(?:tbd|todo|none|later|\.\.\.|-)|^\[[^\]]*\]$|^<[^>]*>$/iu.test(text)
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
