import { Temporal } from '@js-temporal/polyfill';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import { PSqlResourceInboxFinalizationRepository } from '../../../queuebox/postgres/p-sql-resource-inbox-finalization-repository.ts';
import { writeResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { writeResourceInboxResultReplacement } from '../../../queuebox/postgres/resource-inbox-result-replacement.ts';
import { ResourceInboxResultsRepository } from '../../../queuebox/postgres/resource-inbox-results-repository.ts';
import type { RallarTimingDetails, RallarTimingSink } from '../../observability/timing.ts';
import { timeRallarAsync } from '../../observability/timing.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    AppInboxReservationConflictError,
    type AppInboxExecutionMetadata,
    type AppInboxMessageContext
} from '../app-inbox-contracts.ts';
import { toAppInboxAttemptTimingDetails } from './app-inbox-attempt-timing.ts';
import type { AppInboxCompletionComputed, AppInboxCompletionFacts } from './app-inbox-completion-computation.ts';

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
    readCompletionFacts(context: AppInboxExecutionMetadata): AppInboxCompletionFacts;

    writeComputedMutation<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<Result>;

    writeComputedMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: (transaction: PSqlSql) => Promise<AfterCommitResult>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>;

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

export namespace AppInboxTransactionWriter {
    export interface Dependencies {
        readonly database: PSqlSql;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly nowEpochMs?: () => number;
        readonly timingNowEpochMs?: () => number;
    }
}

export class AppInboxTransactionWriter implements AppInboxMutationTransactionWriter {
    private readonly finalizationByContext = new WeakMap<object, AppInboxHandlerFinalization>();
    private readonly database: PSqlSql;
    private readonly config: AppInboxTransactionWriter.Config;

    constructor(
        dependencies: AppInboxTransactionWriter.Dependencies,
        config: AppInboxTransactionWriter.Config
    ) {
        this.database = dependencies.database;
        this.config = config;
    }

    begin(context: AppInboxExecutionMetadata): void {
        this.finalizationByContext.set(context, { state: 'pending' });
    }

    read(context: AppInboxExecutionMetadata): AppInboxHandlerFinalization {
        return this.finalizationByContext.get(context) ?? { state: 'pending' };
    }

    readCompletionFacts(context: AppInboxExecutionMetadata): AppInboxCompletionFacts {
        return {
            entry: context.entry,
            completedAtEpochMs: this.nowEpochMs()
        };
    }

    async writeComputedMutation<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<Result> {
        await this.writeComputedFinalizedMutation(context, computed, write);
        return computed.durableResult;
    }

    async writeComputedMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: (transaction: PSqlSql) => Promise<AfterCommitResult>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>> {
        const afterCommitResult = await this.writeComputedFinalizedMutation(context, computed, write);
        return { durableResult: computed.durableResult, afterCommitResult };
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
            this.toTimingDetails(context),
            async (transaction, repositories) => {
                const result = await this.timeWrite(
                    context,
                    this.toTimingDetails(context),
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
                    this.nowEpochMs()
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
            ...this.toTimingDetails(context),
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
                    this.nowEpochMs()
                );
            });
        });
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            status: EntityStatus.FAILED,
            result
        });
    }

    async writeComputedTerminalFailure<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>
    ): Promise<void> {
        await this.writeComputedFinalizedMutation(context, computed, async () => {});
    }

    private async writeComputedFinalizedMutation<DurableResult, WriteResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: (transaction: PSqlSql) => Promise<WriteResult>
    ): Promise<WriteResult> {
        this.ensurePending(context);
        const result = await this.inTransaction(context, this.toTimingDetails(context), async (transaction) => {
            const writeResult = await write(transaction);
            await writeResourceInboxResultReplacement(transaction, computed.resultReplacement);
            const completed = await writeResourceInboxReservationFinish(transaction, computed.reservationFinish);
            if (!completed) {
                throw new AppInboxReservationConflictError(context.entry.key);
            }
            return writeResult;
        });
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            status: computed.reservationFinish.status,
            result: computed.encodedResult
        });
        return result;
    }

    private ensurePending(context: AppInboxExecutionMetadata): void {
        const current = this.finalizationByContext.get(context);
        if (current?.state === 'transaction-finalized') {
            throw new Error('App inbox handler context is already finalized');
        }
        if (!current) {
            this.begin(context);
        }
    }

    private async inTransaction<ReturnResult>(
        context: AppInboxExecutionMetadata,
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
            this.config.timing,
            {
                component: 'app-inbox-phase',
                operation: 'transaction',
                serviceId: this.config.serviceId,
                requestId: context.enqueue.resourceId,
                details
            },
            async () =>
                await runInPSqlTransaction(
                    this.database,
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
            this.config.timing,
            {
                component: 'app-inbox-phase',
                operation: 'write',
                serviceId: this.config.serviceId,
                requestId: context.enqueue.resourceId,
                details
            },
            write
        );
    }

    private toTimingDetails(context: AppInboxExecutionMetadata): RallarTimingDetails {
        return toAppInboxAttemptTimingDetails(
            context.enqueue,
            context.entry,
            this.config.timingNowEpochMs?.() ?? Date.now()
        );
    }

    private nowEpochMs(): number {
        return this.config.nowEpochMs?.() ?? Date.now();
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
