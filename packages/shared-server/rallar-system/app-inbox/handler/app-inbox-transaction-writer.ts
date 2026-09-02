import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import { writeResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { writeResourceInboxResultReplacement } from '../../../queuebox/postgres/resource-inbox-result-replacement.ts';
import type { RallarTimingDetails, RallarTimingSink } from '../../observability/timing.ts';
import { timeRallarAsync } from '../../observability/timing.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    type AppInboxExecutionMetadata
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
        await this.writeFinalizedMutation(context, computed, write);
        return computed.durableResult;
    }

    async writeComputedMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: (transaction: PSqlSql) => Promise<AfterCommitResult>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>> {
        const afterCommitResult = await this.writeFinalizedMutation(context, computed, write);
        return { durableResult: computed.durableResult, afterCommitResult };
    }

    async writeComputedTerminalFailure<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>
    ): Promise<void> {
        await this.writeFinalizedMutation(context, computed, async () => {});
    }

    private async writeFinalizedMutation<DurableResult, WriteResult>(
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
                throw computed.reservationConflict;
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
        write: (transaction: PSqlSql) => Promise<ReturnResult>
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
                    async (transaction) => await write(transaction)
                )
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
}
