import * as api from '@shared-web/browser/api-integration.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarStatsFacade } from '@shared-web/browser/rallar-stats-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';

export type CreateRallarStatsControllerOptions = Readonly<{
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    requireSession(): AuthSession;
    runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
}>;

export type RallarStatsController = Readonly<{
    operations: RallarStatsFacade;
}>;

export function createRallarStatsController(
    options: CreateRallarStatsControllerOptions
): RallarStatsController {
    const toGroupTarget = (
        group: string | GroupRef,
        scope?: StateScope
    ): Readonly<{ groupId: string; scope: StateScope; }> => {
        if (typeof group === 'string') {
            return {
                groupId: group,
                scope: options.resolveOperationScope(scope) ?? api.defaultStateScope()
            };
        }
        return {
            groupId: group.groupId,
            scope: {
                applicationId: group.applicationId,
                workspaceId: group.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID
            }
        };
    };

    const operations: RallarStatsFacade = {
        summary: async (readOptions: RallarScopedOperationOptions = {}) => {
            const operationOptions = options.resolveOperationOptions(readOptions);
            const session = options.requireSession();
            const scope = options.resolveOperationScope(readOptions.scope) ??
                api.defaultStateScope();
            return await options.runAuthAwareOperation(
                async () =>
                    await runRallarCommand(
                        async (signal) =>
                            await api.readStateWorkspaceStatsSummary(scope, {
                                authSession: session,
                                signal
                            }),
                        operationOptions
                    )
            );
        },
        group: async (
            group: string | GroupRef,
            readOptions: RallarScopedOperationOptions = {}
        ) => {
            const operationOptions = options.resolveOperationOptions(readOptions);
            const session = options.requireSession();
            const target = toGroupTarget(group, readOptions.scope);
            return await options.runAuthAwareOperation(
                async () =>
                    await runRallarCommand(
                        async (signal) =>
                            await api.readStateGroupStats(target.groupId, target.scope, {
                                authSession: session,
                                signal
                            }),
                        operationOptions
                    )
            );
        },
        meRealtime: async (readOptions: RallarScopedOperationOptions = {}) => {
            const operationOptions = options.resolveOperationOptions(readOptions);
            const session = options.requireSession();
            const scope = options.resolveOperationScope(readOptions.scope) ??
                api.defaultStateScope();
            return await options.runAuthAwareOperation(
                async () =>
                    await runRallarCommand(
                        async (signal) =>
                            await api.readStateMyRealtimeStatus(scope, {
                                authSession: session,
                                signal
                            }),
                        operationOptions
                    )
            );
        }
    };

    return { operations };
}

function runRallarCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}
