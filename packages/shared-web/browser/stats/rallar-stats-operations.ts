import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';

export interface RallarStatsOperations {
    summary(options?: RallarScopedOperationOptions): Promise<WorkspaceSpaStatisticsResponse>;
    group(
        group: string | GroupRef,
        options?: RallarScopedOperationOptions
    ): Promise<GroupSpaStatisticsResponse>;
    meRealtime(options?: RallarScopedOperationOptions): Promise<MyRealtimeSpaStatisticsResponse>;
}
