import type { ControlFleetAgentRunOutcome, ControlFleetTimingDistribution } from '../../../control-run-manager.ts';

export type FleetFilterState = Readonly<{
    region: string;
    provider: string;
    recipeId: string;
    groupId: string;
    state: string;
    window: '1h' | '24h' | '7d' | 'all';
}>;

export type FleetAgentHeatmapRow = Readonly<{
    agent: ControlFleetAgentRunOutcome;
    region: string;
    provider: string;
    cells: readonly (ControlFleetAgentRunOutcome | undefined)[];
}>;

export type FleetTimingGroup = Readonly<{
    id: string;
    label: string;
    timing: ControlFleetTimingDistribution;
}>;

export type FleetLabelOverride = Readonly<{
    region?: string;
    provider?: string;
    datacenter?: string;
    hostId?: string;
    agentPoolId?: string;
    deploymentId?: string;
    browserName?: string;
    browserVersion?: string;
    os?: string;
    tags?: readonly string[];
}>;
