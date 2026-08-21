import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';

export type RallarStatsReadOptions = RallarScopedOperationOptions;

export type RallarStatsGroupInput = string | GroupRef;

export type RallarStatsFacade = Readonly<{
    summary(options?: RallarStatsReadOptions): Promise<WorkspaceSpaStatisticsResponse>;
    group(
        group: RallarStatsGroupInput,
        options?: RallarStatsReadOptions
    ): Promise<GroupSpaStatisticsResponse>;
    meRealtime(options?: RallarStatsReadOptions): Promise<MyRealtimeSpaStatisticsResponse>;
}>;

export type CreateRallarStatsFacadeOptions = RallarStatsFacade;

export function createRallarStatsFacade(
    operations: CreateRallarStatsFacadeOptions
): RallarStatsFacade {
    return {
        summary: async (options) => await operations.summary(options),
        group: async (group, options) => await operations.group(group, options),
        meRealtime: async (options) => await operations.meRealtime(options)
    };
}
