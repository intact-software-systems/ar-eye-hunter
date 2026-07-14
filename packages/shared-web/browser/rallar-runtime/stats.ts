import * as api from '@shared-web/browser/api-integration.ts';
import {
    type RallarOperationOptions,
    toRallarCommandOptions,
} from '@shared-web/browser/rallar-operation-options.ts';
import type {
    CreateRallarStatsFacadeOptions,
    RallarStatsGroupInput,
    RallarStatsReadOptions,
} from '@shared-web/browser/rallar-stats-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    DEFAULT_STATE_WORKSPACE_ID,
    type StateScope,
} from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';

export type CreateRallarStatsControllerOptions = Readonly<{
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T,
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    requireSession(): AuthSession;
    runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
}>;

export type RallarStatsController = Readonly<{
    operations: CreateRallarStatsFacadeOptions;
}>;

export function createRallarStatsController(
    options: CreateRallarStatsControllerOptions,
): RallarStatsController {
    const toGroupTarget = (
        group: RallarStatsGroupInput,
        scope?: StateScope,
    ): Readonly<{ groupId: string; scope: StateScope }> => {
        if (typeof group === 'string') {
            return {
                groupId: group,
                scope: options.resolveOperationScope(scope) ??
                    api.defaultStateScope(),
            };
        }
        return {
            groupId: group.groupId,
            scope: {
                applicationId: group.applicationId,
                workspaceId: group.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
            },
        };
    };

    const operations: CreateRallarStatsFacadeOptions = {
        summary: async (readOptions: RallarStatsReadOptions = {}) => {
            const operationOptions = options.resolveOperationOptions(readOptions);
            const session = options.requireSession();
            const scope = options.resolveOperationScope(readOptions.scope) ??
                api.defaultStateScope();
            return await options.runAuthAwareOperation(async () =>
                await runRallarCommand(
                    async (signal) =>
                        await api.readStateWorkspaceStatsSummary(scope, {
                            authSession: session,
                            signal,
                        }),
                    operationOptions,
                )
            );
        },
        group: async (
            group: RallarStatsGroupInput,
            readOptions: RallarStatsReadOptions = {},
        ) => {
            const operationOptions = options.resolveOperationOptions(readOptions);
            const session = options.requireSession();
            const target = toGroupTarget(group, readOptions.scope);
            return await options.runAuthAwareOperation(async () =>
                await runRallarCommand(
                    async (signal) => await api.readStateGroupStats(
                        target.groupId,
                        target.scope,
                        { authSession: session, signal },
                    ),
                    operationOptions,
                )
            );
        },
        meRealtime: async (readOptions: RallarStatsReadOptions = {}) => {
            const operationOptions = options.resolveOperationOptions(readOptions);
            const session = options.requireSession();
            const scope = options.resolveOperationScope(readOptions.scope) ??
                api.defaultStateScope();
            return await options.runAuthAwareOperation(async () =>
                await runRallarCommand(
                    async (signal) => await api.readStateMyRealtimeStatus(
                        scope,
                        { authSession: session, signal },
                    ),
                    operationOptions,
                )
            );
        },
    };

    return { operations };
}

function runRallarCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions,
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}
