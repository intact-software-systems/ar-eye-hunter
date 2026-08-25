import type { AdminOperationsRealtimeResponse } from '@shared/api/admin-operations-types.ts';
import type { RallarGroupFormationMetrics } from '@shared/rtc/group-formation-metrics.ts';

import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import type { RallarServerWsStatus } from '../websocket/router/rallar-server-ws-status.ts';
import type { AdminOperationReadRequest } from './admin-operation-request.ts';
import { createAdminOperationBaseResponse } from './admin-operation-response.ts';

export namespace ReadAdminRealtime {
    export interface Options {
        readonly nowEpochMs: () => number;
        readonly serverId?: string;
        readonly readWebSocketStatus: () => RallarServerWsStatus;
        readonly readRtcTopologyMetrics: () => object;
        readonly readGroupFormationMetrics: () => RallarGroupFormationMetrics;
    }
}

export class ReadAdminRealtime {
    private readonly options: ReadAdminRealtime.Options;

    constructor(options: ReadAdminRealtime.Options) {
        this.options = options;
    }

    execute(input: AdminOperationReadRequest): Promise<AdminOperationsRealtimeResponse> {
        const status = this.options.readWebSocketStatus();
        return Promise.resolve({
            ...createAdminOperationBaseResponse({
                nowEpochMs: this.options.nowEpochMs,
                serverId: this.options.serverId,
                scope: input.scope,
                warnings: [
                    {
                        code: 'process-local-realtime',
                        message: 'Realtime metrics are process-local in multi-server deployments.',
                        source: 'ws'
                    }
                ]
            }),
            websocket: {
                connectionCount: status.connectionCount,
                openConnectionCount: status.openConnectionCount,
                connectionIds: status.connectionIds.slice(0, 50),
                openConnectionIds: status.openConnectionIds.slice(0, 50)
            },
            rtcTopology: {
                metrics: decodeJsonWireValue(
                    this.options.readRtcTopologyMetrics(),
                    'RTC topology metrics'
                ),
                processLocal: true
            },
            groupFormation: {
                metrics: this.options.readGroupFormationMetrics(),
                processLocal: true
            }
        });
    }
}
