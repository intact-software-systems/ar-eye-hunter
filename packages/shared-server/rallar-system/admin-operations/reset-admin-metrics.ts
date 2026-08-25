import {
    ADMIN_METRICS_RESET_CATEGORIES,
    type AdminMetricsResetCategory,
    type AdminMetricsResetRequest,
    type AdminOperationResultResponse
} from '@shared/api/admin-operations-types.ts';
import type { RallarGroupFormationMetrics } from '@shared/rtc/group-formation-metrics.ts';

import type { RallarTimingSink } from '../observability/timing.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import type { AdminOperationWriteRequest } from './admin-operation-request.ts';
import { createAdminOperationBaseResponse } from './admin-operation-response.ts';
import { runTimedAdminOperation } from './run-timed-admin-operation.ts';

interface AdminMetricOwner<TMetrics> {
    readonly read: () => TMetrics;
    readonly reset: () => void;
}

interface AdminMetricsSnapshot {
    rtcTopology?: JsonWireValue;
    groupFormation?: RallarGroupFormationMetrics;
}

export namespace ResetAdminMetrics {
    export interface Options {
        readonly nowEpochMs: () => number;
        readonly serverId?: string;
        readonly timing?: RallarTimingSink;
        readonly rtcTopology: AdminMetricOwner<object>;
        readonly groupFormation: AdminMetricOwner<RallarGroupFormationMetrics>;
    }
}

export class ResetAdminMetrics {
    private readonly options: ResetAdminMetrics.Options;

    constructor(options: ResetAdminMetrics.Options) {
        this.options = options;
    }

    async execute(
        input: AdminOperationWriteRequest<AdminMetricsResetRequest>
    ): Promise<AdminOperationResultResponse> {
        const categories = input.request.categories ?? ADMIN_METRICS_RESET_CATEGORIES;
        return await runTimedAdminOperation({
            timing: this.options.timing,
            event: {
                component: 'admin-operations',
                operation: 'metrics.reset',
                serviceId: this.options.serverId,
                requestId: input.request.requestId,
                principalId: input.adminSession.clientId,
                sessionId: input.adminSession.sessionId,
                details: {
                    adminClientId: input.adminSession.clientId,
                    reason: input.request.reason,
                    categories: categories.join(',')
                }
            },
            execute: () => Promise.resolve(this.reset(categories)),
            readResultDetails: (result) => ({
                changed: result.changed,
                operationStatus: result.status
            })
        });
    }

    private reset(
        categories: readonly AdminMetricsResetCategory[]
    ): AdminOperationResultResponse {
        const before: AdminMetricsSnapshot = {};
        const after: AdminMetricsSnapshot = {};

        for (const category of categories) {
            this.resetCategory(category, before, after);
        }

        return {
            ...createAdminOperationBaseResponse({
                nowEpochMs: this.options.nowEpochMs,
                serverId: this.options.serverId
            }),
            operation: 'metrics.reset',
            status: 'completed',
            changed: categories.length > 0,
            before,
            after
        };
    }

    private resetCategory(
        category: AdminMetricsResetCategory,
        before: AdminMetricsSnapshot,
        after: AdminMetricsSnapshot
    ): void {
        if (category === 'rtc-topology') {
            before.rtcTopology = decodeJsonWireValue(
                this.options.rtcTopology.read(),
                'RTC topology metrics before reset'
            );
            this.options.rtcTopology.reset();
            after.rtcTopology = decodeJsonWireValue(
                this.options.rtcTopology.read(),
                'RTC topology metrics after reset'
            );
            return;
        }

        before.groupFormation = this.options.groupFormation.read();
        this.options.groupFormation.reset();
        after.groupFormation = this.options.groupFormation.read();
    }
}
