import * as api from '@shared-web/browser/api-integration.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';

export interface BrowserRallarStatsControllerInput {
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    requireSession(): AuthSession;
    runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
}

export interface RallarStatsOperations {
    summary(options?: RallarScopedOperationOptions): Promise<WorkspaceSpaStatisticsResponse>;
    group(
        group: string | GroupRef,
        options?: RallarScopedOperationOptions
    ): Promise<GroupSpaStatisticsResponse>;
    meRealtime(options?: RallarScopedOperationOptions): Promise<MyRealtimeSpaStatisticsResponse>;
}

export interface RallarStatsController {
    readonly operations: RallarStatsOperations;
}

interface RallarStatsGroupTarget {
    readonly groupId: string;
    readonly scope: StateScope;
}

export class BrowserRallarStatsController implements RallarStatsController {
    private readonly options: BrowserRallarStatsControllerInput;

    public readonly operations: RallarStatsOperations = {
        summary: async (options) => await this.summary(options),
        group: async (group, options) => await this.group(group, options),
        meRealtime: async (options) => await this.meRealtime(options)
    };

    public constructor(options: BrowserRallarStatsControllerInput) {
        this.options = options;
    }

    private async summary(
        readOptions: RallarScopedOperationOptions = {}
    ): Promise<WorkspaceSpaStatisticsResponse> {
        const operationOptions = this.options.resolveOperationOptions(readOptions);
        const session = this.options.requireSession();
        const scope = this.options.resolveOperationScope(readOptions.scope) ??
            api.defaultStateScope();
        return await this.options.runAuthAwareOperation(
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
    }

    private async group(
        group: string | GroupRef,
        readOptions: RallarScopedOperationOptions = {}
    ): Promise<GroupSpaStatisticsResponse> {
        const operationOptions = this.options.resolveOperationOptions(readOptions);
        const session = this.options.requireSession();
        const target = this.toGroupTarget(group, readOptions.scope);
        return await this.options.runAuthAwareOperation(
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
    }

    private async meRealtime(
        readOptions: RallarScopedOperationOptions = {}
    ): Promise<MyRealtimeSpaStatisticsResponse> {
        const operationOptions = this.options.resolveOperationOptions(readOptions);
        const session = this.options.requireSession();
        const scope = this.options.resolveOperationScope(readOptions.scope) ??
            api.defaultStateScope();
        return await this.options.runAuthAwareOperation(
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

    private toGroupTarget(
        group: string | GroupRef,
        scope?: StateScope
    ): RallarStatsGroupTarget {
        if (typeof group === 'string') {
            return {
                groupId: group,
                scope: this.options.resolveOperationScope(scope) ?? api.defaultStateScope()
            };
        }
        return {
            groupId: group.groupId,
            scope: {
                applicationId: group.applicationId,
                workspaceId: group.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID
            }
        };
    }
}

function runRallarCommand<T>(
    supplier: (signal?: AbortSignal) => T | Promise<T>,
    options: RallarOperationOptions
): Promise<T> {
    return new Command<T>(supplier, toRallarCommandOptions(options)).run();
}
