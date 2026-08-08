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
  readonly sourcesByPath: Readonly<Record<string, string>>;
}

const expectedBoundaryPairs = [
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
  ['accepted-config-boundary', 'validateAcceptedTopologyConfig', 'validateAcceptedTopologyConfig'],
  ['group-ref-boundary', 'validateGroupRef', 'validateTopologyGroupRef'],
  ['causal-revision-boundary', 'validateCausalRevision', 'validateTopologyCausalRevision'],
  ['exact-keys-boundary', 'validateExactKeys', 'validateTopologyConfigExactKeys'],
  ['positive-integer-boundary', 'validatePositiveInteger', 'validateTopologyPositiveInteger'],
  ['storage-revision-boundary', 'validateStorageRevision', 'validateTopologyStorageRevision'],
  ['required-string-boundary', 'requireString', 'requireTopologyString'],
  ['record-boundary', 'isRecord', 'isTopologyConfigRecord'],
] as const;

export const expectedBoundaryOwners = expectedBoundaryPairs.map(
  ([, , targetSymbol]) => targetSymbol,
);

export function validateLineageBoundaryBijection(input: LineageBoundaryBijectionInput): void {
  const eligible = input.rows.filter(({ derivation }) => derivation.capacityEligible === true);
  requireBijection(eligible.length === expectedBoundaryPairs.length, 'eligible-row-count');
  requireUnique(
    eligible.map(({ id }) => id),
    'row-id',
  );

  const sourceRegionKeys: string[] = [];
  const targetRegionKeys: string[] = [];
  const coveredSourceLines: number[] = [];
  const coveredTargetLines: number[] = [];
  for (const [id, sourceSymbol, targetSymbol] of expectedBoundaryPairs) {
    const row = eligible.find((candidate) => candidate.id === id);
    requireBijection(Boolean(row), `missing-row:${id}`);
    validateBoundaryRow(input, row!, sourceSymbol, targetSymbol, {
      sourceRegionKeys,
      targetRegionKeys,
      coveredSourceLines,
      coveredTargetLines,
    });
  }
  requireUnique(sourceRegionKeys, 'source-region');
  requireUnique(targetRegionKeys, 'target-region');
  validateCompleteCoverage(input, coveredSourceLines, coveredTargetLines);
}

function validateBoundaryRow(
  input: LineageBoundaryBijectionInput,
  row: LineageBoundaryRow,
  sourceSymbol: string,
  targetSymbol: string,
  coverage: MutableBoundaryCoverage,
): void {
  requireBijection(row.source.path === input.sourcePath, `${row.id}:source-path`);
  requireBijection(row.source.regions.length === 1, `${row.id}:source-region-count`);
  const sourceRegion = row.source.regions[0];
  requireBijection(sourceRegion.symbol === sourceSymbol, `${row.id}:source-symbol`);
  const sourceLines = unknownLines(
    regionSource(requireSource(input, row.source.path), sourceRegion),
  );
  requireBijection(sourceLines.length === 1, `${row.id}:source-magnitude`);
  coverage.sourceRegionKeys.push(regionKey(row.source, sourceRegion));
  coverage.coveredSourceLines.push(sourceRegion.startLine + sourceLines[0] - 1);

  const boundaryTargets = row.targets.filter(({ path }) => path === input.boundaryOwnerPath);
  requireBijection(boundaryTargets.length === 1, `${row.id}:boundary-target-count`);
  requireBijection(boundaryTargets[0].regions.length === 1, `${row.id}:target-region-count`);
  const targetRegion = boundaryTargets[0].regions[0];
  requireBijection(targetRegion.symbol === targetSymbol, `${row.id}:target-symbol`);
  const targetLines = unknownLines(
    regionSource(requireSource(input, boundaryTargets[0].path), targetRegion),
  );
  requireBijection(targetLines.length === 1, `${row.id}:target-magnitude`);
  coverage.targetRegionKeys.push(regionKey(boundaryTargets[0], targetRegion));
  coverage.coveredTargetLines.push(targetRegion.startLine + targetLines[0] - 1);
  validateTypedContinuations(input, row);
}

function validateTypedContinuations(
  input: LineageBoundaryBijectionInput,
  row: LineageBoundaryRow,
): void {
  for (const target of row.targets) {
    if (target.path === input.boundaryOwnerPath) {
      continue;
    }
    const source = requireSource(input, target.path);
    const count = target.regions.reduce(
      (total, region) => total + unknownLines(regionSource(source, region)).length,
      0,
    );
    requireBijection(count === 0, `${row.id}:typed-continuation`);
  }
}

function validateCompleteCoverage(
  input: LineageBoundaryBijectionInput,
  coveredSourceLines: readonly number[],
  coveredTargetLines: readonly number[],
): void {
  const source = requireSource(input, input.sourcePath);
  const target = requireSource(input, input.boundaryOwnerPath);
  requireSameSet(coveredSourceLines, unknownLines(source), 'source-line-coverage');
  requireSameSet(coveredTargetLines, unknownLines(target), 'target-line-coverage');
  requireSameSet(
    expectedBoundaryPairs.map(([, sourceSymbol]) => sourceSymbol),
    unknownOwnerSymbols(source),
    'source-owner-coverage',
  );
  requireSameSet(
    expectedBoundaryPairs.map(([, , targetSymbol]) => targetSymbol),
    unknownOwnerSymbols(target),
    'target-owner-coverage',
  );
}

function unknownOwnerSymbols(source: string): string[] {
  return topLevelDeclarations(source)
    .filter((declaration) => unknownLines(regionSource(source, declaration)).length > 0)
    .map(({ symbol }) => symbol);
}

function topLevelDeclarations(source: string): Array<LineageBoundaryRegion> {
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
  readonly targetRegionKeys: string[];
  readonly coveredSourceLines: number[];
  readonly coveredTargetLines: number[];
}
