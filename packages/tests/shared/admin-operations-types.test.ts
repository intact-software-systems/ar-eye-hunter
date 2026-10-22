import {
    ADMIN_METRICS_RESET_CATEGORIES,
    ADMIN_OPERATION_RESULT_STATUSES,
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    type AdminOperationResultResponse,
    type AdminPruneExpiredRequest,
    type AdminTopologyRecomputeRequest
} from '@shared/api/admin-operations-types.ts';
import { describe, expect, it } from 'vitest';

describe('admin operations public API contracts', () => {
    it('exports stable category and status constants for REST clients', () => {
        expect(ADMIN_METRICS_RESET_CATEGORIES).toEqual(['rtc-topology', 'group-formation']);
        expect(ADMIN_PRUNE_EXPIRED_CATEGORIES).toEqual([
            'runtime-state',
            'resource-inbox',
            'resource-inbox-results',
            'app-data'
        ]);
        expect(ADMIN_OPERATION_RESULT_STATUSES).toEqual([
            'completed',
            'dry-run',
            'skipped',
            'failed'
        ]);
    });

    it('keeps request DTOs compatible with app-data pruning and topology recompute', () => {
        const prune: AdminPruneExpiredRequest = {
            categories: ['app-data'],
            appData: {
                namespace: 'rallar-tests',
                storeName: 'snapshots'
            },
            dryRun: true
        };
        const recompute: AdminTopologyRecomputeRequest = {
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            publish: false,
            options: {
                topologyKind: 'tree'
            }
        };

        expect(prune.appData?.namespace).toBe('rallar-tests');
        expect(recompute.groupRef.groupId).toBe('room-1');
    });

    it('narrows an operation result to its own before, after, and results by operation', () => {
        const pruneResult: AdminOperationResultResponse = {
            generatedAtEpochMs: 1,
            serverId: 'server-1',
            warnings: [],
            operation: 'maintenance.prune-expired',
            status: 'completed',
            changed: true,
            jobId: 'job-1',
            results: [{ category: 'runtime-state', expiredRows: 3, deletedRows: 3, dryRun: false }]
        };
        const resetResult: AdminOperationResultResponse = {
            generatedAtEpochMs: 1,
            warnings: [],
            operation: 'metrics.reset',
            status: 'completed',
            changed: false,
            before: {},
            after: {}
        };

        expect(readDeletedRows(pruneResult)).toBe(3);
        expect(readDeletedRows(resetResult)).toBe(0);
    });
});

function readDeletedRows(result: AdminOperationResultResponse): number {
    return result.operation === 'maintenance.prune-expired'
        ? result.results.reduce((total, categoryResult) => total + categoryResult.deletedRows, 0)
        : 0;
}
