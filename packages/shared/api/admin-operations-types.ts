import type { ALReceiptMode } from '../al-contracts/al-policy.ts';
import type { ALDeliverySettlement } from '../alm/delivery/al-delivery-lifecycle.ts';
import type { RallarGroupFormationMetrics } from '../rtc/group-formation-metrics.ts';
import type { RtcTopologyAdminMetrics } from '../rtc/rtc-topology-admin-metrics.ts';
import type { GroupTopologyConfigPatch } from './graph-topology-management-types.ts';
import type { GroupRef } from './group-types.ts';
import type { StateScope } from './state-types.ts';

export const ADMIN_METRICS_RESET_CATEGORIES = ['rtc-topology', 'group-formation'] as const;

export const ADMIN_PRUNE_EXPIRED_CATEGORIES = [
    'runtime-state',
    'resource-inbox',
    'resource-inbox-results',
    'app-data'
] as const;

export type AdminMetricsResetCategory = (typeof ADMIN_METRICS_RESET_CATEGORIES)[number];

export type AdminPruneExpiredCategory = (typeof ADMIN_PRUNE_EXPIRED_CATEGORIES)[number];

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

export type AdminOperationsOverviewResponse =
    & AdminOperationBaseResponse
    & Readonly<{
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
            topologyMetrics: RtcTopologyAdminMetrics;
            groupFormationMetrics?: RallarGroupFormationMetrics;
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

export type AdminOperationsQueuesResponse =
    & AdminOperationBaseResponse
    & Readonly<{
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

/** One message's receipt as the WS server's own outbound owner settled it (D61). */
export interface AdminOperationsAlmReceiptEntry {
    readonly msgId: string;
    /** Under `receiver` the peers are sessions of the frozen audience; under `hop` and `subtree`, next hops. */
    readonly mode: ALReceiptMode;
    readonly confirmedPeerIds: readonly string[];
    readonly unconfirmedPeerIds: readonly string[];
    readonly lastSettlementKind: ALDeliverySettlement['kind'];
    readonly receiptExhausted: boolean;
    readonly updatedAtEpochMs: number;
}

export interface AdminOperationsAlmReceiptDiagnostics {
    readonly capacity: number;
    /** The least recently updated first. */
    readonly messages: readonly AdminOperationsAlmReceiptEntry[];
}

/** Entries this process's in-memory caches hold, counted when read. */
export interface AdminOperationsCacheSizes {
    /**
     * Groups whose current snapshot the group audience cache keeps, each absent group's null among them; that cache
     * holds the process's only version-probed read-through cache today.
     */
    readonly groupAudienceSnapshots: number;
}

export type AdminOperationsRealtimeResponse =
    & AdminOperationBaseResponse
    & Readonly<{
        websocket: Readonly<{
            connectionCount: number;
            openConnectionCount: number;
            connectionIds: readonly string[];
            openConnectionIds: readonly string[];
        }>;
        rtcTopology: Readonly<{
            metrics: RtcTopologyAdminMetrics;
            processLocal: boolean;
        }>;
        groupFormation: Readonly<{
            metrics?: RallarGroupFormationMetrics;
            processLocal: boolean;
        }>;
        almReceipts: Readonly<{
            diagnostics: AdminOperationsAlmReceiptDiagnostics;
            processLocal: boolean;
        }>;
        caches: AdminOperationsCacheSizes & Readonly<{ processLocal: boolean; }>;
        /**
         * `deliveredMarkers`: the unexpired delivered markers the WS server's shared inbound store holds, read from the
         * store when asked; uncapped, each marker leaves at its expiry.
         */
        alm: Readonly<{ deliveredMarkers: number; processLocal: boolean; }>;
    }>;

export type AdminOperationsStateResponse =
    & AdminOperationBaseResponse
    & Readonly<{
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

export type AdminOperationsCrdtResponse =
    & AdminOperationBaseResponse
    & Readonly<{
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

export type AdminOperationsSystemResponse =
    & AdminOperationBaseResponse
    & Readonly<{
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
    groupRef: GroupRef;
    publish?: boolean;
    options?: GroupTopologyConfigPatch;
    reason?: string;
}>;

export type AdminPruneExpiredRequest = Readonly<{
    categories?: readonly AdminPruneExpiredCategory[];
    appData?: Readonly<{
        namespace?: string;
        storeName?: string;
    }>;
    dryRun?: boolean;
    reason?: string;
}>;

export interface AdminMetricsResetSnapshot {
    readonly rtcTopology?: RtcTopologyAdminMetrics;
    readonly groupFormation?: RallarGroupFormationMetrics;
}

/** `before` and `after` carry exactly the categories the request reset. */
export interface AdminMetricsResetResultResponse extends AdminOperationBaseResponse {
    readonly operation: 'metrics.reset';
    readonly status: 'completed';
    readonly changed: boolean;
    readonly before: AdminMetricsResetSnapshot;
    readonly after: AdminMetricsResetSnapshot;
}

export type AdminPruneExpiredCategoryResult = Readonly<{
    category: AdminPruneExpiredCategory;
    expiredRows: number;
    deletedRows: number;
    dryRun: boolean;
}>;

export interface AdminPruneExpiredResultResponse extends AdminOperationBaseResponse {
    readonly serverId: string;
    readonly operation: 'maintenance.prune-expired';
    readonly status: 'dry-run' | 'queued' | 'completed';
    readonly changed: boolean;
    readonly jobId: string;
    readonly results: readonly AdminPruneExpiredCategoryResult[];
}

export type AdminOperationResultResponse = AdminMetricsResetResultResponse | AdminPruneExpiredResultResponse;
