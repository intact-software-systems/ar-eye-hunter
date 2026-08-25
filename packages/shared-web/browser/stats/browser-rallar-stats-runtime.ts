import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarStatsOperations } from '@shared-web/browser/stats/rallar-stats-operations.ts';
import {
    readStateGroupStats,
    readStateMyRealtimeStatus,
    readStateWorkspaceStatsSummary
} from '@shared-web/browser/stats/rallar-stats-http-api.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';

export namespace BrowserRallarStatsRuntime {
    export interface Input {
        resolveOperationOptions<T extends RallarOperationOptions>(
            options: T
        ): T & RallarOperationOptions;
        resolveOperationScope(scope?: StateScope): StateScope | undefined;
        requireSession(): AuthSession;
        runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
    }
}

interface StatsGroupTarget {
    readonly groupId: string;
    readonly scope: StateScope;
}

/** Owns browser statistics reads and their auth-aware retry policy. */
export class BrowserRallarStatsRuntime implements RallarStatsOperations {
    private readonly input: BrowserRallarStatsRuntime.Input;

    public constructor(input: BrowserRallarStatsRuntime.Input) {
        this.input = input;
    }

    public async summary(
        readOptions: RallarScopedOperationOptions = {}
    ): Promise<WorkspaceSpaStatisticsResponse> {
        const operationOptions = this.input.resolveOperationOptions(readOptions);
        const session = this.input.requireSession();
        const scope = this.input.resolveOperationScope(readOptions.scope) ??
            defaultStateScope();
        return await this.input.runAuthAwareOperation(
            async () =>
                await runRallarCommand(
                    async (signal) =>
                        await readStateWorkspaceStatsSummary(scope, {
                            authSession: session,
                            signal
                        }),
                    operationOptions
                )
        );
    }

    public async group(
        group: string | GroupRef,
        readOptions: RallarScopedOperationOptions = {}
    ): Promise<GroupSpaStatisticsResponse> {
        const operationOptions = this.input.resolveOperationOptions(readOptions);
        const session = this.input.requireSession();
        const target = this.toGroupTarget(group, readOptions.scope);
        return await this.input.runAuthAwareOperation(
            async () =>
                await runRallarCommand(
                    async (signal) =>
                        await readStateGroupStats(target.groupId, target.scope, {
                            authSession: session,
                            signal
                        }),
                    operationOptions
                )
        );
    }

    public async meRealtime(
        readOptions: RallarScopedOperationOptions = {}
    ): Promise<MyRealtimeSpaStatisticsResponse> {
        const operationOptions = this.input.resolveOperationOptions(readOptions);
        const session = this.input.requireSession();
        const scope = this.input.resolveOperationScope(readOptions.scope) ??
            defaultStateScope();
        return await this.input.runAuthAwareOperation(
            async () =>
                await runRallarCommand(
                    async (signal) =>
                        await readStateMyRealtimeStatus(scope, {
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
    ): StatsGroupTarget {
        if (typeof group === 'string') {
            return {
                groupId: group,
                scope: this.input.resolveOperationScope(scope) ?? defaultStateScope()
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
