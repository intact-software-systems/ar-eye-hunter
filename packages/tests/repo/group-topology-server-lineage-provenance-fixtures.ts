import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';

import {
  type LineageBoundaryRow,
  validateLineageBoundaryBijection,
} from './group-topology-server-lineage-boundary-bijection.ts';

const repoRoot = process.cwd();
export const base = '108933a97c7a40ee0831ecd185725aea243122bd';
const manifestPath = 'plans/repo-style-lineages/rallar-group-topology-server-pr-a.json';
const evidencePath = 'plans/repo-style-lineages/rallar-group-topology-server-pr-a-provenance.jsonc';
export const expectedEvidenceHash =
  '111d222cc2e83d39050070bebce2ff7a0ebc8a0fa2b3e66e959eb56073986994';
export const mutationSource =
  'packages/shared-server/rallar-system/services/group-topology-config-mutations.ts';
export const mutationBoundaryOwner =
  'packages/shared-server/rallar-system/topology/config/mutation/topology-config-mutation-boundary.ts';
export const mutationValidationValueOwner =
  'packages/shared-server/rallar-system/topology/config/mutation/topology-config-mutation-validation-values.ts';
export const mutationRecordValidator =
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-records.ts';
export const mutationReceiptValidator =
  'packages/shared-server/rallar-system/topology/config/mutation/validate-topology-config-receipt.ts';
type Span = Readonly<{ startLine: number; endLine: number }>;
type Region = Span & Readonly<{ symbol: string; sha256: string }>;
type Location = Readonly<{
  path: string;
  blob: string;
  regions: readonly Region[];
}>;
type ProvenanceRow = Readonly<{
  id: string;
  mergeBase: string;
  source: Location;
  targets: readonly Location[];
  magnitude: Readonly<Record<string, number | string>>;
  derivation: Readonly<Record<string, boolean | string>>;
}>;
export type ProvenanceEvidence = Readonly<{ version: number; rows: readonly ProvenanceRow[] }>;

export const manifest = JSON.parse(read(manifestPath)) as {
  version: number;
  lineages: Array<{
    mergeBase: string;
    source: { path: string; blob: string };
    targets: string[];
  }>;
};
export const evidenceSource = read(evidencePath);
export const evidence = parsePinnedJsonc(evidenceSource) as ProvenanceEvidence;
export const evidenceLeafPaths = leafPaths(evidence);

export function validateBoundaryBijection(candidate: ProvenanceEvidence): void {
  const targetPaths = candidate.rows.flatMap(({ targets }) => targets.map(({ path }) => path));
  const sourcesByPath = Object.fromEntries(
    [...new Set(targetPaths)].map((targetPath) => [targetPath, read(targetPath)]),
  );
  sourcesByPath[mutationSource] = git(['show', `${base}:${mutationSource}`]);
  validateLineageBoundaryBijection({
    rows: candidate.rows as readonly LineageBoundaryRow[],
    sourcePath: mutationSource,
    boundaryOwnerPath: mutationBoundaryOwner,
    validationValueOwnerPath: mutationValidationValueOwner,
    sourcesByPath,
  });
}

function parsePinnedJsonc(source: string): unknown {
  return JSON.parse(source.replace(/,\s*([}\]])/gu, '$1'));
}

export function validateEvidence(candidate: ProvenanceEvidence, pinned: ProvenanceEvidence): void {
  const drift = firstLeafDrift(candidate, pinned);
  if (drift) {
    throw new Error(drift);
  }
  for (const [rowIndex, row] of candidate.rows.entries()) {
    const rowPath = `rows.${rowIndex}`;
    if (row.mergeBase !== base) {
      throw new Error(`${rowPath}.mergeBase`);
    }
    validateLocation(row.source, `${rowPath}.source`, `${base}:${row.source.path}`);
    for (const [targetIndex, target] of row.targets.entries()) {
      validateLocation(target, `${rowPath}.targets.${targetIndex}`, target.path);
    }
    if (Object.keys(row.magnitude).length === 0) {
      throw new Error(`${rowPath}.magnitude`);
    }
    if (Object.keys(row.derivation).length === 0) {
      throw new Error(`${rowPath}.derivation`);
    }
    validateMagnitudeAndDerivation(row, rowPath);
  }
  validateBoundaryBijection(candidate);
}

function validateMagnitudeAndDerivation(row: ProvenanceRow, rowPath: string): void {
  const source = git(['show', `${base}:${row.source.path}`]);
  const targets = row.targets.map((target) => read(target.path));
  validateMeasuredMagnitude(
    row.magnitude,
    'sourceUnknownBoundaryLines',
    countLocationUnknownLines(source, row.source),
    rowPath,
  );
  validateMeasuredMagnitude(
    row.magnitude,
    'targetUnknownBoundaryLines',
    row.targets.reduce(
      (total, target, index) => total + countLocationUnknownLines(targets[index], target),
      0,
    ),
    rowPath,
  );
  validateOptionalDeclarationMagnitude(row, source, targets, rowPath);

  if (row.magnitude.rule !== 'boundary.unknown') {
    return;
  }
  if (row.source.path !== mutationSource || row.magnitude.sourceUnknownBoundaryLines !== 1) {
    throw new Error(`${rowPath}.derivation.sourceDerivation`);
  }
  const boundaryTargets = row.targets.filter(({ path }) => path === mutationBoundaryOwner);
  if (row.derivation.capacityEligible === true) {
    if (row.magnitude.targetUnknownBoundaryLines !== 1 || boundaryTargets.length !== 1) {
      throw new Error(`${rowPath}.derivation.capacityEligible`);
    }
  } else if (
    row.derivation.capacityEligible !== false ||
    row.derivation.kind !== 'resolved-to-named-domain-continuation' ||
    row.magnitude.targetUnknownBoundaryLines !== 0 ||
    boundaryTargets.length !== 0
  ) {
    throw new Error(`${rowPath}.derivation.capacityEligible`);
  }
  for (const [targetIndex, target] of row.targets.entries()) {
    if (
      target.path !== mutationBoundaryOwner &&
      countLocationUnknownLines(targets[targetIndex], target)
    ) {
      throw new Error(`${rowPath}.targets.${targetIndex}.derivation`);
    }
  }
}

function validateMeasuredMagnitude(
  magnitude: ProvenanceRow['magnitude'],
  key: string,
  actual: number,
  rowPath: string,
): void {
  if (magnitude[key] !== actual) {
    throw new Error(`${rowPath}.magnitude.${key}`);
  }
}

function validateOptionalDeclarationMagnitude(
  row: ProvenanceRow,
  source: string,
  targets: readonly string[],
  rowPath: string,
): void {
  if (typeof row.magnitude.sourceDeclarations === 'number') {
    validateMeasuredMagnitude(
      row.magnitude,
      'sourceDeclarations',
      countLocationDeclarations(source, row.source),
      rowPath,
    );
  }
  if (typeof row.magnitude.targetDeclarations === 'number') {
    validateMeasuredMagnitude(
      row.magnitude,
      'targetDeclarations',
      row.targets.reduce(
        (total, target, index) => total + countLocationDeclarations(targets[index], target),
        0,
      ),
      rowPath,
    );
  }
}

function countLocationUnknownLines(source: string, location: Location): number {
  return location.regions.reduce(
    (total, region) => total + unknownBoundaryLineCount(regionSource(source, region)),
    0,
  );
}

function countLocationDeclarations(source: string, location: Location): number {
  return topLevelDeclarations(source).filter((declaration) =>
    location.regions.some(
      (region) =>
        declaration.startLine >= region.startLine && declaration.endLine <= region.endLine,
    ),
  ).length;
}

function validateLocation(location: Location, fieldPath: string, revisionPath: string): void {
  if (!existsAtRevision(revisionPath)) {
    throw new Error(`${fieldPath}.path`);
  }
  const actualBlob = revisionPath.includes(':')
    ? git(['rev-parse', revisionPath])
    : git(['hash-object', revisionPath]);
  if (actualBlob !== location.blob) {
    throw new Error(`${fieldPath}.blob`);
  }
  const source = revisionPath.includes(':') ? git(['show', revisionPath]) : read(revisionPath);
  for (const [regionIndex, region] of location.regions.entries()) {
    const regionPath = `${fieldPath}.regions.${regionIndex}`;
    const actualSpan = symbolSpan(source, region.symbol);
    if (actualSpan.startLine !== region.startLine) {
      throw new Error(`${regionPath}.startLine`);
    }
    if (actualSpan.endLine !== region.endLine) {
      throw new Error(`${regionPath}.endLine`);
    }
    if (sha256(regionSource(source, region)) !== region.sha256) {
      throw new Error(`${regionPath}.sha256`);
    }
  }
}

function symbolSpan(source: string, symbol: string): Span {
  const declarations = topLevelDeclarations(source);
  if (symbol === '$moduleDeclarations') {
    return {
      startLine: Math.min(...declarations.map(({ startLine }) => startLine)),
      endLine: Math.max(...declarations.map(({ endLine }) => endLine)),
    };
  }
  const declaration = declarations.find((candidate) => candidate.symbol === symbol);
  if (!declaration) {
    throw new Error(`symbol:${symbol}`);
  }
  return declaration;
}

function topLevelDeclarations(source: string): Array<Span & { symbol: string }> {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const declarations: Array<Span & { symbol: string }> = [];
  for (const statement of ast.program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (!declaration?.loc) {
      continue;
    }
    const symbol = declarationName(declaration);
    if (symbol) {
      declarations.push({
        symbol,
        startLine: declaration.loc.start.line,
        endLine: declaration.loc.end.line,
      });
    }
  }
  return declarations;
}

function declarationName(declaration: { type: string; [key: string]: unknown }): string | null {
  if ('id' in declaration && isNamedIdentifier(declaration.id)) {
    return declaration.id.name;
  }
  if (declaration.type !== 'VariableDeclaration' || !Array.isArray(declaration.declarations)) {
    return null;
  }
  const names = declaration.declarations
    .map((candidate) =>
      isRecord(candidate) && isNamedIdentifier(candidate.id) ? candidate.id.name : null,
    )
    .filter((name): name is string => name !== null);
  return names.length === 1 ? names[0] : null;
}

function regionSource(source: string, span: Span): string {
  return source
    .split('\n')
    .slice(span.startLine - 1, span.endLine)
    .join('\n');
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!isRecord(value) && !Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

function firstLeafDrift(candidate: unknown, pinned: unknown): string | null {
  for (const fieldPath of leafPaths(pinned)) {
    if (
      JSON.stringify(readLeaf(candidate, fieldPath)) !== JSON.stringify(readLeaf(pinned, fieldPath))
    ) {
      return fieldPath;
    }
  }
  return null;
}

function readLeaf(value: unknown, fieldPath: string): unknown {
  return fieldPath.split('.').reduce(readIndexed, value);
}

function readIndexed(value: unknown, key: string): unknown {
  if (!isRecord(value) && !Array.isArray(value)) {
    return undefined;
  }
  return value[key];
}

function existsAtRevision(revisionPath: string): boolean {
  if (revisionPath.includes(':')) {
    return execFileSync('git', ['cat-file', '-e', revisionPath], { encoding: 'utf8' }) === '';
  }
  return existsSync(absolute(revisionPath));
}

function isNamedIdentifier(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function unknownBoundaryLineCount(source: string): number {
  return source.split('\n').filter((line) => /\bunknown\b/u.test(line.split('//')[0])).length;
}

export function unknownBoundaryOwners(source: string): string[] {
  return topLevelDeclarations(source)
    .filter((declaration) => unknownBoundaryLineCount(regionSource(source, declaration)) > 0)
    .map(({ symbol }) => symbol);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export function read(relativePath: string): string {
  return readFileSync(absolute(relativePath), 'utf8');
}

function absolute(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}
