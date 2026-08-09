import type { SemanticAtomKind } from './group-topology-server-test-semantic-atoms.ts';

export const topologyCaseConsolidationReason =
  'Two frozen source cases intentionally converge on one target scenario while retaining both source claims.';
export const topologySupportConsolidationReason =
  'One mechanically extracted fixture/helper atom represents repeated identical frozen source atoms.';

export interface TopologyTestAtomEndpoint {
  readonly sourceCommit: string;
  readonly sourcePath: string;
  readonly sourceCaseId: string;
  readonly sourceAtomId: string;
  readonly sourceKind: SemanticAtomKind;
  readonly sourceFingerprint: string;
  readonly sourceMatchKeys: readonly string[];
  readonly ownerPath: string;
  readonly ownerCaseId: string;
  readonly ownerAtomId: string;
  readonly ownerKind: SemanticAtomKind;
  readonly ownerFingerprint: string;
  readonly ownerMatchKeys: readonly string[];
  readonly coverage: 'moved';
  readonly disposition:
    | 'combined-case'
    | 'declared-exact'
    | 'exact'
    | 'renamed-case'
    | 'semantic'
    | 'shared-fixture'
    | 'translated';
  readonly translationReason: string | null;
  readonly declarationReason: string | null;
  readonly consolidationId: string | null;
  readonly consolidationReason: string | null;
}

export interface TopologyTestAdditiveAtom {
  readonly ownerPath: string;
  readonly ownerCaseId: string;
  readonly ownerAtomId: string;
  readonly ownerKind: SemanticAtomKind;
  readonly ownerFingerprint: string;
  readonly ownerMatchKeys: readonly string[];
  readonly coverage: 'task-2-only';
  readonly reason: 'new-target-atom' | 'new-target-support' | 'task-2-case';
}

export interface TopologyTestAtomOwnership {
  readonly sourceCommit: string;
  readonly moved: readonly TopologyTestAtomEndpoint[];
  readonly additive: readonly TopologyTestAdditiveAtom[];
}
