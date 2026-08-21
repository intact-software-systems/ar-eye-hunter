import { WeightedGraph } from '@shared-graph/graph/graph-props.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export type GraphInfo = {
    readonly groupRef: GroupRef;
    readonly graph: WeightedGraph;
    readonly groupGraph: WeightedGraph;
    readonly coreNodes: string[];
};

export type GraphInfoSnapshot = {
    readonly groupRef: GroupRef;
    readonly measured?: GraphInfo;
    readonly predicted: GraphInfo;
    readonly createdAtEpochMs: number;
    readonly version: number;
};
