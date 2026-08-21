import { TreeGraph, VertexId } from '../graph-props.ts';

export type ConnectContext = {
    globalGraph: TreeGraph;
    groupGraph: TreeGraph;
};

export type ConnectResult = {
    graph: TreeGraph;
    connectedVertices: Set<VertexId>;
    remainingVertices: Set<VertexId>;
};

export type EdgeCandidate = {
    from: VertexId;
    to: VertexId;
    weight: number;
};

export type DiameterCandidate = {
    from: VertexId;
    to: VertexId;
    diameter: number;
};
