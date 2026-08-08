import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  movedTopologyTestCases,
  retainedTopologyCharacterizationOwners,
  taskTwoOnlyTopologyCoverage,
  topologyTestSourceCommit,
} from './group-topology-server-pr-a-test-ownership.ts';
import {
  oversizedGeneralFunctions,
  requireCase,
  requireCases,
  testCases,
} from './group-topology-server-test-ast.ts';
import {
  absolute,
  assertionCallsites,
  countKind,
  read,
  readAtCommit,
  semanticAtoms,
  sourceKey,
  testCallsites,
  type SemanticAtom,
  type SemanticAtomKind,
} from './group-topology-server-test-semantic-atoms.ts';

type OwnedSemanticAtom = SemanticAtom &
  Readonly<{
    sourceCommit: string;
    sourcePath: string;
    sourceCaseId: string;
    sourceAtomId: string;
    coverage: 'moved';
    ownerPath: string;
  }>;

const mappingsBySource = new Map(
  movedTopologyTestCases.map((mapping) => [
    sourceKey(mapping.sourcePath, mapping.sourceCaseId),
    mapping,
  ]),
);
const sourcePaths = [...new Set(movedTopologyTestCases.map(({ sourcePath }) => sourcePath))];
const movedOwnerPaths = [
  ...new Set(
    movedTopologyTestCases.flatMap(({ ownerPath, supportPaths = [] }) => [
      ownerPath,
      ...supportPaths,
    ]),
  ),
];
const repoEvidenceOwnerPaths = [
  'packages/tests/repo/group-topology-server-pr-a-test-ownership.ts',
  'packages/tests/repo/group-topology-server-test-ast.ts',
  'packages/tests/repo/group-topology-server-test-atom-inventory.ts',
  'packages/tests/repo/group-topology-server-test-atom-ownership-contracts.ts',
  'packages/tests/repo/group-topology-server-test-atom-ownership-validation.ts',
  'packages/tests/repo/group-topology-server-test-atom-ownership.test.ts',
  'packages/tests/repo/group-topology-server-test-atom-ownership.ts',
  'packages/tests/repo/group-topology-server-test-atom-translations.ts',
  'packages/tests/repo/group-topology-server-test-ownership.test.ts',
  'packages/tests/repo/group-topology-server-test-semantic-atoms.ts',
] as const;
const ownerPaths = [...new Set([...movedOwnerPaths, ...retainedTopologyCharacterizationOwners])];
const sourceCases = new Map(
  sourcePaths.map((sourcePath) => [
    sourcePath,
    testCases(readAtCommit(topologyTestSourceCommit, sourcePath)),
  ]),
);
const targetCases = new Map(
  ownerPaths
    .filter((ownerPath) => ownerPath.endsWith('.test.ts'))
    .map((ownerPath) => [ownerPath, testCases(read(ownerPath))]),
);
const ownedAtoms = movedTopologyTestCases.flatMap((mapping) => {
  const sourceCase = requireCase(sourceCases, mapping.sourcePath, mapping.sourceCaseId);
  return semanticAtoms(sourceCase).map((atom): OwnedSemanticAtom => ({
    ...atom,
    sourceCommit: topologyTestSourceCommit,
    sourcePath: mapping.sourcePath,
    sourceCaseId: mapping.sourceCaseId,
    sourceAtomId: atom.id,
    coverage: 'moved',
    ownerPath: mapping.ownerPath,
  }));
});

describe('group topology server PR-A test ownership', () => {
  it('maps every frozen-base source case to exactly one behavior owner', () => {
    const discovered = sourcePaths.flatMap((sourcePath) =>
      [...requireCases(sourceCases, sourcePath).keys()].map((caseId) =>
        sourceKey(sourcePath, caseId),
      ),
    );

    expect([...mappingsBySource.keys()].toSorted()).toEqual(discovered.toSorted());
    expect(new Set(mappingsBySource.keys()).size).toBe(movedTopologyTestCases.length);
    for (const mapping of movedTopologyTestCases) {
      expect(existsSync(absolute(mapping.sourcePath)), mapping.sourcePath).toBe(false);
      expect(existsSync(absolute(mapping.ownerPath)), mapping.ownerPath).toBe(true);
      requireCase(targetCases, mapping.ownerPath, mapping.ownerCaseId);
    }
  });

  it('partitions every source case/assertion/literal/barrier/fixture/variant atom exactly once', () => {
    const atomKeys = ownedAtoms.map(({ sourcePath, sourceCaseId, sourceAtomId }) =>
      [sourcePath, sourceCaseId, sourceAtomId].join('\0'),
    );

    expect(new Set(atomKeys).size).toBe(atomKeys.length);
    expect(new Set(ownedAtoms.map(({ kind }) => kind))).toEqual(
      new Set<SemanticAtomKind>([
        'assertion',
        'barrier',
        'case',
        'fixture',
        'raw-literal',
        'variant',
      ]),
    );
    for (const atom of ownedAtoms) {
      expect(atom.sourceCommit).toBe(topologyTestSourceCommit);
      expect(atom.coverage).toBe('moved');
      expect(existsSync(absolute(atom.ownerPath)), atom.sourceAtomId).toBe(true);
    }
  });

  it('keeps every moved assertion and expanded variant in its exact mapped target case', () => {
    const groupedMappings = Map.groupBy(movedTopologyTestCases, ({ ownerPath, ownerCaseId }) =>
      sourceKey(ownerPath, ownerCaseId),
    );
    for (const mappings of groupedMappings.values()) {
      const target = requireCase(targetCases, mappings[0].ownerPath, mappings[0].ownerCaseId);
      const targetAtoms = semanticAtoms(target);
      const sourceAtoms = mappings.flatMap((mapping) =>
        semanticAtoms(requireCase(sourceCases, mapping.sourcePath, mapping.sourceCaseId)),
      );
      for (const kind of ['assertion', 'variant'] as const) {
        expect(
          countKind(targetAtoms, kind),
          `${mappings[0].ownerPath}:${mappings[0].ownerCaseId}`,
        ).toBeGreaterThanOrEqual(countKind(sourceAtoms, kind));
      }
    }
  });
});

describe('group topology server PR-A retained and additive test coverage', () => {
  it('retains the moved fixture and all Task-1 transaction/exact-read/runtime support owners', () => {
    for (const ownerPath of retainedTopologyCharacterizationOwners) {
      expect(existsSync(absolute(ownerPath)), ownerPath).toBe(true);
    }
  });

  it('tracks Task-2-only coverage separately so it cannot mask moved atoms', () => {
    const movedTargetCases = new Set(
      movedTopologyTestCases.map(({ ownerPath, ownerCaseId }) => sourceKey(ownerPath, ownerCaseId)),
    );
    for (const [ownerPath, ownerCaseId] of taskTwoOnlyTopologyCoverage) {
      expect(movedTargetCases.has(sourceKey(ownerPath, ownerCaseId))).toBe(false);
      requireCase(targetCases, ownerPath, ownerCaseId);
    }
  });

  it('keeps aggregate case/assertion counts as supplementary diagnostics only', () => {
    const source = sourcePaths
      .map((sourcePath) => readAtCommit(topologyTestSourceCommit, sourcePath))
      .join('\n');
    const target = ownerPaths
      .filter((ownerPath) => ownerPath.endsWith('.test.ts'))
      .map(read)
      .join('\n');

    expect(testCallsites(target)).toBeGreaterThanOrEqual(testCallsites(source));
    expect(assertionCallsites(target)).toBeGreaterThanOrEqual(assertionCallsites(source));
  });

  it('keeps every moved test and support owner within 400 physical lines', () => {
    for (const ownerPath of [...movedOwnerPaths, ...repoEvidenceOwnerPaths]) {
      expect(read(ownerPath).split('\n').length, ownerPath).toBeLessThanOrEqual(401);
    }
  });

  it('keeps every moved test and support owner general function within 60 lines', () => {
    for (const ownerPath of [...movedOwnerPaths, ...repoEvidenceOwnerPaths]) {
      expect(oversizedGeneralFunctions(read(ownerPath)), ownerPath).toEqual([]);
    }
  });
});
