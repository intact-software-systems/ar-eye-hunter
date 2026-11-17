import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';

export const TOPOLOGY_CHURN_INTERVAL_MS = 3_000;
/** An interleaved appointment follows every fourth membership slot, half an interval after it. */
export const TOPOLOGY_CHURN_INTERLEAVE_SLOTS = 4;
export const TOPOLOGY_CHURN_INTERLEAVE_OFFSET_MS = 1_500;

export type TopologyChurnPhaseSpec =
    | {
        readonly name: 'churn' | 'flap' | 'leader-churn';
        readonly shape: 'alternate';
        readonly durationMs: number;
        readonly interleaved: 'none' | 'appoint-deepest';
    }
    | { readonly name: 'ramp-up'; readonly shape: 'ramp'; readonly toMemberCount: 'one-past-mesh-entry'; }
    | { readonly name: 'ramp-down'; readonly shape: 'ramp'; readonly toMemberCount: 'one-below-tree-entry'; }
    | { readonly name: 'leader'; readonly shape: 'appointments'; readonly count: number; readonly intervalMs: number; };

export type TopologyChurnAction =
    | { readonly kind: 'join'; }
    | { readonly kind: 'leave'; }
    | { readonly kind: 'appoint'; readonly candidate: 'creator' | 'deepest'; };

export interface TopologyChurnStep {
    readonly offsetMs: number;
    readonly action: TopologyChurnAction;
}

export interface TopologyChurnPhaseSchedule {
    readonly name: TopologyChurnPhaseSpec['name'];
    readonly steps: readonly TopologyChurnStep[];
    readonly durationMs: number;
}

interface ComputeTopologyChurnPhaseScheduleInput {
    readonly spec: TopologyChurnPhaseSpec;
    /** The members present when the phase starts; a ramp walks from this count to its target. */
    readonly presentMemberCount: number;
    readonly topologyConfig: EffectiveGroupTopologyConfig;
}

export function computeTopologyChurnPhaseSchedule(
    input: ComputeTopologyChurnPhaseScheduleInput
): TopologyChurnPhaseSchedule {
    const { spec } = input;
    if (spec.shape === 'alternate') {
        const stepCount = Math.ceil(spec.durationMs / TOPOLOGY_CHURN_INTERVAL_MS);
        const membershipSteps = toSteps(stepCount, (index) => index % 2 === 0 ? { kind: 'join' } : { kind: 'leave' });
        return {
            name: spec.name,
            steps: spec.interleaved === 'none' ? membershipSteps : toInterleavedSteps(membershipSteps),
            durationMs: spec.durationMs
        };
    }
    if (spec.shape === 'appointments') {
        return {
            name: spec.name,
            steps: Array.from({ length: spec.count }, (_, index) => ({
                offsetMs: index * spec.intervalMs,
                action: { kind: 'appoint', candidate: index === 0 ? 'creator' : 'deepest' }
            })),
            durationMs: spec.count * spec.intervalMs
        };
    }
    const difference = resolveRampTargetMemberCount(spec.toMemberCount, input.topologyConfig) -
        input.presentMemberCount;
    const action: TopologyChurnAction = difference > 0 ? { kind: 'join' } : { kind: 'leave' };
    const stepCount = Math.abs(difference);
    return {
        name: spec.name,
        steps: toSteps(stepCount, () => action),
        durationMs: stepCount * TOPOLOGY_CHURN_INTERVAL_MS
    };
}

function resolveRampTargetMemberCount(
    toMemberCount: 'one-past-mesh-entry' | 'one-below-tree-entry',
    topologyConfig: EffectiveGroupTopologyConfig
): number {
    return toMemberCount === 'one-past-mesh-entry' ? topologyConfig.meshMinSize + 1 : topologyConfig.treeMinSize - 1;
}

function toSteps(stepCount: number, toAction: (index: number) => TopologyChurnAction): readonly TopologyChurnStep[] {
    return Array.from({ length: stepCount }, (_, index) => ({
        offsetMs: index * TOPOLOGY_CHURN_INTERVAL_MS,
        action: toAction(index)
    }));
}

function toInterleavedSteps(membershipSteps: readonly TopologyChurnStep[]): readonly TopologyChurnStep[] {
    return membershipSteps.flatMap((step, index) =>
        index % TOPOLOGY_CHURN_INTERLEAVE_SLOTS === 0
            ? [step, {
                offsetMs: step.offsetMs + TOPOLOGY_CHURN_INTERLEAVE_OFFSET_MS,
                action: { kind: 'appoint', candidate: 'deepest' }
            }]
            : [step]
    );
}
