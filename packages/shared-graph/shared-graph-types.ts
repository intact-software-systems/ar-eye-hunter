import { WeightedGraph } from '@shared-graph/graph/graph-props.ts';

export type GraphInfo = {
    readonly graphId: string;
    readonly graph: WeightedGraph;
    readonly groupGraph: WeightedGraph;
    readonly coreNodes: string[];
}

export type GraphInfoSnapshot = {
    readonly graphId: string;
    readonly measured?: GraphInfo;
    readonly predicted: GraphInfo;
    readonly createdAtEpochMs: number;
    readonly version: number;
}
