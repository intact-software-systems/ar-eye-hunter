export const TOPOLOGY_CHURN_INTERVAL_MS = 3_000;

export interface TopologyChurnPhaseSpec {
    readonly name: 'churn';
    readonly shape: 'alternate';
    readonly durationMs: number;
}

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

export function computeTopologyChurnPhaseSchedule(spec: TopologyChurnPhaseSpec): TopologyChurnPhaseSchedule {
    const stepCount = Math.ceil(spec.durationMs / TOPOLOGY_CHURN_INTERVAL_MS);
    return {
        name: spec.name,
        steps: Array.from({ length: stepCount }, (_, index) => ({
            offsetMs: index * TOPOLOGY_CHURN_INTERVAL_MS,
            action: index % 2 === 0 ? { kind: 'join' } : { kind: 'leave' }
        })),
        durationMs: spec.durationMs
    };
}
