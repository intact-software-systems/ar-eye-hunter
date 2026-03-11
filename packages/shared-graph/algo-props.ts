import { GraphProp, TreeGraph, VertexId } from './graph-props.ts';

export enum MessageType {
    TO_SERVER_ENTER = 'TO_SERVER_ENTER',
    TO_SERVER_LEAVE = 'TO_SERVER_LEAVE',
}

export enum ReconfigAlgo {
    TEST_OPTIMAL_PAIR_WISE = 'TEST_OPTIMAL_PAIR_WISE',
    NO_RECONFIG_ALGO = 'NO_RECONFIG_ALGO',
}

export type MessageLike = {
    type: MessageType;
    groupId: string;
};

export type GroupInformation = {
    getMembers(): ReadonlySet<string>;
    getTreeStructure(): TreeGraph;
};


export type SelectSteinerCandidate = (
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId,
    adjacent: ReadonlySet<VertexId>,
) => VertexId | undefined;

export type GlobalArgs = {
    diameterBound: number
    reconfigAlgo: ReconfigAlgo
};

export const DEFAULT_K_CORE_NODES = 2;

export const DEFAULT_GRAPH_PROP: GraphProp = {
    id: 'global',
    version: 1,
    degreeLimitMember: 4,
    degreeLimitSteiner: 8
};

export const DEFAULT_GLOBAL_ARGS: GlobalArgs = {
    diameterBound: 2,
    reconfigAlgo: ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE
};