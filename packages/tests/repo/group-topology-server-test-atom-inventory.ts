import {
  movedTopologyTestSupportDeclarations,
  movedTopologyTestCases,
  taskTwoOnlyTopologyCoverage,
  topologyTestSourceCommit,
  topologyTestSupportDeclarations,
  type MovedTopologyTestCaseMapping,
} from './group-topology-server-pr-a-test-ownership.ts';
import {
  supportDeclarationNames,
  requireCase,
  testCases,
  type SemanticNode,
} from './group-topology-server-test-ast.ts';
import {
  declarationSemanticAtoms,
  read,
  readAtCommit,
  semanticAtoms,
  sourceKey,
  type SemanticAtom,
} from './group-topology-server-test-semantic-atoms.ts';

export interface DiscoveredSourceAtom extends SemanticAtom {
  readonly mapping: MovedTopologyTestCaseMapping;
}

export interface DiscoveredTargetAtom extends SemanticAtom {
  readonly ownerPath: string;
  readonly ownerCaseId: string;
  readonly category: 'moved-case' | 'support' | 'task-2-case';
}

export type TopologyTestTargetReader = (ownerPath: string) => string;

const supportCasePrefix = 'support:';

export function discoverTopologySourceAtoms(): DiscoveredSourceAtom[] {
  const casesByPath = new Map<string, Map<string, SemanticNode>>();
  const caseAtoms = movedTopologyTestCases.flatMap((mapping) => {
    let cases = casesByPath.get(mapping.sourcePath);
    if (!cases) {
      cases = testCases(readAtCommit(topologyTestSourceCommit, mapping.sourcePath));
      casesByPath.set(mapping.sourcePath, cases);
    }
    const sourceCase = requireCase(
      new Map([[mapping.sourcePath, cases]]),
      mapping.sourcePath,
      mapping.sourceCaseId,
    );
    return semanticAtoms(sourceCase).map((atom) => ({ ...atom, mapping }));
  });
  const sourceByPath = new Map(
    [...new Set(movedTopologyTestSupportDeclarations.map(({ sourcePath }) => sourcePath))].map(
      (sourcePath) => [sourcePath, readAtCommit(topologyTestSourceCommit, sourcePath)],
    ),
  );
  assertCompleteSourceSupportInventory(sourceByPath);
  const supportAtoms = movedTopologyTestSupportDeclarations.flatMap((declaration) => {
    const mapping: MovedTopologyTestCaseMapping = {
      sourcePath: declaration.sourcePath,
      sourceCaseId: `${supportCasePrefix}${declaration.sourceSymbol}`,
      ownerPath: declaration.ownerPath,
      ownerCaseId: `${supportCasePrefix}${declaration.ownerSymbol}`,
      allowedSupportSymbols: declaration.allowedOwnerSymbols,
    };
    return declarationSemanticAtoms(
      sourceByPath.get(declaration.sourcePath)!,
      declaration.sourceSymbol,
    ).map((atom) => ({ ...atom, mapping }));
  });
  return [...caseAtoms, ...supportAtoms];
}

export function discoverTopologyTargetAtoms(
  targetReader: TopologyTestTargetReader = read,
): DiscoveredTargetAtom[] {
  const movedCases = uniqueTargetCases(
    movedTopologyTestCases.map(({ ownerPath, ownerCaseId }) => [ownerPath, ownerCaseId]),
  );
  const additiveCases = uniqueTargetCases(taskTwoOnlyTopologyCoverage);
  assertCompleteTargetCaseInventory([...movedCases, ...additiveCases], targetReader);
  assertCompleteSupportDeclarationInventory(targetReader);
  const caseAtoms = [
    ...discoverTargetCases(movedCases, 'moved-case', targetReader),
    ...discoverTargetCases(additiveCases, 'task-2-case', targetReader),
  ];
  const supportAtoms = topologyTestSupportDeclarations.flatMap(({ ownerPath, symbol }) =>
    declarationSemanticAtoms(targetReader(ownerPath), symbol).map((atom) => ({
      ...atom,
      ownerPath,
      ownerCaseId: `${supportCasePrefix}${symbol}`,
      category: 'support' as const,
    })),
  );
  return [...caseAtoms, ...supportAtoms];
}

function assertCompleteTargetCaseInventory(
  declared: readonly (readonly [string, string])[],
  targetReader: TopologyTestTargetReader,
): void {
  const declaredByPath = Map.groupBy(declared, ([ownerPath]) => ownerPath);
  for (const [ownerPath, declarations] of declaredByPath) {
    const expected = new Set(declarations.map(([, ownerCaseId]) => ownerCaseId));
    const actual = new Set(testCases(targetReader(ownerPath)).keys());
    assertExactInventory(actual, expected, 'target test case', ownerPath);
  }
}

function assertCompleteSupportDeclarationInventory(targetReader: TopologyTestTargetReader): void {
  const declaredByPath = Map.groupBy(topologyTestSupportDeclarations, ({ ownerPath }) => ownerPath);
  for (const [ownerPath, declarations] of declaredByPath) {
    const expected = new Set(declarations.map(({ symbol }) => symbol));
    const actual = supportDeclarationNames(targetReader(ownerPath));
    assertExactInventory(actual, expected, 'target support declaration', ownerPath);
  }
}

function assertCompleteSourceSupportInventory(sourceByPath: ReadonlyMap<string, string>): void {
  const declaredByPath = Map.groupBy(
    movedTopologyTestSupportDeclarations,
    ({ sourcePath }) => sourcePath,
  );
  for (const [sourcePath, declarations] of declaredByPath) {
    const expected = new Set(declarations.map(({ sourceSymbol }) => sourceSymbol));
    const actual = supportDeclarationNames(sourceByPath.get(sourcePath)!);
    assertExactInventory(actual, expected, 'source support declaration', sourcePath);
  }
}

function assertExactInventory(
  actual: ReadonlySet<string>,
  expected: ReadonlySet<string>,
  label: string,
  ownerPath: string,
): void {
  const unclassified = [...actual].find((value) => !expected.has(value));
  if (unclassified) {
    throw new Error(`Unclassified ${label}: ${ownerPath}:${unclassified}`);
  }
  const missing = [...expected].find((value) => !actual.has(value));
  if (missing) {
    throw new Error(`Missing ${label}: ${ownerPath}:${missing}`);
  }
}

export function topologyAtomSourceKey(
  sourcePath: string,
  sourceCaseId: string,
  sourceAtomId: string,
): string {
  return [sourcePath, sourceCaseId, sourceAtomId].join('\0');
}

export function topologyAtomTargetKey(
  ownerPath: string,
  ownerCaseId: string,
  ownerAtomId: string,
): string {
  return [ownerPath, ownerCaseId, ownerAtomId].join('\0');
}

export function discoveredSourceAtomKey(atom: DiscoveredSourceAtom): string {
  return topologyAtomSourceKey(atom.mapping.sourcePath, atom.mapping.sourceCaseId, atom.id);
}

export function discoveredTargetAtomKey(atom: DiscoveredTargetAtom): string {
  return topologyAtomTargetKey(atom.ownerPath, atom.ownerCaseId, atom.id);
}

function discoverTargetCases(
  targets: readonly (readonly [string, string])[],
  category: 'moved-case' | 'task-2-case',
  targetReader: TopologyTestTargetReader,
): DiscoveredTargetAtom[] {
  const casesByPath = new Map(
    [...new Set(targets.map(([ownerPath]) => ownerPath))].map((ownerPath) => [
      ownerPath,
      testCases(targetReader(ownerPath)),
    ]),
  );
  return targets.flatMap(([ownerPath, ownerCaseId]) =>
    semanticAtoms(requireCase(casesByPath, ownerPath, ownerCaseId)).map((atom) => ({
      ...atom,
      ownerPath,
      ownerCaseId,
      category,
    })),
  );
}

function uniqueTargetCases(
  targets: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  return [...new Map(targets.map((target) => [sourceKey(...target), target])).values()];
}
