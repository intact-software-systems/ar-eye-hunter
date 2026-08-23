import { GroupStatisticsService } from './group-statistics-service.ts';
import { RealtimeStatusService } from './realtime-status-service.ts';
import type { SpaStatisticsDependencies, SpaStatisticsUseCases } from './spa-statistics-contracts.ts';
import { WorkspaceStatisticsService } from './workspace-statistics-service.ts';

export function createSpaStatisticsUseCases(
    dependencies: SpaStatisticsDependencies
): SpaStatisticsUseCases {
    const workspace = new WorkspaceStatisticsService(dependencies);
    const group = new GroupStatisticsService(dependencies);
    const realtime = new RealtimeStatusService(dependencies);
    return {
        readWorkspaceSummary: (input) => workspace.readWorkspaceSummary(input),
        readGroupStats: (input) => group.readGroupStats(input),
        readMyRealtimeStatus: (input) => realtime.readMyRealtimeStatus(input)
    };
}
