import { GraphProp, TreeGraph, VertexId } from './graph-props.ts';

export const MessageType = {
    TO_SERVER_ENTER: 'TO_SERVER_ENTER',
    TO_SERVER_LEAVE: 'TO_SERVER_LEAVE',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const ReconfigAlgo = {
    TEST_OPTIMAL_PAIR_WISE: 'TEST_OPTIMAL_PAIR_WISE',
    NO_RECONFIG_ALGO: 'NO_RECONFIG_ALGO',
} as const;

export type ReconfigAlgo = (typeof ReconfigAlgo)[keyof typeof ReconfigAlgo];

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