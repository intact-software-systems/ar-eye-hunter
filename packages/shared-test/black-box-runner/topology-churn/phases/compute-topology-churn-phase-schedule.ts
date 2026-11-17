import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';

export const TOPOLOGY_CHURN_INTERVAL_MS = 3_000;

export type TopologyChurnPhaseSpec =
    | { readonly name: 'churn' | 'flap'; readonly shape: 'alternate'; readonly durationMs: number; }
    | { readonly name: 'ramp-up'; readonly shape: 'ramp'; readonly toMemberCount: 'one-past-mesh-entry'; }
    | { readonly name: 'ramp-down'; readonly shape: 'ramp'; readonly toMemberCount: 'one-below-tree-entry'; };

export type TopologyChurnAction = { readonly kind: 'join'; } | { readonly kind: 'leave'; };

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
        return {
            name: spec.name,
            steps: toSteps(stepCount, (index) => index % 2 === 0 ? { kind: 'join' } : { kind: 'leave' }),
            durationMs: spec.durationMs
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
