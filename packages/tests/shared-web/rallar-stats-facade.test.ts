import { createRallarStatsFacade } from '@shared-web/browser/rallar-stats-facade.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { GroupSpaStatisticsResponse, MyRealtimeSpaStatisticsResponse, WorkspaceSpaStatisticsResponse } from '@shared/api/spa-statistics-types.ts';
import { describe, expect, it, vi } from 'vitest';

describe('createRallarStatsFacade', () => {
    it('forwards summary, group, and me realtime reads through narrow operations', async () => {
        const workspaceStats = { generatedAtEpochMs: 1 } as WorkspaceSpaStatisticsResponse;
        const groupStats = { generatedAtEpochMs: 2 } as GroupSpaStatisticsResponse;
        const realtimeStats = { generatedAtEpochMs: 3 } as MyRealtimeSpaStatisticsResponse;
        const operations = {
            summary: vi.fn(async () => workspaceStats),
            group: vi.fn(async () => groupStats),
            meRealtime: vi.fn(async () => realtimeStats)
        };
        const facade = createRallarStatsFacade(operations);
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };

        await expect(facade.summary({ scope: { applicationId: 'app-1', workspaceId: 'workspace-1' } }))
            .resolves.toBe(workspaceStats);
        await expect(facade.group(groupRef, { timeoutMs: 100 }))
            .resolves.toBe(groupStats);
        await expect(facade.meRealtime()).resolves.toBe(realtimeStats);

        expect(operations.summary).toHaveBeenCalledWith({
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
        });
        expect(operations.group).toHaveBeenCalledWith(groupRef, { timeoutMs: 100 });
        expect(operations.meRealtime).toHaveBeenCalledWith(undefined);
    });
});
