import type { WeightedGraph } from '@shared-graph/graph/graph-props.ts';

export type ApplicationId = string;
export type WorkspaceId = string;
export type GroupId = string;
export type OverlayId = string;
export type GraphId = string;

export type GraphSubject = Readonly<{
    applicationId: ApplicationId;
    workspaceId?: WorkspaceId;
    graphId: GraphId;
    groupId?: GroupId;
    overlayId?: OverlayId;
}>;

export type GraphSourceVersions = Readonly<{
    groupVersion?: number;
    clientPresenceVersion?: number;
    overlayRoutingVersion?: number;
    rttVersion?: number;
}>;

export type GraphData = Readonly<{
    baseGraph: WeightedGraph;
    topologyGraph: WeightedGraph;
    coreNodeIds: readonly string[];
}>;

export type GraphSnapshot =
    & GraphSubject
    & Readonly<{
    version: number;
    computedAtEpochMs: number;
    sourceVersions?: GraphSourceVersions;
    predicted: GraphData;
    measured?: GraphData;
}>;
