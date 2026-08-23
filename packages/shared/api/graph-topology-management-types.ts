import type { GroupRef, GroupStateCausalRevision } from './group-types.ts';
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
    topologyKind?: GroupTopologyKindSetting | null;
    degreeLimit?: number | null;
    treeMinSize?: number | null;
    meshMinSize?: number | null;
    meshParamK?: number | null;
}>;

export type CanonicalGroupTopologyConfigField<T> =
    | Readonly<{ action: 'preserve'; }>
    | Readonly<{ action: 'set'; value: T; }>
    | Readonly<{ action: 'clear'; }>;

/**
 * Mandatory JSON representation used after a sparse topology request crosses a
 * durable queue boundary. Absence is represented explicitly by `preserve`.
 */
export type CanonicalGroupTopologyConfigPatch = Readonly<{
    topologyKind: CanonicalGroupTopologyConfigField<GroupTopologyKindSetting>;
    degreeLimit: CanonicalGroupTopologyConfigField<number>;
    treeMinSize: CanonicalGroupTopologyConfigField<number>;
    meshMinSize: CanonicalGroupTopologyConfigField<number>;
    meshParamK: CanonicalGroupTopologyConfigField<number>;
}>;

export type EffectiveGroupTopologyConfig = Readonly<{
    topologyKind: GroupTopologyKindSetting;
    degreeLimit: number;
    treeMinSize: number;
    meshMinSize: number;
    meshParamK: number;
}>;

export type StoredGroupTopologyConfig = Readonly<{
    groupRef: GroupRef;
    config: EffectiveGroupTopologyConfig;
    version: number;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    updatedByPrincipalId: string;
    requestId: string | null;
}>;

export type StoredGroupTopologyOverride =
    & StoredGroupTopologyConfig
    & Readonly<{
        expiresAtEpochMs: number;
    }>;

export type GroupTopologyConfigMutationOperation =
    | 'putConfig'
    | 'deleteConfig'
    | 'putOverride'
    | 'deleteOverride';

export type GroupTopologyConfigAcceptedCausalRevision = Readonly<{
    causalRevision: GroupStateCausalRevision;
    snapshotVersion: number;
    metadataVersion: number;
    rosterVersion: number;
    presenceVersion: number;
}>;

export type GroupTopologyConfigMutationReceipt = Readonly<{
    commandId: string;
    requestId: string | null;
    commandHash: string;
    operation: GroupTopologyConfigMutationOperation;
    outcome: 'applied' | 'no-op';
    attemptCount: number;
    groupRef: GroupRef;
    target: 'config' | 'override';
    acceptedVersion: number;
    acceptedStorageRevision: number | null;
    acceptedCreatedAtEpochMs: number | null;
    acceptedUpdatedAtEpochMs: number | null;
    acceptedExpiresAtEpochMs: number | null;
    acceptedConfig: EffectiveGroupTopologyConfig | null;
    acceptedCausalRevision: GroupTopologyConfigAcceptedCausalRevision | null;
    eventId: null;
    outboxIds: readonly string[];
}>;

export type GroupTopologyConfigView = Readonly<{
    serverDefaults: EffectiveGroupTopologyConfig;
    durable: StoredGroupTopologyConfig | null;
    temporary: StoredGroupTopologyOverride | null;
    requestOptions: GroupTopologyConfigPatch | null;
    effective: EffectiveGroupTopologyConfig;
}>;

export type GroupTopologyManagementView = Readonly<{
    groupRef: GroupRef;
    overlayId: string;
    snapshot: RallarOverlayTopologySnapshot | null;
    config: GroupTopologyConfigView;
    pending:
        | Readonly<{
            reconfigureQueued: boolean;
            dueAtEpochMs: number | null;
        }>
        | null;
}>;

export type PutGroupTopologyConfigRequest = Readonly<{
    requestId: string;
    config: GroupTopologyConfigPatch;
}>;

export type PutGroupTopologyOverrideRequest = Readonly<{
    requestId: string;
    config: GroupTopologyConfigPatch;
    ttlMs?: number;
    expiresAtEpochMs?: number;
}>;

export type ReconfigureGroupTopologyRequest = Readonly<{
    requestId: string;
    options?: GroupTopologyConfigPatch;
    publish?: boolean;
}>;

export type ReconfigureGroupTopologyResponse = Readonly<{
    groupRef: GroupRef;
    overlayId: string;
    changed: boolean;
    snapshot: RallarOverlayTopologySnapshot;
    previous: RallarOverlayTopologySnapshot | null;
    config: GroupTopologyConfigView;
    published: boolean;
}>;

export type QueuedGroupTopologyReconfigureResponse = Readonly<{
    status: 'queued';
    groupRef: GroupRef;
    requestId: string;
    outboxId: string;
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
