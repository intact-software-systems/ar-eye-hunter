import { declaredTopologyTestAtomEndpoints } from './group-topology-server-test-atom-endpoint-declarations.ts';
import {
  discoverTopologySourceAtoms,
  discoverTopologyTargetAtoms,
  type DiscoveredSourceAtom,
  type DiscoveredTargetAtom,
  type TopologyTestTargetReader,
} from './group-topology-server-test-atom-inventory.ts';
import {
  topologyCaseConsolidationReason,
  topologySupportConsolidationReason,
  type TopologyTestAdditiveAtom,
  type TopologyTestAtomEndpoint,
  type TopologyTestAtomOwnership,
} from './group-topology-server-test-atom-ownership-contracts.ts';
import {
  topologySourceAtomKey,
  topologyTargetAtomKey,
} from './group-topology-server-test-atom-ownership.ts';
import {
  movedTopologyTestCases,
  movedTopologyTestSupportDeclarations,
  topologyTestSourceCommit,
  type MovedTopologyTestCaseMapping,
} from './group-topology-server-pr-a-test-ownership.ts';
import { topologyTestAtomTranslations } from './group-topology-server-test-atom-translations.ts';

export function validateTopologyTestAtomOwnership(
  ownership: TopologyTestAtomOwnership,
  targetReader?: TopologyTestTargetReader,
): void {
  if (ownership.sourceCommit !== topologyTestSourceCommit) {
    throw new Error(`Unexpected source commit: ${ownership.sourceCommit}`);
  }
  const discoveredSources = discoverTopologySourceAtoms();
  const discoveredTargets = discoverTopologyTargetAtoms(targetReader);
  validateTargetClaims(ownership);
  validateDispositions(ownership.moved);
  validateSourcePartition(ownership.moved, discoveredSources);
  validateTargetPartition(ownership, discoveredTargets);
  validateDeclaredDestinations(ownership.moved);
  validateDeclaredEndpointTable(ownership.moved);
  validateAutomaticExactEndpoints(ownership.moved, discoveredTargets);
  validateTranslations(ownership.moved);
}

function validateSourcePartition(
  endpoints: readonly TopologyTestAtomEndpoint[],
  discovered: readonly DiscoveredSourceAtom[],
): void {
  const claims = uniqueBy(endpoints, topologySourceAtomKey, 'source atom claim');
  const sources = uniqueBy(discovered, topologySourceAtomKey, 'discovered source atom');
  assertExactKeys(claims, sources, 'source atom');
  for (const [key, source] of sources) {
    const endpoint = claims.get(key)!;
    if (
      endpoint.sourceCommit !== topologyTestSourceCommit ||
      endpoint.sourceKind !== source.kind ||
      endpoint.sourceFingerprint !== source.fingerprint ||
      !sameValues(endpoint.sourceMatchKeys, source.matchKeys) ||
      endpoint.coverage !== 'moved'
    ) {
      throw new Error(`Source atom evidence differs: ${key}`);
    }
  }
}

function validateTargetPartition(
  ownership: TopologyTestAtomOwnership,
  discovered: readonly DiscoveredTargetAtom[],
): void {
  const targets = uniqueBy(discovered, topologyTargetAtomKey, 'discovered target atom');
  const claims = [...ownership.moved, ...ownership.additive];
  assertExactKeySets(
    new Set(claims.map(topologyTargetAtomKey)),
    new Set(targets.keys()),
    'target atom',
  );
  for (const claim of claims) {
    const key = topologyTargetAtomKey(claim);
    const target = targets.get(key);
    if (
      !target ||
      claim.ownerKind !== target.kind ||
      claim.ownerFingerprint !== target.fingerprint ||
      !sameValues(claim.ownerMatchKeys, target.matchKeys)
    ) {
      throw new Error(`Target atom evidence differs: ${key}`);
    }
    validateAdditiveReason(claim, target);
  }
}

function validateTargetClaims(ownership: TopologyTestAtomOwnership): void {
  const grouped = Map.groupBy([...ownership.moved, ...ownership.additive], topologyTargetAtomKey);
  for (const [key, claims] of grouped) {
    if (claims.length === 1) {
      const [claim] = claims;
      if (
        claim.coverage === 'moved' &&
        (claim.consolidationId !== null || claim.consolidationReason !== null)
      ) {
        throw new Error(`Consolidation metadata on unique target claim: ${key}`);
      }
      continue;
    }
    if (claims.length > 1 && !isValidConsolidation(claims)) {
      throw new Error(`Duplicate target claim without exact consolidation: ${key}`);
    }
  }
}

function isValidConsolidation(
  claims: readonly (TopologyTestAtomEndpoint | TopologyTestAdditiveAtom)[],
): boolean {
  if (claims.some((claim) => claim.coverage !== 'moved')) {
    return false;
  }
  const moved = claims as readonly TopologyTestAtomEndpoint[];
  const ids = new Set(moved.map(({ consolidationId }) => consolidationId));
  const reasons = new Set(moved.map(({ consolidationReason }) => consolidationReason));
  if (ids.size !== 1 || ids.has(null) || reasons.size !== 1 || reasons.has(null)) {
    return false;
  }
  const first = moved[0]!;
  if (moved.every(({ sourceKind }) => sourceKind === 'case')) {
    return (
      first.consolidationId === `case:${sourceMappingKey(first.ownerPath, first.ownerCaseId)}` &&
      first.consolidationReason === topologyCaseConsolidationReason
    );
  }
  return (
    moved.every(({ ownerCaseId }) => ownerCaseId.startsWith('support:')) &&
    first.consolidationId === `support:${topologyTargetAtomKey(first)}` &&
    first.consolidationReason === topologySupportConsolidationReason &&
    moved.every(
      ({ sourceMatchKeys, ownerMatchKeys, disposition, translationReason }) =>
        sourceMatchKeys.some((key) => ownerMatchKeys.includes(key)) ||
        (disposition === 'translated' && translationReason !== null),
    )
  );
}

function validateDeclaredDestinations(endpoints: readonly TopologyTestAtomEndpoint[]): void {
  const mappings = sourceMappings();
  for (const endpoint of endpoints) {
    const mapping = mappings.get(sourceMappingKey(endpoint.sourcePath, endpoint.sourceCaseId));
    if (!mapping || !endpointAllowed(mapping, endpoint.ownerPath, endpoint.ownerCaseId)) {
      throw new Error(
        `Target atom leaves its declared owner set: ${topologySourceAtomKey(endpoint)}`,
      );
    }
  }
}

function validateDispositions(endpoints: readonly TopologyTestAtomEndpoint[]): void {
  for (const endpoint of endpoints) {
    if (endpoint.ownerKind !== endpoint.sourceKind) {
      throw new Error(`Target atom kind differs: ${topologySourceAtomKey(endpoint)}`);
    }
    const contextualSharedKey = endpoint.sourceMatchKeys.some(
      (key) => isContextualMatchKey(key) && endpoint.ownerMatchKeys.includes(key),
    );
    if (
      ['declared-exact', 'exact'].includes(endpoint.disposition) &&
      endpoint.sourceFingerprint !== endpoint.ownerFingerprint
    ) {
      throw new Error(`Exact atom fingerprint differs: ${topologySourceAtomKey(endpoint)}`);
    }
    if (
      endpoint.disposition === 'semantic' &&
      (!contextualSharedKey || endpoint.sourceKind === 'assertion')
    ) {
      throw new Error(
        `Semantic atom lacks a specific normalized key: ${topologySourceAtomKey(endpoint)}`,
      );
    }
    if (
      endpoint.disposition === 'shared-fixture' &&
      !endpoint.consolidationId?.startsWith('support:')
    ) {
      throw new Error(
        `Shared fixture lacks exact consolidation: ${topologySourceAtomKey(endpoint)}`,
      );
    }
    if (endpoint.disposition === 'renamed-case' && endpoint.sourceKind !== 'case') {
      throw new Error(`Renamed non-case atom: ${topologySourceAtomKey(endpoint)}`);
    }
    if (
      endpoint.disposition === 'combined-case' &&
      !endpoint.consolidationId?.startsWith('case:')
    ) {
      throw new Error(
        `Combined case lacks exact consolidation: ${topologySourceAtomKey(endpoint)}`,
      );
    }
    const isDeclared = ['declared-exact', 'semantic', 'shared-fixture'].includes(
      endpoint.disposition,
    );
    if (isDeclared !== (endpoint.declarationReason !== null)) {
      throw new Error(`Declaration reason disposition differs: ${topologySourceAtomKey(endpoint)}`);
    }
    if ((endpoint.disposition === 'translated') !== (endpoint.translationReason !== null)) {
      throw new Error(`Translation reason disposition differs: ${topologySourceAtomKey(endpoint)}`);
    }
  }
}

function validateDeclaredEndpointTable(endpoints: readonly TopologyTestAtomEndpoint[]): void {
  const declared = uniqueBy(
    declaredTopologyTestAtomEndpoints,
    (entry) => sourceMappingKey(entry.sourcePath, entry.sourceCaseId, entry.sourceAtomId),
    'declared atom endpoint',
  );
  const claimed = uniqueBy(
    endpoints.filter(({ disposition }) =>
      ['declared-exact', 'semantic', 'shared-fixture'].includes(disposition),
    ),
    topologySourceAtomKey,
    'claimed declared atom endpoint',
  );
  assertExactKeys(claimed, declared, 'declared atom endpoint');
  for (const [key, declaration] of declared) {
    const endpoint = claimed.get(key)!;
    if (
      endpoint.sourceFingerprint !== declaration.sourceFingerprint ||
      endpoint.ownerPath !== declaration.ownerPath ||
      endpoint.ownerCaseId !== declaration.ownerCaseId ||
      endpoint.ownerAtomId !== declaration.ownerAtomId ||
      endpoint.ownerFingerprint !== declaration.ownerFingerprint ||
      endpoint.disposition !== declaration.disposition ||
      endpoint.declarationReason !== declaration.declarationReason ||
      endpoint.consolidationId !== declaration.consolidationId ||
      endpoint.consolidationReason !== declaration.consolidationReason
    ) {
      throw new Error(`Declared atom endpoint differs: ${key}`);
    }
  }
}

function validateAutomaticExactEndpoints(
  endpoints: readonly TopologyTestAtomEndpoint[],
  targets: readonly DiscoveredTargetAtom[],
): void {
  const mappings = sourceMappings();
  for (const endpoint of endpoints.filter(
    ({ disposition, sourceKind }) => disposition === 'exact' && sourceKind !== 'case',
  )) {
    const mapping = mappings.get(sourceMappingKey(endpoint.sourcePath, endpoint.sourceCaseId))!;
    const candidates = targets.filter(
      (target) =>
        target.kind === endpoint.sourceKind &&
        target.fingerprint === endpoint.sourceFingerprint &&
        endpointAllowed(mapping, target.ownerPath, target.ownerCaseId),
    );
    if (candidates.length !== 1) {
      throw new Error(
        `Automatic exact target endpoint count differs: ${topologySourceAtomKey(endpoint)}`,
      );
    }
    if (topologyTargetAtomKey(candidates[0]) !== topologyTargetAtomKey(endpoint)) {
      throw new Error(
        `Automatic exact target endpoint differs: ${topologySourceAtomKey(endpoint)}`,
      );
    }
  }
}

function validateTranslations(endpoints: readonly TopologyTestAtomEndpoint[]): void {
  const translated = new Map(
    endpoints
      .filter(({ disposition }) => disposition === 'translated')
      .map((endpoint) => [topologySourceAtomKey(endpoint), endpoint]),
  );
  if (translated.size !== topologyTestAtomTranslations.length) {
    throw new Error('Translated target atom count differs from the declared table');
  }
  for (const declaration of topologyTestAtomTranslations) {
    const key = sourceMappingKey(
      declaration.sourcePath,
      declaration.sourceCaseId,
      declaration.sourceAtomId,
    );
    const endpoint = translated.get(key);
    if (
      !endpoint ||
      endpoint.ownerPath !== declaration.ownerPath ||
      endpoint.ownerCaseId !== declaration.ownerCaseId ||
      endpoint.ownerAtomId !== declaration.ownerAtomId ||
      endpoint.translationReason !== declaration.reason
    ) {
      throw new Error(`Declared target translation differs: ${key}`);
    }
  }
}

function sourceMappings(): ReadonlyMap<string, MovedTopologyTestCaseMapping> {
  const mappings = [
    ...movedTopologyTestCases,
    ...movedTopologyTestSupportDeclarations.map((declaration) => ({
      sourcePath: declaration.sourcePath,
      sourceCaseId: `support:${declaration.sourceSymbol}`,
      ownerPath: declaration.ownerPath,
      ownerCaseId: `support:${declaration.ownerSymbol}`,
      allowedSupportSymbols: declaration.allowedOwnerSymbols,
    })),
  ];
  return new Map(
    mappings.map((mapping) => [
      sourceMappingKey(mapping.sourcePath, mapping.sourceCaseId),
      mapping,
    ]),
  );
}

function endpointAllowed(
  mapping: MovedTopologyTestCaseMapping,
  ownerPath: string,
  ownerCaseId: string,
): boolean {
  if (ownerPath === mapping.ownerPath && ownerCaseId === mapping.ownerCaseId) {
    return true;
  }
  const supportSymbol = ownerCaseId.slice('support:'.length);
  return (
    ownerCaseId.startsWith('support:') &&
    [mapping.ownerPath, ...(mapping.supportPaths ?? [])].includes(ownerPath) &&
    (!mapping.allowedSupportSymbols || mapping.allowedSupportSymbols.includes(supportSymbol))
  );
}

function validateAdditiveReason(
  claim: TopologyTestAtomEndpoint | TopologyTestAdditiveAtom,
  target: DiscoveredTargetAtom,
): void {
  if (claim.coverage === 'moved') {
    return;
  }
  const expected =
    target.category === 'task-2-case'
      ? 'task-2-case'
      : target.category === 'support'
        ? 'new-target-support'
        : 'new-target-atom';
  if (claim.coverage !== 'task-2-only' || claim.reason !== expected) {
    throw new Error(`Incorrect additive target classification: ${topologyTargetAtomKey(claim)}`);
  }
}

function sourceMappingKey(...parts: readonly string[]): string {
  return parts.join('\0');
}

function uniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (indexed.has(key)) {
      throw new Error(`Duplicate ${label}: ${key}`);
    }
    indexed.set(key, value);
  }
  return indexed;
}

function assertExactKeys<T, U>(
  left: ReadonlyMap<string, T>,
  right: ReadonlyMap<string, U>,
  label: string,
): void {
  assertExactKeySets(new Set(left.keys()), new Set(right.keys()), label);
}

function assertExactKeySets(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  label: string,
): void {
  const missing = [...right].find((key) => !left.has(key));
  const extra = [...left].find((key) => !right.has(key));
  if (missing || extra) {
    throw new Error(`${label} partition differs: missing=${missing ?? '-'} extra=${extra ?? '-'}`);
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isContextualMatchKey(key: string): boolean {
  return !/^literal:[^:]+$/u.test(key);
}
