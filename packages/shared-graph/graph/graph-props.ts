import type { UndirectedGraph } from 'graphology';

export const VertexType = {
    CLIENT: 'CLIENT',
    CORE: 'CORE',
} as const;

export type VertexType = (typeof VertexType)[keyof typeof VertexType];

export const VertexState = {
    MEMBER: 'MEMBER',
    STEINER: 'STEINER',
} as const;

export type VertexState = (typeof VertexState)[keyof typeof VertexState];

export interface GraphProp {
    id: string;
    version: number;
    degreeLimitMember: number;
    degreeLimitSteiner: number;
}

export interface VertexProp {
    id: string;
    type: VertexType;
    state: VertexState;
    degreeLimit: number;
}

export interface EdgeProp {
    from: string;
    to: string;
    weight: number;
}

export type VertexId = string;
export type VertexArray = VertexId[];
export type VertexSet = ReadonlySet<VertexId>;

export type TreeGraph = UndirectedGraph<VertexProp, EdgeProp, GraphProp>;
export type WeightedGraph = UndirectedGraph<VertexProp, EdgeProp, GraphProp>;
export type MeshGraph = UndirectedGraph<VertexProp, EdgeProp, GraphProp>;
