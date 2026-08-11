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
    return { contracts: [], entries: [], errors: [`registry is missing: ${registryPath}`] };
  }
  const matches = [
    ...source.matchAll(/```test-structure-coupling-registry-v1\s*\n([\s\S]*?)\n```/gu),
  ];
  if (matches.length !== 1) {
    return {
      contracts: [],
      entries: [],
      errors: ['registry must contain exactly one v1 metadata fence'],
    };
  }
  try {
    const parsed = JSON.parse(matches[0][1]);
    return isPlainObject(parsed) &&
      parsed.version === 1 &&
      Array.isArray(parsed.contracts) &&
      Array.isArray(parsed.entries)
      ? { contracts: parsed.contracts, entries: parsed.entries, errors: [] }
      : {
          contracts: [],
          entries: [],
          errors: ['registry metadata must be { version: 1, contracts: [], entries: [] }'],
        };
  } catch {
    return { contracts: [], entries: [], errors: ['registry metadata must contain valid JSON'] };
  }
}

export function validateRegistry(registry, candidates) {
  const errors = [...registry.errors];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const contracts = validateContracts(errors, registry.contracts);
  const linkedContracts = new Set();
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
    if (!hasMeaningfulText(entry.contract) || !contracts.has(entry.contract)) {
      errors.push(`registry entry ${entry.id} links unknown contract: ${entry.contract ?? ''}`);
    } else {
      linkedContracts.add(entry.contract);
      if (entry.semanticCoverage !== contracts.get(entry.contract).semanticCoverage) {
        errors.push(`registry entry ${entry.id} semanticCoverage does not match linked contract`);
      }
    }
    validateDisposition(errors, entry);
  }
  for (const contractId of contracts.keys()) {
    if (!linkedContracts.has(contractId)) {
      errors.push(`contract is not linked by a current candidate: ${contractId}`);
    }
  }
  return errors.toSorted();
}

function validateContracts(errors, contractValues) {
  const contracts = new Map();
  const contractsByCoverage = new Map();
  for (const contract of contractValues) {
    if (!isPlainObject(contract) || !hasMeaningfulText(contract.id)) {
      errors.push('contract requires id');
      continue;
    }
    if (contracts.has(contract.id)) {
      errors.push(`contract has duplicate id: ${contract.id}`);
    }
    contracts.set(contract.id, contract);
    if (!hasConcreteText(contract.domain) || !hasConcreteText(contract.summary)) {
      errors.push(`contract requires a concrete domain and summary: ${contract.id}`);
    }
    if (!hasMeaningfulText(contract.owner)) {
      errors.push(`contract requires owner: ${contract.id}`);
    }
    if (!hasSpecificSemanticCoverage(contract.semanticCoverage)) {
      errors.push(`contract requires specific semanticCoverage: ${contract.id}`);
    }
    if (!hasConcreteText(contract.coverageRelation)) {
      errors.push(`contract requires a concrete coverageRelation: ${contract.id}`);
    }
    const sharedContracts = contractsByCoverage.get(contract.semanticCoverage) ?? [];
    sharedContracts.push(contract);
    contractsByCoverage.set(contract.semanticCoverage, sharedContracts);
  }
  for (const sharedContracts of contractsByCoverage.values()) {
    if (sharedContracts.length < 2) {
      continue;
    }
    const sharedCoverageGroups = new Set(
      sharedContracts.map((contract) => contract.sharedCoverageGroup).filter(hasConcreteText),
    );
    if (
      sharedCoverageGroups.size !== 1 ||
      sharedContracts.some((contract) => !hasConcreteText(contract.sharedCoverageGroup))
    ) {
      errors.push(
        'semanticCoverage is reused by multiple contracts without an explicit shared coverage group',
      );
    }
  }
  return contracts;
}

function validateDisposition(errors, entry) {
  if (!hasConcreteText(entry.rationale) || !hasSpecificSemanticCoverage(entry.semanticCoverage)) {
    errors.push(`registry entry ${entry.id} requires concrete rationale and semanticCoverage`);
  }
  if (!hasMeaningfulText(entry.owner)) {
    const kind =
      entry.disposition === 'durable-boundary' ? 'durable boundary' : 'temporary ratchet';
    errors.push(`${kind} entry requires owner: ${entry.id}`);
  }
  if (usesGeneratedRationaleFormula(entry.rationale)) {
    errors.push(`registry entry ${entry.id} uses a generated rationale formula`);
  }
  if (entry.disposition === 'durable-boundary') {
    if (!['public', 'security', 'compatibility'].includes(entry.boundary)) {
      errors.push(
        `durable boundary entry requires public, security, or compatibility boundary: ${entry.id}`,
      );
    }
  } else if (entry.disposition === 'temporary-ratchet') {
    if (!hasConcreteText(entry.removalCondition)) {
      errors.push(`temporary ratchet entry requires a concrete removalCondition: ${entry.id}`);
    }
  } else {
    errors.push(`registry entry has unsupported disposition: ${entry.id}`);
  }
}

function usesGeneratedRationaleFormula(value) {
  return (
    typeof value === 'string' &&
    (/^(?:Contract input read|Required boundary assertion|Compatibility-path assertion|Published inventory assertion|Repository-interface analysis):/u.test(
      value.trim(),
    ) ||
      value.includes('Its only durable purpose is the linked') ||
      /^In [“"](.+?)[”"], this [a-z-]+ occurrence /u.test(value.trim()))
  );
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
    const currentCandidateCount = reportCandidates.filter(
      (candidate) => candidate.change !== 'deleted',
    ).length;
    console.log(
      [
        `PASS: all ${currentCandidateCount} current structure-coupling candidates`,
        'are individually classified',
      ].join(' '),
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

function hasConcreteText(value) {
  if (!hasMeaningfulText(value)) {
    return false;
  }
  const text = value.trim();
  const visibleWords = text
    .replace(/\\(?:[nrtbfv0]|u\{?[0-9a-f]{1,6}\}?)/giu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{P}\p{S}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (visibleWords.join('').length < 12) {
    return false;
  }
  const vagueEvidence =
    /^(?:semantic coverage|runtime behavior|same file|supporting contract|source check)$/iu;
  return !vagueEvidence.test(visibleWords.join(' '));
}

function hasSpecificSemanticCoverage(value) {
  return (
    hasConcreteText(value) &&
    /^[^#\r\n]+\.(?:test|spec)\.[^#\r\n]+#[^#\r\n]{12,}$/u.test(value.trim())
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
