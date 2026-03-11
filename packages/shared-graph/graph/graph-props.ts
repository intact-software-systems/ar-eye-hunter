import { UndirectedGraph } from 'graphology';

export enum VertexType {
    CLIENT = 'CLIENT',
    CORE = 'CORE',
}

export enum VertexState {
    MEMBER = 'MEMBER',
    STEINER = 'STEINER',
}

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
