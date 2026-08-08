import { createHash } from 'node:crypto';

import {
  movedTopologyTestCases,
  topologyTestSourceCommit,
  type MovedTopologyTestCaseMapping,
} from './group-topology-server-pr-a-test-ownership.ts';
import {
  discoverTopologySourceAtoms,
  discoverTopologyTargetAtoms,
  discoveredSourceAtomKey,
  discoveredTargetAtomKey,
  topologyAtomSourceKey,
  topologyAtomTargetKey,
  type DiscoveredSourceAtom,
  type DiscoveredTargetAtom,
  type TopologyTestTargetReader,
} from './group-topology-server-test-atom-inventory.ts';
import { read, sourceKey, type SemanticAtom } from './group-topology-server-test-semantic-atoms.ts';
import type {
  TopologyTestAdditiveAtom,
  TopologyTestAtomEndpoint,
  TopologyTestAtomOwnership,
} from './group-topology-server-test-atom-ownership-contracts.ts';
import { topologyTestAtomTranslations } from './group-topology-server-test-atom-translations.ts';

const caseConsolidationReason =
  'Two frozen source cases intentionally converge on one target scenario while retaining both source claims.';
const supportConsolidationReason =
  'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.';

export function createTopologyTestAtomOwnership(
  targetReader: TopologyTestTargetReader = read,
): TopologyTestAtomOwnership {
  const sourceAtoms = discoverTopologySourceAtoms();
  const targetAtoms = discoverTopologyTargetAtoms(targetReader);
  const usedTargets = new Set<string>();
  const assignments = new Map<string, TopologyTestAtomEndpoint>();
  assignCaseAtoms(sourceAtoms, targetAtoms, usedTargets, assignments);
  assignTranslatedBehaviorAtoms(sourceAtoms, targetAtoms, usedTargets, assignments);
  assignExactBehaviorAtoms(sourceAtoms, targetAtoms, usedTargets, assignments);
  assignSemanticBehaviorAtoms(sourceAtoms, targetAtoms, usedTargets, assignments);
  assertAllSourceAtomsAssigned(sourceAtoms, assignments);
  const moved = sourceAtoms.map((sourceAtom) =>
    assignments.get(topologySourceAtomKey(sourceAtom))!,
  );
  const additive = targetAtoms
    .filter((targetAtom) => !usedTargets.has(topologyTargetAtomKey(targetAtom)))
    .map(additiveTargetAtom);
  return { sourceCommit: topologyTestSourceCommit, moved, additive };
}

function assignSemanticBehaviorAtoms(
  sources: readonly DiscoveredSourceAtom[],
  targets: readonly DiscoveredTargetAtom[],
  usedTargets: Set<string>,
  assignments: Map<string, TopologyTestAtomEndpoint>,
): void {
  for (const source of unassignedBehaviorAtoms(sources, assignments)) {
    const target = chooseSemanticTarget(source, targets, usedTargets);
    if (target) {
      recordAssignment(source, target, usedTargets, assignments, 'semantic', null);
    }
  }
}

function assignCaseAtoms(
  sources: readonly DiscoveredSourceAtom[],
  targets: readonly DiscoveredTargetAtom[],
  usedTargets: Set<string>,
  assignments: Map<string, TopologyTestAtomEndpoint>,
): void {
  for (const source of sources.filter(({ kind }) => kind === 'case')) {
    const target = targetCaseAtom(source, targets);
    recordAssignment(
      source,
      target,
      usedTargets,
      assignments,
      caseDisposition(source, target),
      null,
    );
  }
}

function assignExactBehaviorAtoms(
  sources: readonly DiscoveredSourceAtom[],
  targets: readonly DiscoveredTargetAtom[],
  usedTargets: Set<string>,
  assignments: Map<string, TopologyTestAtomEndpoint>,
): void {
  for (const source of unassignedBehaviorAtoms(sources, assignments)) {
    const target = targets.find(
      (candidate) =>
        candidate.kind === source.kind &&
        candidate.fingerprint === source.fingerprint &&
        targetAllowed(source.mapping, candidate) &&
        !usedTargets.has(topologyTargetAtomKey(candidate)),
    );
    if (target) {
      recordAssignment(source, target, usedTargets, assignments, 'exact', null);
    }
  }
}

function assignTranslatedBehaviorAtoms(
  sources: readonly DiscoveredSourceAtom[],
  targets: readonly DiscoveredTargetAtom[],
  usedTargets: Set<string>,
  assignments: Map<string, TopologyTestAtomEndpoint>,
): void {
  const translations = new Map(
    topologyTestAtomTranslations.map((translation) => [
      topologyAtomSourceKey(
        translation.sourcePath,
        translation.sourceCaseId,
        translation.sourceAtomId,
      ),
      translation,
    ]),
  );
  for (const source of unassignedBehaviorAtoms(sources, assignments)) {
    const translation = translations.get(topologySourceAtomKey(source));
    if (!translation) {
      continue;
    }
    const target = targets.find(
      (candidate) =>
        candidate.ownerPath === translation.ownerPath &&
        candidate.ownerCaseId === translation.ownerCaseId &&
        candidate.id === translation.ownerAtomId,
    );
    if (!target || !targetAllowed(source.mapping, target)) {
      throw new Error(`Missing declared target translation: ${topologySourceAtomKey(source)}`);
    }
    if (target.kind !== source.kind) {
      throw new Error(`Translated target kind differs: ${topologySourceAtomKey(source)}`);
    }
    recordAssignment(source, target, usedTargets, assignments, 'translated', translation.reason);
  }
  for (const sourceKey of translations.keys()) {
    if (assignments.get(sourceKey)?.disposition !== 'translated') {
      throw new Error(`Unused declared target translation: ${sourceKey}`);
    }
  }
}

function assertAllSourceAtomsAssigned(
  sources: readonly DiscoveredSourceAtom[],
  assignments: ReadonlyMap<string, TopologyTestAtomEndpoint>,
): void {
  const missing = unassignedBehaviorAtoms(sources, assignments);
  if (missing.length > 0) {
    throw new Error(`Missing explicit target translation: ${topologySourceAtomKey(missing[0])}`);
  }
}

function unassignedBehaviorAtoms(
  sources: readonly DiscoveredSourceAtom[],
  assignments: ReadonlyMap<string, TopologyTestAtomEndpoint>,
): DiscoveredSourceAtom[] {
  return sources.filter(
    (source) => source.kind !== 'case' && !assignments.has(topologySourceAtomKey(source)),
  );
}

export function topologyTestAtomOwnershipDigest(ownership: TopologyTestAtomOwnership): string {
  return createHash('sha256').update(JSON.stringify(ownership)).digest('hex');
}

export function topologySourceAtomKey(
  atom: DiscoveredSourceAtom | TopologyTestAtomEndpoint,
): string {
  return 'mapping' in atom
    ? discoveredSourceAtomKey(atom)
    : topologyAtomSourceKey(atom.sourcePath, atom.sourceCaseId, atom.sourceAtomId);
}

export function topologyTargetAtomKey(
  atom: DiscoveredTargetAtom | TopologyTestAtomEndpoint | TopologyTestAdditiveAtom,
): string {
  return 'category' in atom
    ? discoveredTargetAtomKey(atom)
    : topologyAtomTargetKey(atom.ownerPath, atom.ownerCaseId, atom.ownerAtomId);
}

function recordAssignment(
  sourceAtom: DiscoveredSourceAtom,
  target: DiscoveredTargetAtom,
  usedTargets: Set<string>,
  assignments: Map<string, TopologyTestAtomEndpoint>,
  disposition: TopologyTestAtomEndpoint['disposition'],
  translationReason: string | null,
): void {
  const targetKey = topologyTargetAtomKey(target);
  const repeatedSupport = usedTargets.has(targetKey) && target.category === 'support';
  if (!repeatedSupport || sharedMatchScore(sourceAtom, target) < 100) {
    usedTargets.add(targetKey);
  } else {
    throw new Error(`No exact reusable target for ${topologySourceAtomKey(sourceAtom)}`);
  }
  const consolidation = targetConsolidation(sourceAtom, target);
  assignments.set(
    topologySourceAtomKey(sourceAtom),
    endpoint(
      sourceAtom,
      target,
      repeatedSupport ? 'shared-fixture' : disposition,
      translationReason,
      consolidation,
    ),
  );
}

function chooseSemanticTarget(
  source: DiscoveredSourceAtom,
  targets: readonly DiscoveredTargetAtom[],
  usedTargets: ReadonlySet<string>,
): DiscoveredTargetAtom | undefined {
  if (source.kind === 'assertion') {
    return undefined;
  }
  const eligible = targets.filter(
    (target) =>
      target.kind === source.kind &&
      targetAllowed(source.mapping, target) &&
      sharedMatchScore(source, target) < 100,
  );
  const unused = bestTarget(
    source,
    eligible.filter((target) => !usedTargets.has(topologyTargetAtomKey(target))),
  );
  const reused = reusableSupport(source, eligible, usedTargets);
  return reused && (!unused || targetScore(source, reused) < targetScore(source, unused))
    ? reused
    : unused;
}

function bestTarget(
  sourceAtom: DiscoveredSourceAtom,
  candidates: readonly DiscoveredTargetAtom[],
): DiscoveredTargetAtom | undefined {
  return candidates.toSorted(
    (left, right) => targetScore(sourceAtom, left) - targetScore(sourceAtom, right),
  )[0];
}

function targetScore(source: DiscoveredSourceAtom, target: DiscoveredTargetAtom): number {
  if (source.fingerprint === target.fingerprint) {
    return target.category === 'moved-case' ? 0 : 1;
  }
  return sharedMatchScore(source, target) + (target.category === 'moved-case' ? 0 : 1);
}

function sharedMatchScore(source: SemanticAtom, target: SemanticAtom): number {
  return source.matchKeys.reduce((best, key, sourceIndex) => {
    const targetIndex = target.matchKeys.indexOf(key);
    return targetIndex < 0 ? best : Math.min(best, 10 + sourceIndex * 4 + targetIndex);
  }, 100);
}

function reusableSupport(
  source: DiscoveredSourceAtom,
  candidates: readonly DiscoveredTargetAtom[],
  usedTargets: ReadonlySet<string>,
): DiscoveredTargetAtom | undefined {
  return bestTarget(
    source,
    candidates.filter(
      (target) =>
        target.category === 'support' &&
        sharedMatchScore(source, target) < 100 &&
        usedTargets.has(topologyTargetAtomKey(target)),
    ),
  );
}

function targetCaseAtom(
  source: DiscoveredSourceAtom,
  targets: readonly DiscoveredTargetAtom[],
): DiscoveredTargetAtom {
  const target = targets.find(
    (candidate) =>
      candidate.category === 'moved-case' &&
      candidate.kind === 'case' &&
      candidate.ownerPath === source.mapping.ownerPath &&
      candidate.ownerCaseId === source.mapping.ownerCaseId,
  );
  if (!target) {
    throw new Error(`Missing target case for ${topologySourceAtomKey(source)}`);
  }
  return target;
}

function targetAllowed(
  mapping: MovedTopologyTestCaseMapping,
  target: DiscoveredTargetAtom,
): boolean {
  if (target.category === 'moved-case') {
    return target.ownerPath === mapping.ownerPath && target.ownerCaseId === mapping.ownerCaseId;
  }
  const supportPaths = new Set([mapping.ownerPath, ...(mapping.supportPaths ?? [])]);
  const supportSymbol = target.ownerCaseId.slice('support:'.length);
  return (
    target.category === 'support' &&
    supportPaths.has(target.ownerPath) &&
    (!mapping.allowedSupportSymbols || mapping.allowedSupportSymbols.includes(supportSymbol))
  );
}

function targetConsolidation(
  source: DiscoveredSourceAtom,
  target: DiscoveredTargetAtom,
): Readonly<{ id: string; reason: string }> | null {
  if (target.category === 'support') {
    return { id: `support:${topologyTargetAtomKey(target)}`, reason: supportConsolidationReason };
  }
  const peers = movedTopologyTestCases.filter(
    ({ ownerPath, ownerCaseId }) =>
      ownerPath === source.mapping.ownerPath && ownerCaseId === source.mapping.ownerCaseId,
  );
  return source.kind === 'case' && peers.length > 1
    ? {
        id: `case:${sourceKey(target.ownerPath, target.ownerCaseId)}`,
        reason: caseConsolidationReason,
      }
    : null;
}

function caseDisposition(
  source: DiscoveredSourceAtom,
  target: DiscoveredTargetAtom,
): TopologyTestAtomEndpoint['disposition'] {
  const peers = movedTopologyTestCases.filter(
    ({ ownerPath, ownerCaseId }) =>
      ownerPath === source.mapping.ownerPath && ownerCaseId === source.mapping.ownerCaseId,
  );
  if (peers.length > 1) {
    return 'combined-case';
  }
  return source.fingerprint === target.fingerprint ? 'exact' : 'renamed-case';
}

function endpoint(
  source: DiscoveredSourceAtom,
  target: DiscoveredTargetAtom,
  disposition: TopologyTestAtomEndpoint['disposition'],
  translationReason: string | null,
  consolidation: Readonly<{ id: string; reason: string }> | null,
): TopologyTestAtomEndpoint {
  return {
    sourceCommit: topologyTestSourceCommit,
    sourcePath: source.mapping.sourcePath,
    sourceCaseId: source.mapping.sourceCaseId,
    sourceAtomId: source.id,
    sourceKind: source.kind,
    sourceFingerprint: source.fingerprint,
    sourceMatchKeys: source.matchKeys,
    ownerPath: target.ownerPath,
    ownerCaseId: target.ownerCaseId,
    ownerAtomId: target.id,
    ownerKind: target.kind,
    ownerFingerprint: target.fingerprint,
    ownerMatchKeys: target.matchKeys,
    coverage: 'moved',
    disposition,
    translationReason,
    consolidationId: consolidation?.id ?? null,
    consolidationReason: consolidation?.reason ?? null,
  };
}

function additiveTargetAtom(target: DiscoveredTargetAtom): TopologyTestAdditiveAtom {
  const reason =
    target.category === 'task-2-case'
      ? 'task-2-case'
      : target.category === 'support'
        ? 'new-target-support'
        : 'new-target-atom';
  return {
    ownerPath: target.ownerPath,
    ownerCaseId: target.ownerCaseId,
    ownerAtomId: target.id,
    ownerKind: target.kind,
    ownerFingerprint: target.fingerprint,
    ownerMatchKeys: target.matchKeys,
    coverage: 'task-2-only',
    reason,
  };
}
