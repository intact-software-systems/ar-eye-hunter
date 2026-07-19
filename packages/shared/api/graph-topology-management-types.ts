import type { GroupRef } from './group-types.ts';
import type { RallarOverlayTopologySnapshot } from './overlay-topology.ts';

export type SerializedWeightedGraphNode = Readonly<{
    key: string;
    attributes?: unknown;
}>;

export type SerializedWeightedGraphEdge = Readonly<{
    key?: string;
    source: string;
    target: string;
    attributes?: unknown;
    undirected?: boolean;
}>;

export type SerializedWeightedGraph = Readonly<{
    attributes?: unknown;
    options?: unknown;
    nodes: readonly SerializedWeightedGraphNode[];
    edges: readonly SerializedWeightedGraphEdge[];
}>;

export type SerializedGraphInfo = Readonly<{
    groupRef: GroupRef;
    graph: SerializedWeightedGraph;
    groupGraph: SerializedWeightedGraph;
    coreNodes: readonly string[];
}>;

export type SerializedGraphInfoSnapshot = Readonly<{
    groupRef: GroupRef;
    measured?: SerializedGraphInfo;
    predicted: SerializedGraphInfo;
    createdAtEpochMs: number;
    version: number;
}>;

export type GraphDiagnosticRefreshMode = 'never' | 'if-missing' | 'always';

export type GraphDiagnosticReadOptions = Readonly<{
    includeMeasured?: boolean;
    refresh?: GraphDiagnosticRefreshMode;
}>;

export type GraphDiagnosticReadResponse = Readonly<{
    groupRef: GroupRef;
    snapshot: SerializedGraphInfoSnapshot;
    cache: Readonly<{
        hit: boolean;
        refreshed: boolean;
    }>;
}>;

export type GroupTopologyKindSetting = 'auto' | 'star' | 'tree' | 'mesh';

export type GroupTopologyConfigPatch = Readonly<{
    topologyKind?: GroupTopologyKindSetting;
    degreeLimit?: number;
    treeMinSize?: number;
    meshMinSize?: number;
    meshParamK?: number;
}>;

export type EffectiveGroupTopologyConfig = Required<GroupTopologyConfigPatch>;

export type StoredGroupTopologyConfig = Readonly<{
    groupRef: GroupRef;
    config: GroupTopologyConfigPatch;
    version: number;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    updatedByPrincipalId: string;
    requestId: string | null;
}>;

export type StoredGroupTopologyOverride = StoredGroupTopologyConfig & Readonly<{
    expiresAtEpochMs: number;
}>;

export type GroupTopologyConfigMutationOperation =
    | 'putConfig'
    | 'deleteConfig'
    | 'putOverride'
    | 'deleteOverride';

export type GroupTopologyConfigMutationReceipt = Readonly<{
    commandId: string;
    commandHash: string;
    operation: GroupTopologyConfigMutationOperation;
    outcome: 'applied' | 'no-op';
    groupRef: GroupRef;
    target: 'config' | 'override';
    acceptedVersion: number;
    acceptedStorageRevision: number | null;
    acceptedCreatedAtEpochMs: number | null;
    acceptedUpdatedAtEpochMs: number | null;
    acceptedExpiresAtEpochMs: number | null;
    outboxId: string | null;
}>;

export type GroupTopologyConfigView = Readonly<{
    serverDefaults: EffectiveGroupTopologyConfig;
    durable?: StoredGroupTopologyConfig;
    temporary?: StoredGroupTopologyOverride;
    requestOptions?: GroupTopologyConfigPatch;
    effective: EffectiveGroupTopologyConfig;
}>;

export type GroupTopologyManagementView = Readonly<{
    groupRef: GroupRef;
    overlayId: string;
    snapshot?: RallarOverlayTopologySnapshot;
    config: GroupTopologyConfigView;
    pending?: Readonly<{
        reconfigureQueued: boolean;
        dueAtEpochMs?: number;
    }>;
}>;

export type PutGroupTopologyConfigRequest = Readonly<{
    requestId?: string;
    config: GroupTopologyConfigPatch;
}>;

export type PutGroupTopologyOverrideRequest = Readonly<{
    requestId?: string;
    config: GroupTopologyConfigPatch;
    ttlMs?: number;
    expiresAtEpochMs?: number;
}>;

export type ReconfigureGroupTopologyRequest = Readonly<{
    requestId?: string;
    options?: GroupTopologyConfigPatch;
    publish?: boolean;
}>;

export type ReconfigureGroupTopologyResponse = Readonly<{
    groupRef: GroupRef;
    overlayId: string;
    changed: boolean;
    snapshot: RallarOverlayTopologySnapshot;
    previous?: RallarOverlayTopologySnapshot;
    config: GroupTopologyConfigView;
    published: boolean;
}>;

export type GroupTopologyValidationIssue = Readonly<{
    code: string;
    path?: readonly (string | number)[];
    message: string;
    details?: Record<string, unknown>;
}>;

export type GroupTopologyValidationErrorResponse = Readonly<{
    error: string;
    code: 'group-topology-validation-failed';
    issues: readonly GroupTopologyValidationIssue[];
}>;
