import { describe, expect, it } from 'vitest';
import {
    ADMIN_METRICS_RESET_CATEGORIES,
    ADMIN_OPERATION_RESULT_STATUSES,
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    type AdminPruneExpiredRequest,
    type AdminTopologyRecomputeRequest,
} from '@shared/api/admin-operations-types.ts';

describe('admin operations public API contracts', () => {
    it('exports stable category and status constants for REST clients', () => {
        expect(ADMIN_METRICS_RESET_CATEGORIES).toEqual(['rtc-topology', 'group-formation']);
        expect(ADMIN_PRUNE_EXPIRED_CATEGORIES).toEqual([
            'runtime-state',
            'resource-inbox',
            'resource-inbox-results',
            'app-data',
        ]);
        expect(ADMIN_OPERATION_RESULT_STATUSES).toEqual([
            'completed',
            'dry-run',
            'skipped',
            'failed',
        ]);
    });

    it('keeps request DTOs compatible with app-data pruning and topology recompute', () => {
        const prune: AdminPruneExpiredRequest = {
            categories: ['app-data'],
            appData: {
                namespace: 'rallar-tests',
                storeName: 'snapshots',
            },
            dryRun: true,
        };
        const recompute: AdminTopologyRecomputeRequest = {
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            publish: false,
            options: {
                topologyKind: 'tree',
            },
        };

        expect(prune.appData?.namespace).toBe('rallar-tests');
        expect(recompute.groupRef.groupId).toBe('room-1');
    });
});
