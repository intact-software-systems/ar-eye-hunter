import type { RallarOntologyVersionIri } from './rallar-ontology-contracts.ts';
import type { RallarOntologyIssue } from './rallar-ontology-registry-contracts.ts';

const ONTOLOGY_BASE = 'https://github.com/intact-software-systems/ar-eye-hunter/ontology/';
const canonicalVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const identitySegmentPattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const ontologySeriesPattern = /^(?:domain|realtime|code-standards)$/u;
const repositoryTargetRoots = new Set(
  (
    '.agents .codex-plugin .github .run .superpowers .vscode apps docs examples packages plans ' +
    'playground projects scripts tests .gitignore AGENTS.md ' +
    'README.md deno.json deno.lock docker-compose.yml dprint.json no-js-files-outside-dist.sh ' +
    'package-lock.json package.json tsconfig.json vitest.config.ts'
  ).split(' '),
);
const skosRelationIds = new Set([
  'http://www.w3.org/2004/02/skos/core#broader',
  'http://www.w3.org/2004/02/skos/core#narrower',
  'http://www.w3.org/2004/02/skos/core#related',
]);

export function compareRallarOntologyText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortRallarOntologyIssues(
  issues: readonly RallarOntologyIssue[],
): readonly RallarOntologyIssue[] {
  return [...issues].sort(
    (left, right) =>
      compareRallarOntologyText(left.path, right.path) ||
      compareRallarOntologyText(left.code, right.code) ||
      compareRallarOntologyText(left.message, right.message),
  );
}

export function createRallarOntologyIssue(
  code: RallarOntologyIssue['code'],
  path: string,
  message: string,
): RallarOntologyIssue {
  return { code, path, message };
}

export function isCanonicalRallarOntologyVersion(value: string): boolean {
  return canonicalVersionPattern.test(value);
}

export function isValidRallarOntologyId(value: string): boolean {
  if (!value.startsWith(ONTOLOGY_BASE)) {
    return false;
  }
  const suffix = value.slice(ONTOLOGY_BASE.length);
  if (ontologySeriesPattern.test(suffix)) {
    return true;
  }
  const segments = suffix.split('/');
  return (
    segments.length === 3 &&
    segments[0] === 'extension' &&
    isIdentitySegment(segments[1]) &&
    isIdentitySegment(segments[2])
  );
}

export function isValidRallarOntologyOwnerId(value: string): boolean {
  return isValidGovernedIdentity(value, 'owner');
}

export function isValidRallarOntologyTermId(value: string): boolean {
  return isValidGovernedIdentity(value, 'term');
}

export function isValidRallarOntologyBindingSetId(value: string): boolean {
  return isValidGovernedIdentity(value, 'binding-set');
}

export function isValidRallarOntologyBindingId(value: string): boolean {
  return isValidGovernedIdentity(value, 'binding');
}

export function isValidRallarOntologyBindingProfileId(value: string): boolean {
  return isValidGovernedIdentity(value, 'binding-profile');
}

export function isValidRallarOntologyRelationId(value: string): boolean {
  return isValidGovernedIdentity(value, 'relation') || skosRelationIds.has(value);
}

export function isVersionIriForSeries(value: string, seriesId: string): boolean {
  const prefix = `${seriesId}/version/`;
  return value.startsWith(prefix) && isCanonicalRallarOntologyVersion(value.slice(prefix.length));
}

export function validateCompatibleVersionIris(input: {
  readonly seriesId: string;
  readonly version: string;
  readonly values: readonly RallarOntologyVersionIri[];
  readonly path: string;
}): readonly RallarOntologyIssue[] {
  const issues: RallarOntologyIssue[] = [];
  const seen = new Set<string>();
  input.values.forEach((value, index) => {
    const valid =
      isVersionIriForSeries(value, input.seriesId) &&
      compareVersions(versionFromIri(value), input.version) < 0 &&
      !seen.has(value);
    if (!valid) {
      issues.push(
        createRallarOntologyIssue(
          'invalid-compatible-version-iri',
          `${input.path}[${index}]`,
          `Compatibility IRI must be a unique prior canonical version of ${input.seriesId}.`,
        ),
      );
    }
    seen.add(value);
  });
  return issues;
}

export function isRepositoryRelativeOntologyTarget(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('@')) {
    return false;
  }
  if (value.includes('\\') || value.includes('://') || value.includes('%')) {
    return false;
  }
  const segments = value.split('/');
  return (
    repositoryTargetRoots.has(segments[0]) &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        segment !== '__proto__' &&
        segment !== 'prototype' &&
        segment !== 'constructor' &&
        /^[A-Za-z0-9._-]+$/u.test(segment),
    )
  );
}

export function isSafeOntologyPropertySegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '__proto__' &&
    value !== 'prototype' &&
    value !== 'constructor' &&
    /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)
  );
}

function isValidGovernedIdentity(value: string, family: string): boolean {
  const prefix = `${ONTOLOGY_BASE}${family}/`;
  if (!value.startsWith(prefix)) {
    return false;
  }
  const suffix = value.slice(prefix.length);
  return !suffix.includes('/') && isIdentitySegment(suffix);
}

function isIdentitySegment(value: string | undefined): boolean {
  return value !== undefined && identitySegmentPattern.test(value) && !value.includes('..');
}

function versionFromIri(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function compareVersions(left: string, right: string): number {
  if (!isCanonicalRallarOntologyVersion(left) || !isCanonicalRallarOntologyVersion(right)) {
    return 0;
  }
  const leftParts = left.split('.').map(BigInt);
  const rightParts = right.split('.').map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}
