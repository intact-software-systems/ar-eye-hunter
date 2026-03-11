import { CoreSelectionAlgo } from '../graph/steiner-core-algorithms.ts';
import { TreeGraph, VertexId } from '../graph-props.ts';

export enum GraphAlgo {
    COMPLETE_MEMBER_GRAPH = 'COMPLETE_MEMBER_GRAPH',
    COMPLETE_MEMBER_GRAPH_NEW_STEINER = 'COMPLETE_MEMBER_GRAPH_NEW_STEINER',
    COMPLETE_MEMBER_GRAPH_KEEP_STEINER = 'COMPLETE_MEMBER_GRAPH_KEEP_STEINER',
    COMPLETE_GRAPH = 'COMPLETE_GRAPH',
    NO_GRAPH_ALGO = 'NO_GRAPH_ALGO',
}

export type CompleteGraphInputDto = {
    globalGraph: TreeGraph;
    currentGraph?: TreeGraph;
    groupMembers: ReadonlySet<VertexId>;
    newMember?: VertexId;
    existingSteiner?: ReadonlySet<VertexId>;
    fifoSteinerSet?: ReadonlySet<VertexId>;
    algo: GraphAlgo;
    update: boolean;
    wcnAlgo: CoreSelectionAlgo;
    deps: {
        findWCNodes: (
            globalGraph: TreeGraph,
            nodeSearchSet: ReadonlySet<VertexId>,
            relativeSet: ReadonlySet<VertexId>,
            excludeSet: ReadonlySet<VertexId>,
            k: number,
            algo: CoreSelectionAlgo,
        ) => VertexId[];
        generateSizeOfSteinerSet: (groupSize: number) => number;
    };
};

export type CompleteGraphResult = {
    graph: TreeGraph;
    steinerSet: Set<VertexId>;
};