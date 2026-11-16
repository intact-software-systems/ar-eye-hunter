export const TOPOLOGY_RESHAPE_REASONS = [
    'leader-rooting',
    'delta-too-large',
    'update-failed',
    'invariant-violation',
    'kind-change',
    'refinement'
] as const;

export type TopologyReshapeReason = (typeof TOPOLOGY_RESHAPE_REASONS)[number];

export type TopologyPlanChange =
    | Readonly<{ kind: 'attach'; }>
    | Readonly<{ kind: 'repair'; }>
    | Readonly<{ kind: 'reshape'; reason: TopologyReshapeReason; }>;
