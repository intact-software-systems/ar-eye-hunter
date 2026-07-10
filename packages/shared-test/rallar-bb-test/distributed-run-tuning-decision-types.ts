import type {
    DistributedRunTuningInventory,
    DistributedRunTuningKnob,
} from './distributed-run-tuning.ts';

export type DistributedRunTuningHintKind =
    | 'fix-target-readiness'
    | 'raise-ack-timeout'
    | 'raise-barrier-timeout'
    | 'lower-cadence'
    | 'adjust-stream-threshold'
    | 'investigate-agent'
    | 'insufficient-evidence';

export type DistributedRunTuningHint = Readonly<{
    id: string;
    kind: DistributedRunTuningHintKind;
    priority: number;
    category: string;
    title: string;
    rationale: string;
    nextAction: string;
    evidence: readonly string[];
    knob?: Pick<DistributedRunTuningKnob, 'name' | 'pointer' | 'currentValue'>;
    candidatePointers?: readonly string[];
    agentId?: string;
    evidencePointer?: string;
}>;

export type DistributedRunTuningDecisionIssueCode =
    | 'no-performance-evidence'
    | 'partial-evidence'
    | 'reference-only-recipe'
    | 'inventory-limited'
    | 'aggregate-threshold-evidence'
    | 'multiple-streams'
    | 'duplicate-command-id'
    | 'pointer-ambiguity'
    | 'equal-slow-agents'
    | 'blocked-knob'
    | 'unclassified-evidence';

export type DistributedRunTuningDecisionIssue = Readonly<{
    code: DistributedRunTuningDecisionIssueCode;
    message: string;
    pointers?: readonly string[];
}>;

export type DistributedRunTuningDecisionResult = Readonly<{
    state: 'blocked' | 'ready' | 'ambiguous' | 'insufficient' | 'clean';
    hints: readonly DistributedRunTuningHint[];
    issues: readonly DistributedRunTuningDecisionIssue[];
}>;

export function tuningInventoryIssues(
    inventory: DistributedRunTuningInventory,
): DistributedRunTuningDecisionIssue[] {
    return inventory.limitations.map(row => tuningDecisionIssue(
        row.code === 'reference-only-recipe' ? 'reference-only-recipe' : 'inventory-limited',
        row.message,
    ));
}

export function tuningDecisionIssue(
    code: DistributedRunTuningDecisionIssueCode,
    message: string,
    pointers?: readonly string[],
): DistributedRunTuningDecisionIssue {
    return { code, message, pointers };
}
