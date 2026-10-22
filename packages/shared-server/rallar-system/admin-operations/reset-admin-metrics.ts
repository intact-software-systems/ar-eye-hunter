import {
    ADMIN_METRICS_RESET_CATEGORIES,
    type AdminMetricsResetCategory,
    type AdminMetricsResetRequest,
    type AdminMetricsResetResultResponse,
    type AdminMetricsResetSnapshot
} from '@shared/api/admin-operations-types.ts';
import type { RallarGroupFormationMetrics } from '@shared/rtc/group-formation-metrics.ts';
import type { RtcTopologyAdminMetrics } from '@shared/rtc/rtc-topology-admin-metrics.ts';

import type { RallarTimingSink } from '../observability/timing.ts';
import type { AdminOperationWriteRequest } from './admin-operation-request.ts';
import { createAdminOperationBaseResponse } from './admin-operation-response.ts';
import { runTimedAdminOperation } from './run-timed-admin-operation.ts';

interface AdminMetricOwner<TMetrics> {
    readonly read: () => TMetrics;
    readonly reset: () => void;
}

export namespace ResetAdminMetrics {
    export interface Options {
        readonly nowEpochMs: () => number;
        readonly serverId?: string;
        readonly timing?: RallarTimingSink;
        readonly rtcTopology: AdminMetricOwner<RtcTopologyAdminMetrics>;
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
    ): Promise<AdminMetricsResetResultResponse> {
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
    ): AdminMetricsResetResultResponse {
        const before = this.readCategories(categories);
        for (const category of categories) {
            this.resetCategory(category);
        }
        const after = this.readCategories(categories);

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

    private readCategories(categories: readonly AdminMetricsResetCategory[]): AdminMetricsResetSnapshot {
        const snapshot: { rtcTopology?: RtcTopologyAdminMetrics; groupFormation?: RallarGroupFormationMetrics; } = {};
        if (categories.includes('rtc-topology')) {
            snapshot.rtcTopology = this.options.rtcTopology.read();
        }
        if (categories.includes('group-formation')) {
            snapshot.groupFormation = this.options.groupFormation.read();
        }
        return snapshot;
    }

    private resetCategory(category: AdminMetricsResetCategory): void {
        if (category === 'rtc-topology') {
            this.options.rtcTopology.reset();
            return;
        }
        this.options.groupFormation.reset();
    }
}
