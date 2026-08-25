import type {
    AdminOperationsCrdtResponse,
    AdminOperationsOverviewResponse,
    AdminOperationsQueuesResponse,
    AdminOperationsRealtimeResponse,
    AdminOperationsStateResponse,
    AdminOperationsSystemResponse
} from '@shared/api/admin-operations-types.ts';

import type { AdminOperationReadRequest } from './admin-operation-request.ts';
import { createAdminOperationBaseResponse } from './admin-operation-response.ts';

type AdminReadUseCase<TResponse> = (
    input: AdminOperationReadRequest
) => Promise<TResponse>;

export namespace ReadAdminOverview {
    export interface Options {
        readonly nowEpochMs: () => number;
        readonly serverId?: string;
        readonly readQueues: AdminReadUseCase<AdminOperationsQueuesResponse>;
        readonly readState: AdminReadUseCase<AdminOperationsStateResponse>;
        readonly readCrdt: AdminReadUseCase<AdminOperationsCrdtResponse>;
        readonly readSystem: AdminReadUseCase<AdminOperationsSystemResponse>;
        readonly readRealtime: AdminReadUseCase<AdminOperationsRealtimeResponse>;
    }
}

export class ReadAdminOverview {
    private readonly options: ReadAdminOverview.Options;

    constructor(options: ReadAdminOverview.Options) {
        this.options = options;
    }

    async execute(
        input: AdminOperationReadRequest
    ): Promise<AdminOperationsOverviewResponse> {
        const [queues, state, crdt, system, realtime] = await Promise.all([
            this.options.readQueues(input),
            this.options.readState(input),
            this.options.readCrdt(input),
            this.options.readSystem(input),
            this.options.readRealtime(input)
        ]);
        const warnings = [
            ...queues.warnings,
            ...state.warnings,
            ...crdt.warnings,
            ...system.warnings,
            ...realtime.warnings
        ];

        return {
            ...createAdminOperationBaseResponse({
                nowEpochMs: this.options.nowEpochMs,
                serverId: this.options.serverId,
                scope: input.scope,
                warnings
            }),
            health: {
                status: warnings.some((warning) => warning.code !== 'process-local-realtime')
                    ? 'warning'
                    : 'ok'
            },
            websocket: {
                connectionCount: realtime.websocket.connectionCount,
                openConnectionCount: realtime.websocket.openConnectionCount
            },
            queues: {
                queuedRows: queues.queueRows.total,
                resultRows: queues.resultRows.total,
                expiredRows: queues.queueRows.expired + queues.resultRows.expired
            },
            realtime: {
                topologyMetrics: realtime.rtcTopology.metrics,
                groupFormationMetrics: realtime.groupFormation.metrics
            },
            state: {
                activeSessions: state.clients.activeSessions,
                activeGroups: state.groups.activeGroups
            },
            crdt: {
                documents: crdt.documents.total,
                updates: crdt.storage.updates,
                snapshots: crdt.storage.snapshots,
                storedUpdateBytes: crdt.storage.storedUpdateBytes
            },
            system: {
                runtimeStateRows: system.runtimeState.rows,
                appDataRows: system.appData.rows
            }
        };
    }
}
