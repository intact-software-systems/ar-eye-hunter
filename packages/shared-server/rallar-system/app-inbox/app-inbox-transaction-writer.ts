import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { PSqlResourceInboxFinalizationRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-finalization-repository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import type { RallarTimingDetails, RallarTimingSink } from '../observability/timing.ts';
import { timeRallarAsync } from '../observability/timing.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    AppInboxReservationConflictError,
    type AppInboxExecutionMetadata,
    type AppInboxMessageContext
} from './app-inbox-contracts.ts';

export type AppInboxHandlerFinalization =
    | Readonly<{ state: 'pending'; }>
    | Readonly<{
        state: 'transaction-finalized';
        status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED;
        result: JsonWireValue;
    }>;

export interface AppInboxMutationTransactionResult<DurableResult, AfterCommitResult> {
    readonly durableResult: DurableResult;
    readonly afterCommitResult: AfterCommitResult;
}

export interface AppInboxMutationTransactionWriter {
    writeMutation<Result>(
        context: AppInboxMessageContext<Result>,
        write: (transaction: PSqlSql) => Promise<Result>
    ): Promise<Result>;

    writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        context: AppInboxMessageContext<DurableResult>,
        write: (
            transaction: PSqlSql
        ) => Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>;
}

interface AppInboxMutationFinalization<DurableResult, ReturnResult> {
    readonly durableResult: DurableResult;
    readonly returnResult: ReturnResult;
}

export class AppInboxTransactionWriter implements AppInboxMutationTransactionWriter {
    private readonly finalizationByContext = new WeakMap<object, AppInboxHandlerFinalization>();

    private readonly options: Readonly<{
        database: PSqlSql;
        serviceId: string;
        timing?: RallarTimingSink;
        nowEpochMs: () => number;
        toTimingDetails: (context: AppInboxExecutionMetadata) => RallarTimingDetails;
    }>;

    constructor(
        options: Readonly<{
            database: PSqlSql;
            serviceId: string;
            timing?: RallarTimingSink;
            nowEpochMs: () => number;
            toTimingDetails: (context: AppInboxExecutionMetadata) => RallarTimingDetails;
        }>
    ) {
        this.options = options;
    }

    begin<Result>(context: AppInboxMessageContext<Result>): void {
        this.finalizationByContext.set(context, { state: 'pending' });
    }

    read<Result>(context: AppInboxMessageContext<Result>): AppInboxHandlerFinalization {
        return this.finalizationByContext.get(context) ?? { state: 'pending' };
    }

    async writeMutation<Result>(
        context: AppInboxMessageContext<Result>,
        write: (transaction: PSqlSql) => Promise<Result>
    ): Promise<Result> {
        return await this.writeFinalizedMutation(context, async (transaction) => {
            const durableResult = await write(transaction);
            return { durableResult, returnResult: durableResult };
        });
    }

    async writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        context: AppInboxMessageContext<DurableResult>,
        write: (
            transaction: PSqlSql
        ) => Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>> {
        return await this.writeFinalizedMutation(context, async (transaction) => {
            const result = await write(transaction);
            return { durableResult: result.durableResult, returnResult: result };
        });
    }

    private async writeFinalizedMutation<DurableResult, ReturnResult>(
        context: AppInboxMessageContext<DurableResult>,
        write: (
            transaction: PSqlSql
        ) => Promise<AppInboxMutationFinalization<DurableResult, ReturnResult>>
    ): Promise<ReturnResult> {
        this.ensurePending(context);
        const finalized = await this.inTransaction(
            context,
            this.options.toTimingDetails(context),
            async (transaction, repositories) => {
                const result = await this.timeWrite(
                    context,
                    this.options.toTimingDetails(context),
                    async () => await write(transaction)
                );
                await repositories.results.replace(
                    toResourceEntryWithUpdatedResource(
                        context.entry,
                        EntityStatus.COMPLETED,
                        context.encodeResult(result.durableResult)
                    )
                );
                await this.finish(
                    context,
                    repositories.finalization,
                    EntityStatus.COMPLETED,
                    this.options.nowEpochMs()
                );
                return result;
            }
        );
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            status: EntityStatus.COMPLETED,
            result: context.encodeResult(finalized.durableResult)
        });
        return finalized.returnResult;
    }

    async writeTerminalFailure<Result>(
        context: AppInboxMessageContext<Result>,
        result: JsonWireValue
    ): Promise<void> {
        this.ensurePending(context);
        const details = {
            ...this.options.toTimingDetails(context),
            classification: 'terminal'
        };
        await this.inTransaction(context, details, async (_transaction, repositories) => {
            await this.timeWrite(context, details, async () => {
                await repositories.results.replace(
                    toResourceEntryWithUpdatedResource(context.entry, EntityStatus.FAILED, result)
                );
                await this.finish(
                    context,
                    repositories.finalization,
                    EntityStatus.FAILED,
                    this.options.nowEpochMs()
                );
            });
        });
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            status: EntityStatus.FAILED,
            result
        });
    }

    private ensurePending<Result>(context: AppInboxMessageContext<Result>): void {
        const current = this.finalizationByContext.get(context);
        if (current?.state === 'transaction-finalized') {
            throw new Error('App inbox handler context is already finalized');
        }
        if (!current) {
            this.begin(context);
        }
    }

    private async inTransaction<ReturnResult, Result>(
        context: AppInboxMessageContext<Result>,
        details: RallarTimingDetails,
        write: (
            transaction: PSqlSql,
            repositories: Readonly<{
                finalization: PSqlResourceInboxFinalizationRepository;
                results: ResourceInboxResultsRepository;
            }>
        ) => Promise<ReturnResult>
    ): Promise<ReturnResult> {
        return await timeRallarAsync(
            this.options.timing,
            {
                component: 'app-inbox-phase',
                operation: 'transaction',
                serviceId: this.options.serviceId,
                requestId: context.enqueue.resourceId,
                details
            },
            async () =>
                await runInPSqlTransaction(
                    this.options.database,
                    async (transaction) =>
                        await write(transaction, {
                            finalization: new PSqlResourceInboxFinalizationRepository(transaction),
                            results: new ResourceInboxResultsRepository(transaction)
                        })
                )
        );
    }

    private async timeWrite<ReturnResult, Result>(
        context: AppInboxMessageContext<Result>,
        details: RallarTimingDetails,
        write: () => Promise<ReturnResult>
    ): Promise<ReturnResult> {
        return await timeRallarAsync(
            this.options.timing,
            {
                component: 'app-inbox-phase',
                operation: 'write',
                serviceId: this.options.serviceId,
                requestId: context.enqueue.resourceId,
                details
            },
            write
        );
    }

    private async finish(
        context: AppInboxExecutionMetadata,
        finalization: PSqlResourceInboxFinalizationRepository,
        status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED,
        completedAtEpochMs: number
    ): Promise<void> {
        const completed = await finalization.finishReserved(
            context.entry.key,
            context.entry.dequeueAudit.attempts,
            status,
            new Date(completedAtEpochMs)
        );
        if (!completed) {
            throw new AppInboxReservationConflictError(context.entry.key);
        }
    }
}

export function toFinalizedResourceEntry(
    context: AppInboxExecutionMetadata,
    status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED,
    completedAtEpochMs: number
): ResourceEntry {
    return {
        ...context.entry,
        status,
        dequeueAudit: {
            ...context.entry.dequeueAudit,
            endTs: Temporal.Instant.fromEpochMilliseconds(completedAtEpochMs),
            nextTs: undefined
        }
    };
}
