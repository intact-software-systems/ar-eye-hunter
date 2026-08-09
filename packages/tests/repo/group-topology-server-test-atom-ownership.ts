import { createHash } from 'node:crypto';

import {
  movedTopologyTestCases,
  topologyTestSourceCommit,
  type MovedTopologyTestCaseMapping,
} from './group-topology-server-pr-a-test-ownership.ts';
import {
  declaredTopologyTargetConsolidation,
  declaredTopologyTestAtomEndpoints,
} from './group-topology-server-test-atom-endpoint-declarations.ts';
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
import { read, sourceKey } from './group-topology-server-test-semantic-atoms.ts';
import {
  topologyCaseConsolidationReason,
  type TopologyTestAdditiveAtom,
  type TopologyTestAtomEndpoint,
  type TopologyTestAtomOwnership,
} from './group-topology-server-test-atom-ownership-contracts.ts';
import { topologyTestAtomTranslations } from './group-topology-server-test-atom-translations.ts';

interface AtomAssignmentState {
  readonly usedTargets: Set<string>;
  readonly assignments: Map<string, TopologyTestAtomEndpoint>;
}

interface AtomAssignmentEvidence {
  readonly disposition: TopologyTestAtomEndpoint['disposition'];
  readonly translationReason: string | null;
  readonly declarationReason: string | null;
  readonly consolidation: Readonly<{ id: string; reason: string }> | null;
}

export function createTopologyTestAtomOwnership(
  targetReader: TopologyTestTargetReader = read,
): TopologyTestAtomOwnership {
  const sources = discoverTopologySourceAtoms();
  const targets = discoverTopologyTargetAtoms(targetReader);
  const state: AtomAssignmentState = {
    usedTargets: new Set<string>(),
    assignments: new Map<string, TopologyTestAtomEndpoint>(),
  };
  assignCaseAtoms(sources, targets, state);
  assignTranslatedBehaviorAtoms(sources, targets, state);
  assignDeclaredBehaviorAtoms(sources, targets, state, [
    'declared-exact',
    'semantic',
    'shared-fixture',
  ]);
  assertDeclaredBehaviorAtomsAssigned(state.assignments);
  assignUniqueExactBehaviorAtoms(sources, targets, state);
  assertAllSourceAtomsAssigned(sources, state.assignments);
  const moved = sources.map((source) => state.assignments.get(topologySourceAtomKey(source))!);
  const additive = targets
    .filter((target) => !state.usedTargets.has(topologyTargetAtomKey(target)))
    .map(additiveTargetAtom);
  return { sourceCommit: topologyTestSourceCommit, moved, additive };
}

function assignCaseAtoms(
  sources: readonly DiscoveredSourceAtom[],
  targets: readonly DiscoveredTargetAtom[],
  state: AtomAssignmentState,
): void {
  for (const source of sources.filter(({ kind }) => kind === 'case')) {
    const candidates = targets.filter(
      (target) =>
        target.category === 'moved-case' &&
        target.kind === 'case' &&
        target.ownerPath === source.mapping.ownerPath &&
        target.ownerCaseId === source.mapping.ownerCaseId,
    );
    const target = requireUniqueTarget(
      candidates,
      `target case for ${topologySourceAtomKey(source)}`,
    );
    recordAssignment(source, target, state, {
      disposition: caseDisposition(source, target),
      translationReason: null,
      declarationReason: null,
      consolidation: caseConsolidation(source, target),
    });
  }
}

function assignTranslatedBehaviorAtoms(
  sources: readonly DiscoveredSourceAtom[],
  targets: readonly DiscoveredTargetAtom[],
  state: AtomAssignmentState,
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
  for (const source of unassignedBehaviorAtoms(sources, state.assignments)) {
    const translation = translations.get(topologySourceAtomKey(source));
    if (!translation) {
      continue;
    }
    const target = requireUniqueTarget(
      targets.filter(
        (candidate) =>
          candidate.ownerPath === translation.ownerPath &&
          candidate.ownerCaseId === translation.ownerCaseId &&
          candidate.id === translation.ownerAtomId,
      ),
      `declared target translation for ${topologySourceAtomKey(source)}`,
    );
    if (!targetAllowed(source.mapping, target) || target.kind !== source.kind) {
      throw new Error(`Invalid declared target translation: ${topologySourceAtomKey(source)}`);
    }
    recordAssignment(source, target, state, {
      disposition: 'translated',
      translationReason: translation.reason,
      declarationReason: null,
      consolidation: declaredTopologyTargetConsolidation(
        target.ownerPath,
        target.ownerCaseId,
        target.id,
      ),
    });
  }
  for (const sourceKey of translations.keys()) {
    if (state.assignments.get(sourceKey)?.disposition !== 'translated') {
      throw new Error(`Unused declared target translation: ${sourceKey}`);
    }
  }
}

function assignDeclaredBehaviorAtoms(
  sources: readonly DiscoveredSourceAtom[],
  targets: readonly DiscoveredTargetAtom[],
  state: AtomAssignmentState,
  dispositions: readonly DeclaredDisposition[],
): void {
  const sourcesByKey = new Map(sources.map((source) => [topologySourceAtomKey(source), source]));
  for (const declaration of declaredTopologyTestAtomEndpoints.filter(({ disposition }) =>
    dispositions.includes(disposition),
  )) {
    const sourceKey = topologyAtomSourceKey(
      declaration.sourcePath,
      declaration.sourceCaseId,
      declaration.sourceAtomId,
    );
    if (state.assignments.has(sourceKey)) {
      throw new Error(`Duplicate declared atom endpoint: ${sourceKey}`);
    }
    const source = sourcesByKey.get(sourceKey);
    if (!source || source.fingerprint !== declaration.sourceFingerprint) {
      throw new Error(`Missing declared source atom endpoint: ${sourceKey}`);
    }
    const target = requireUniqueTarget(
      targets.filter(
        (candidate) =>
          candidate.ownerPath === declaration.ownerPath &&
          candidate.ownerCaseId === declaration.ownerCaseId &&
          candidate.id === declaration.ownerAtomId,
      ),
      `declared target atom endpoint for ${sourceKey}`,
    );
    if (
      target.fingerprint !== declaration.ownerFingerprint ||
      target.kind !== source.kind ||
      !targetAllowed(source.mapping, target)
    ) {
      throw new Error(`Invalid declared target atom endpoint: ${sourceKey}`);
    }
    recordAssignment(source, target, state, {
      disposition: declaration.disposition,
      translationReason: null,
      declarationReason: declaration.declarationReason,
      consolidation:
        declaration.consolidationId && declaration.consolidationReason
          ? {
              id: declaration.consolidationId,
              reason: declaration.consolidationReason,
            }
          : null,
    });
  }
}

type DeclaredDisposition = (typeof declaredTopologyTestAtomEndpoints)[number]['disposition'];

function assertDeclaredBehaviorAtomsAssigned(
  assignments: ReadonlyMap<string, TopologyTestAtomEndpoint>,
): void {
  for (const declaration of declaredTopologyTestAtomEndpoints) {
    const sourceKey = topologyAtomSourceKey(
      declaration.sourcePath,
      declaration.sourceCaseId,
      declaration.sourceAtomId,
    );
    if (assignments.get(sourceKey)?.disposition !== declaration.disposition) {
      throw new Error(`Unused declared atom endpoint: ${sourceKey}`);
    }
  }
}

function assignUniqueExactBehaviorAtoms(
  sources: readonly DiscoveredSourceAtom[],
  targets: readonly DiscoveredTargetAtom[],
  state: AtomAssignmentState,
): void {
  for (const source of unassignedBehaviorAtoms(sources, state.assignments)) {
    const candidates = targets.filter(
      (target) =>
        target.kind === source.kind &&
        target.fingerprint === source.fingerprint &&
        targetAllowed(source.mapping, target),
    );
    const target = requireUniqueTarget(
      candidates,
      `unique exact target endpoint for ${topologySourceAtomKey(source)}`,
    );
    if (state.usedTargets.has(topologyTargetAtomKey(target))) {
      throw new Error(`Exact target already claimed: ${topologyTargetAtomKey(target)}`);
    }
    recordAssignment(source, target, state, {
      disposition: 'exact',
      translationReason: null,
      declarationReason: null,
      consolidation: null,
    });
  }
}

function recordAssignment(
  source: DiscoveredSourceAtom,
  target: DiscoveredTargetAtom,
  state: AtomAssignmentState,
  evidence: AtomAssignmentEvidence,
): void {
  const targetKey = topologyTargetAtomKey(target);
  if (state.usedTargets.has(targetKey) && !evidence.consolidation) {
    throw new Error(`Duplicate target without declared consolidation: ${targetKey}`);
  }
  state.usedTargets.add(targetKey);
  state.assignments.set(topologySourceAtomKey(source), endpoint(source, target, evidence));
}

function requireUniqueTarget(
  candidates: readonly DiscoveredTargetAtom[],
  label: string,
): DiscoveredTargetAtom {
  if (candidates.length !== 1) {
    throw new Error(`${label} count differs: ${candidates.length}`);
  }
  return candidates[0];
}

function assertAllSourceAtomsAssigned(
  sources: readonly DiscoveredSourceAtom[],
  assignments: ReadonlyMap<string, TopologyTestAtomEndpoint>,
): void {
  const [missing] = unassignedBehaviorAtoms(sources, assignments);
  if (missing) {
    throw new Error(`Missing explicit target endpoint: ${topologySourceAtomKey(missing)}`);
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

export const topologyTestAtomOwnershipDigest = (value: TopologyTestAtomOwnership): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

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

function caseConsolidation(
  source: DiscoveredSourceAtom,
  target: DiscoveredTargetAtom,
): Readonly<{ id: string; reason: string }> | null {
  const peers = movedTopologyTestCases.filter(
    ({ ownerPath, ownerCaseId }) =>
      ownerPath === source.mapping.ownerPath && ownerCaseId === source.mapping.ownerCaseId,
  );
  return source.kind === 'case' && peers.length > 1
    ? {
        id: `case:${sourceKey(target.ownerPath, target.ownerCaseId)}`,
        reason: topologyCaseConsolidationReason,
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
  evidence: AtomAssignmentEvidence,
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
    disposition: evidence.disposition,
    translationReason: evidence.translationReason,
    declarationReason: evidence.declarationReason,
    consolidationId: evidence.consolidation?.id ?? null,
    consolidationReason: evidence.consolidation?.reason ?? null,
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
