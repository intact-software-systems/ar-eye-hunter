import {
  discoverTopologySourceAtoms,
  discoverTopologyTargetAtoms,
  type DiscoveredSourceAtom,
  type DiscoveredTargetAtom,
  type TopologyTestTargetReader,
} from './group-topology-server-test-atom-inventory.ts';
import {
  topologySourceAtomKey,
  topologyTargetAtomKey,
  type TopologyTestAdditiveAtom,
  type TopologyTestAtomEndpoint,
  type TopologyTestAtomOwnership,
} from './group-topology-server-test-atom-ownership.ts';
import {
  movedTopologyTestSupportDeclarations,
  movedTopologyTestCases,
  topologyTestSourceCommit,
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
  validateSourcePartition(ownership.moved, discoveredSources);
  validateTargetPartition(ownership, discoveredTargets);
  validateDeclaredDestinations(ownership.moved);
  validateDispositions(ownership.moved);
  validateTopologySupportDestinationSpecificity(ownership.moved, discoveredTargets);
  validateTranslations(ownership.moved);
}

export function validateTopologySupportDestinationSpecificity(
  endpoints: readonly TopologyTestAtomEndpoint[],
  targets: readonly DiscoveredTargetAtom[],
): void {
  const declarations = new Map(
    movedTopologyTestSupportDeclarations.map((declaration) => [
      `${declaration.sourcePath}\0support:${declaration.sourceSymbol}`,
      declaration,
    ]),
  );
  for (const endpoint of endpoints) {
    const declaration = declarations.get(`${endpoint.sourcePath}\0${endpoint.sourceCaseId}`);
    if (!declaration || !['semantic', 'shared-fixture'].includes(endpoint.disposition)) {
      continue;
    }
    const candidates = targets.filter(
      (target) =>
        target.category === 'support' &&
        target.ownerPath === declaration.ownerPath &&
        declaration.allowedOwnerSymbols.includes(target.ownerCaseId.slice('support:'.length)) &&
        target.kind === endpoint.sourceKind,
    );
    const bestScore = Math.min(
      ...candidates.map((target) => semanticMatchScore(endpoint.sourceMatchKeys, target.matchKeys)),
    );
    const assignedScore = semanticMatchScore(endpoint.sourceMatchKeys, endpoint.ownerMatchKeys);
    if (assignedScore !== bestScore) {
      throw new Error(
        `Support target is less specific than an eligible target: ${endpoint.sourceAtomId}`,
      );
    }
  }
}

function semanticMatchScore(source: readonly string[], target: readonly string[]): number {
  return source.reduce((best, key, sourceIndex) => {
    const targetIndex = target.indexOf(key);
    return targetIndex < 0 ? best : Math.min(best, 10 + sourceIndex * 4 + targetIndex);
  }, 100);
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
  const claimKeys = new Set(claims.map(topologyTargetAtomKey));
  assertExactKeySets(claimKeys, new Set(targets.keys()), 'target atom');
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
      continue;
    }
    if (!isValidConsolidation(claims)) {
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
  const consolidationIds = new Set(moved.map(({ consolidationId }) => consolidationId));
  const reasons = new Set(moved.map(({ consolidationReason }) => consolidationReason));
  if (consolidationIds.size !== 1 || consolidationIds.has(null) || reasons.has(null)) {
    return false;
  }
  if (moved.every(({ sourceKind }) => sourceKind === 'case')) {
    return String(moved[0].consolidationId).startsWith('case:');
  }
  return (
    String(moved[0].consolidationId).startsWith('support:') &&
    moved.every(
      ({ sourceMatchKeys, ownerMatchKeys, disposition, translationReason }) =>
        sourceMatchKeys.some((key) => ownerMatchKeys.includes(key)) ||
        (disposition === 'translated' && translationReason !== null),
    )
  );
}

function validateDeclaredDestinations(endpoints: readonly TopologyTestAtomEndpoint[]): void {
  const mappings = new Map(
    [
      ...movedTopologyTestCases,
      ...movedTopologyTestSupportDeclarations.map((declaration) => ({
        sourcePath: declaration.sourcePath,
        sourceCaseId: `support:${declaration.sourceSymbol}`,
        ownerPath: declaration.ownerPath,
        ownerCaseId: `support:${declaration.ownerSymbol}`,
        allowedSupportSymbols: declaration.allowedOwnerSymbols,
      })),
    ].map((mapping) => [[mapping.sourcePath, mapping.sourceCaseId].join('\0'), mapping]),
  );
  for (const endpoint of endpoints) {
    const mapping = mappings.get([endpoint.sourcePath, endpoint.sourceCaseId].join('\0'));
    if (
      !mapping ||
      (endpoint.ownerPath !== mapping.ownerPath &&
        !mapping.supportPaths?.includes(endpoint.ownerPath))
    ) {
      throw new Error(
        `Target atom leaves its declared owner set: ${topologySourceAtomKey(endpoint)}`,
      );
    }
    const isTargetCase =
      endpoint.ownerPath === mapping.ownerPath && endpoint.ownerCaseId === mapping.ownerCaseId;
    const isSupport = endpoint.ownerCaseId.startsWith('support:');
    const supportSymbol = endpoint.ownerCaseId.slice('support:'.length);
    const isAllowedSupport =
      isSupport &&
      (!mapping.allowedSupportSymbols || mapping.allowedSupportSymbols.includes(supportSymbol));
    if (!isTargetCase && !isAllowedSupport) {
      throw new Error(
        `Target atom leaves its declared case/support: ${topologySourceAtomKey(endpoint)}`,
      );
    }
  }
}

function validateDispositions(endpoints: readonly TopologyTestAtomEndpoint[]): void {
  for (const endpoint of endpoints) {
    if (endpoint.ownerKind !== endpoint.sourceKind) {
      throw new Error(`Target atom kind differs: ${topologySourceAtomKey(endpoint)}`);
    }
    const sharedKey = endpoint.sourceMatchKeys.some((key) => endpoint.ownerMatchKeys.includes(key));
    if (
      endpoint.disposition === 'exact' &&
      endpoint.sourceFingerprint !== endpoint.ownerFingerprint
    ) {
      throw new Error(`Exact atom fingerprint differs: ${topologySourceAtomKey(endpoint)}`);
    }
    if (
      endpoint.disposition === 'semantic' &&
      (!sharedKey || endpoint.sourceKind === 'assertion')
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
    if ((endpoint.disposition === 'translated') !== (endpoint.translationReason !== null)) {
      throw new Error(`Translation reason disposition differs: ${topologySourceAtomKey(endpoint)}`);
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
    const key = [declaration.sourcePath, declaration.sourceCaseId, declaration.sourceAtomId].join(
      '\0',
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
  const missing = [...right].filter((key) => !left.has(key));
  const extra = [...left].filter((key) => !right.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} partition differs: missing=${missing[0] ?? '-'} extra=${extra[0] ?? '-'}`,
    );
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
