import type { GroupRef } from './group-types.ts';
import type { GroupTopologyConfigPatch } from './graph-topology-management-types.ts';
import type { StateScope } from './state-types.ts';

export const ADMIN_METRICS_RESET_CATEGORIES = ['rtc-topology', 'group-formation'] as const;

export const ADMIN_PRUNE_EXPIRED_CATEGORIES = [
    'runtime-state',
    'resource-inbox',
    'resource-inbox-results',
    'app-data',
] as const;

export const ADMIN_OPERATION_RESULT_STATUSES = [
    'completed',
    'dry-run',
    'skipped',
    'failed',
] as const;

export type AdminMetricsResetCategory =
    typeof ADMIN_METRICS_RESET_CATEGORIES[number];

export type AdminPruneExpiredCategory =
    typeof ADMIN_PRUNE_EXPIRED_CATEGORIES[number];

export type AdminOperationResultStatus =
    typeof ADMIN_OPERATION_RESULT_STATUSES[number];

export type AdminOperationWarning = Readonly<{
    code: string;
    message: string;
    source?: string;
}>;

export type AdminOperationBaseResponse = Readonly<{
    generatedAtEpochMs: number;
    serverId?: string;
    scope?: StateScope;
    warnings: readonly AdminOperationWarning[];
}>;

export type AdminCountByStatus = Readonly<{
    status: string;
    count: number;
}>;

export type AdminCountByTypeStatus = Readonly<{
    typeId: string;
    status: string;
    count: number;
}>;

export type AdminOperationsOverviewResponse = AdminOperationBaseResponse & Readonly<{
    health: Readonly<{
        status: 'ok' | 'warning' | 'degraded';
    }>;
    websocket?: Readonly<{
        connectionCount: number;
        openConnectionCount: number;
    }>;
    queues?: Readonly<{
        queuedRows: number;
        resultRows: number;
        expiredRows: number;
    }>;
    realtime?: Readonly<{
        topologyMetrics?: unknown;
        groupFormationMetrics?: unknown;
    }>;
    state?: Readonly<{
        activeSessions: number;
        activeGroups: number;
    }>;
    crdt?: Readonly<{
        documents: number;
        updates: number;
        snapshots: number;
        storedUpdateBytes: number;
    }>;
    system?: Readonly<{
        runtimeStateRows: number;
        appDataRows: number;
    }>;
}>;

export type AdminOperationsQueuesResponse = AdminOperationBaseResponse & Readonly<{
    queueRows: Readonly<{
        total: number;
        expired: number;
        byTypeStatus: readonly AdminCountByTypeStatus[];
        oldestQueuedAgeMs?: number;
        oldestReservedAgeMs?: number;
        topPressure: readonly AdminCountByTypeStatus[];
    }>;
    resultRows: Readonly<{
        total: number;
        expired: number;
        byTypeStatus: readonly AdminCountByTypeStatus[];
        topPressure: readonly AdminCountByTypeStatus[];
    }>;
}>;

export type AdminOperationsRealtimeResponse = AdminOperationBaseResponse & Readonly<{
    websocket: Readonly<{
        connectionCount: number;
        openConnectionCount: number;
        connectionIds: readonly string[];
        openConnectionIds: readonly string[];
    }>;
    rtcTopology: Readonly<{
        metrics?: unknown;
        processLocal: boolean;
    }>;
    groupFormation: Readonly<{
        metrics?: unknown;
        processLocal: boolean;
    }>;
}>;

export type AdminOperationsStateResponse = AdminOperationBaseResponse & Readonly<{
    clients: Readonly<{
        totalPrincipals: number;
        onlinePrincipals: number;
        activeSessions: number;
    }>;
    groups: Readonly<{
        activeGroups: number;
        totalActiveMembers: number;
        onlineMembers: number;
        byStatus?: readonly AdminCountByStatus[];
    }>;
    events: Readonly<{
        recentClientEvents: number;
        recentGroupEvents: number;
    }>;
}>;

export type AdminOperationsCrdtResponse = AdminOperationBaseResponse & Readonly<{
    documents: Readonly<{
        total: number;
        byLifecycle: readonly AdminCountByStatus[];
        byScopeType: readonly AdminCountByTypeStatus[];
    }>;
    storage: Readonly<{
        updates: number;
        snapshots: number;
        storedUpdateBytes: number;
    }>;
}>;

export type AdminOperationsSystemResponse = AdminOperationBaseResponse & Readonly<{
    runtimeState: Readonly<{
        rows: number;
        expiredRows: number;
        byNamespace: readonly AdminCountByStatus[];
    }>;
    appData: Readonly<{
        rows: number;
        expiredRows: number;
        byNamespaceStore: readonly AdminCountByTypeStatus[];
    }>;
    stateEvents: Readonly<{
        clientEvents: number;
        groupEvents: number;
    }>;
    configuration: Readonly<{
        sqlBackend?: string;
        dbPubSub?: string;
    }>;
}>;

export type AdminMetricsResetRequest = Readonly<{
    requestId?: string;
    categories?: readonly AdminMetricsResetCategory[];
    reason?: string;
}>;

export type AdminTopologyRecomputeRequest = Readonly<{
    requestId?: string;
    groupRef: GroupRef;
    publish?: boolean;
    options?: GroupTopologyConfigPatch;
    reason?: string;
}>;

export type AdminPruneExpiredRequest = Readonly<{
    requestId?: string;
    categories?: readonly AdminPruneExpiredCategory[];
    appData?: Readonly<{
        namespace?: string;
        storeName?: string;
    }>;
    dryRun?: boolean;
    reason?: string;
}>;

export type AdminOperationResultResponse = AdminOperationBaseResponse & Readonly<{
    operation: string;
    status: AdminOperationResultStatus;
    changed: boolean;
    before?: unknown;
    after?: unknown;
    results?: readonly unknown[];
}>;
