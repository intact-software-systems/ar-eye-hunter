import { parse } from '@babel/parser';

export interface LineageBoundaryRegion {
  readonly symbol: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sha256: string;
}

export interface LineageBoundaryLocation {
  readonly path: string;
  readonly blob: string;
  readonly regions: readonly LineageBoundaryRegion[];
}

export interface LineageBoundaryRow {
  readonly id: string;
  readonly source: LineageBoundaryLocation;
  readonly targets: readonly LineageBoundaryLocation[];
  readonly magnitude: Readonly<Record<string, number | string>>;
  readonly derivation: Readonly<Record<string, boolean | string>>;
}

export interface LineageBoundaryBijectionInput {
  readonly rows: readonly LineageBoundaryRow[];
  readonly sourcePath: string;
  readonly boundaryOwnerPath: string;
  readonly validationValueOwnerPath: string;
  readonly sourcesByPath: Readonly<Record<string, string>>;
}

const ingressPairs = [
  [
    'generation-boundary',
    'validateGroupTopologyConfigGeneration',
    'readTopologyConfigGenerationBoundary',
  ],
  [
    'invariant-generation-boundary',
    'validateGroupTopologyConfigInvariantGeneration',
    'readTopologyConfigInvariantGenerationBoundary',
  ],
  [
    'stored-config-boundary',
    'validateStoredGroupTopologyConfig',
    'readStoredTopologyConfigBoundary',
  ],
  [
    'stored-override-boundary',
    'validateStoredGroupTopologyOverride',
    'readStoredTopologyOverrideBoundary',
  ],
  [
    'mutation-record-boundary',
    'validateGroupTopologyConfigMutationRecord',
    'readTopologyConfigMutationRecordBoundary',
  ],
  ['receipt-boundary', 'validateTopologyConfigReceipt', 'readTopologyConfigReceiptBoundary'],
] as const;

const resolvedPairs = [
  ['accepted-config-boundary', 'validateAcceptedTopologyConfig', 'validateAcceptedTopologyConfig'],
  ['group-ref-boundary', 'validateGroupRef', 'validateTopologyGroupRef'],
  ['causal-revision-boundary', 'validateCausalRevision', 'validateTopologyCausalRevision'],
  ['exact-keys-boundary', 'validateExactKeys', 'validateTopologyConfigExactKeys'],
  ['positive-integer-boundary', 'validatePositiveInteger', 'validateTopologyPositiveInteger'],
  ['storage-revision-boundary', 'validateStorageRevision', 'validateTopologyStorageRevision'],
  ['required-string-boundary', 'requireString', 'requireTopologyString'],
  ['record-boundary', 'isRecord', 'validateTopologyConfigObject'],
] as const;

const allPairs = [...ingressPairs, ...resolvedPairs] as const;
export const expectedBoundaryOwners = ingressPairs.map(([, , targetSymbol]) => targetSymbol);
export const expectedResolvedBoundaryOwners = resolvedPairs.map(
  ([, , targetSymbol]) => targetSymbol,
);

export function validateLineageBoundaryBijection(input: LineageBoundaryBijectionInput): void {
  const rows = input.rows.filter(({ magnitude }) => magnitude.rule === 'boundary.unknown');
  requireBijection(rows.length === allPairs.length, 'boundary-row-count');
  requireUnique(
    rows.map(({ id }) => id),
    'row-id',
  );
  const coverage: MutableBoundaryCoverage = {
    sourceRegionKeys: [],
    boundaryRegionKeys: [],
    resolvedRegionKeys: [],
    coveredSourceLines: [],
    coveredBoundaryLines: [],
  };
  for (const [id, sourceSymbol, targetSymbol] of ingressPairs) {
    const row = requireRow(rows, id);
    requireBijection(row.derivation.capacityEligible === true, `${id}:capacity`);
    validateSourceRow(input, row, sourceSymbol, coverage);
    validateIngressTarget(input, row, targetSymbol, coverage);
  }
  for (const [id, sourceSymbol, targetSymbol] of resolvedPairs) {
    const row = requireRow(rows, id);
    requireBijection(row.derivation.capacityEligible === false, `${id}:capacity`);
    validateSourceRow(input, row, sourceSymbol, coverage);
    validateResolvedTarget(input, row, targetSymbol, coverage);
  }
  requireUnique(coverage.sourceRegionKeys, 'source-region');
  requireUnique(coverage.boundaryRegionKeys, 'boundary-region');
  requireUnique(coverage.resolvedRegionKeys, 'resolved-region');
  validateCompleteCoverage(input, coverage);
}

function requireRow(rows: readonly LineageBoundaryRow[], id: string): LineageBoundaryRow {
  const matches = rows.filter((candidate) => candidate.id === id);
  requireBijection(matches.length === 1, `row:${id}`);
  return matches[0];
}

function validateSourceRow(
  input: LineageBoundaryBijectionInput,
  row: LineageBoundaryRow,
  sourceSymbol: string,
  coverage: MutableBoundaryCoverage,
): void {
  requireBijection(row.source.path === input.sourcePath, `${row.id}:source-path`);
  requireBijection(row.source.regions.length === 1, `${row.id}:source-region-count`);
  const region = row.source.regions[0];
  requireBijection(region.symbol === sourceSymbol, `${row.id}:source-symbol`);
  const lines = unknownLines(regionSource(requireSource(input, row.source.path), region));
  requireBijection(lines.length === 1, `${row.id}:source-magnitude`);
  coverage.sourceRegionKeys.push(regionKey(row.source, region));
  coverage.coveredSourceLines.push(region.startLine + lines[0] - 1);
}

function validateIngressTarget(
  input: LineageBoundaryBijectionInput,
  row: LineageBoundaryRow,
  targetSymbol: string,
  coverage: MutableBoundaryCoverage,
): void {
  const boundaryTargets = row.targets.filter(({ path }) => path === input.boundaryOwnerPath);
  requireBijection(boundaryTargets.length === 1, `${row.id}:boundary-target-count`);
  requireBijection(boundaryTargets[0].regions.length === 1, `${row.id}:target-region-count`);
  const region = boundaryTargets[0].regions[0];
  requireBijection(region.symbol === targetSymbol, `${row.id}:target-symbol`);
  const lines = unknownLines(regionSource(requireSource(input, boundaryTargets[0].path), region));
  requireBijection(lines.length === 1, `${row.id}:target-magnitude`);
  coverage.boundaryRegionKeys.push(regionKey(boundaryTargets[0], region));
  coverage.coveredBoundaryLines.push(region.startLine + lines[0] - 1);
  for (const target of row.targets.filter(({ path }) => path !== input.boundaryOwnerPath)) {
    requireBijection(locationUnknownCount(input, target) === 0, `${row.id}:typed-continuation`);
  }
}

function validateResolvedTarget(
  input: LineageBoundaryBijectionInput,
  row: LineageBoundaryRow,
  targetSymbol: string,
  coverage: MutableBoundaryCoverage,
): void {
  requireBijection(row.targets.length === 1, `${row.id}:resolved-target-count`);
  const target = row.targets[0];
  requireBijection(target.path === input.validationValueOwnerPath, `${row.id}:resolved-path`);
  requireBijection(target.regions.length === 1, `${row.id}:resolved-region-count`);
  const region = target.regions[0];
  requireBijection(region.symbol === targetSymbol, `${row.id}:resolved-symbol`);
  requireBijection(locationUnknownCount(input, target) === 0, `${row.id}:resolved-magnitude`);
  coverage.resolvedRegionKeys.push(regionKey(target, region));
}

function validateCompleteCoverage(
  input: LineageBoundaryBijectionInput,
  coverage: MutableBoundaryCoverage,
): void {
  const source = requireSource(input, input.sourcePath);
  const boundary = requireSource(input, input.boundaryOwnerPath);
  requireSameSet(coverage.coveredSourceLines, unknownLines(source), 'source-line-coverage');
  requireSameSet(coverage.coveredBoundaryLines, unknownLines(boundary), 'target-line-coverage');
  requireSameSet(
    allPairs.map(([, sourceSymbol]) => sourceSymbol),
    unknownOwnerSymbols(source),
    'source-owner-coverage',
  );
  requireSameSet(expectedBoundaryOwners, unknownOwnerSymbols(boundary), 'target-owner-coverage');
}

function locationUnknownCount(
  input: LineageBoundaryBijectionInput,
  location: LineageBoundaryLocation,
): number {
  const source = requireSource(input, location.path);
  return location.regions.reduce(
    (total, region) => total + unknownLines(regionSource(source, region)).length,
    0,
  );
}

function unknownOwnerSymbols(source: string): string[] {
  return topLevelDeclarations(source)
    .filter((declaration) => unknownLines(regionSource(source, declaration)).length > 0)
    .map(({ symbol }) => symbol);
}

function topLevelDeclarations(source: string): LineageBoundaryRegion[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  return ast.program.body.flatMap((statement) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (!declaration?.loc || !('id' in declaration) || declaration.id?.type !== 'Identifier') {
      return [];
    }
    return [
      {
        symbol: declaration.id.name,
        startLine: declaration.loc.start.line,
        endLine: declaration.loc.end.line,
        sha256: '',
      },
    ];
  });
}

function unknownLines(source: string): number[] {
  return source
    .split('\n')
    .flatMap((line, index) => (/\bunknown\b/u.test(line.split('//')[0]) ? [index + 1] : []));
}

function regionSource(source: string, region: LineageBoundaryRegion): string {
  return source
    .split('\n')
    .slice(region.startLine - 1, region.endLine)
    .join('\n');
}

function regionKey(location: LineageBoundaryLocation, region: LineageBoundaryRegion): string {
  return [location.path, region.symbol, region.startLine, region.endLine, region.sha256].join(':');
}

function requireSource(input: LineageBoundaryBijectionInput, sourcePath: string): string {
  const source = input.sourcesByPath[sourcePath];
  requireBijection(typeof source === 'string', `missing-source:${sourcePath}`);
  return source;
}

function requireUnique(values: readonly string[], label: string): void {
  requireBijection(new Set(values).size === values.length, `duplicate-${label}`);
}

function requireSameSet(
  actual: readonly (number | string)[],
  expected: readonly (number | string)[],
  label: string,
): void {
  requireBijection(
    JSON.stringify([...new Set(actual)].toSorted()) ===
      JSON.stringify([...new Set(expected)].toSorted()),
    label,
  );
}

function requireBijection(condition: boolean, label: string): asserts condition {
  if (!condition) {
    throw new Error(`boundary-bijection:${label}`);
  }
}

interface MutableBoundaryCoverage {
  readonly sourceRegionKeys: string[];
  readonly boundaryRegionKeys: string[];
  readonly resolvedRegionKeys: string[];
  readonly coveredSourceLines: number[];
  readonly coveredBoundaryLines: number[];
}
