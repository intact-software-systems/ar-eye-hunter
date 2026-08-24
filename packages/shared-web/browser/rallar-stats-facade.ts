import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';

export type RallarStatsFacade = Readonly<{
    summary(
        options?: RallarScopedOperationOptions
    ): Promise<WorkspaceSpaStatisticsResponse>;
    group(
        group: string | GroupRef,
        options?: RallarScopedOperationOptions
    ): Promise<GroupSpaStatisticsResponse>;
    meRealtime(
        options?: RallarScopedOperationOptions
    ): Promise<MyRealtimeSpaStatisticsResponse>;
}>;

export function createRallarStatsFacade(
    operations: RallarStatsFacade
): RallarStatsFacade {
    return {
        summary: async (options) => await operations.summary(options),
        group: async (group, options) => await operations.group(group, options),
        meRealtime: async (options) => await operations.meRealtime(options)
    };
}
