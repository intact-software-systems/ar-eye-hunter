import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import {
    writeResourceInboxReservationFinish,
    type ResourceInboxReservationFinish
} from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import type { RallarTimingDetails, RallarTimingSink } from '../../observability/timing.ts';
import { nowMs, recordRallarTiming } from '../../observability/timing.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { AppInboxReservationConflictError, type AppInboxExecutionMetadata } from '../app-inbox-contracts.ts';
import type { AppInboxFailure } from '../app-inbox-failure.ts';
import { toAppInboxAttemptTimingDetails } from './app-inbox-attempt-timing.ts';
import type { AppInboxCompletionComputed, AppInboxCompletionFacts } from './app-inbox-completion-computation.ts';
import { writeAppInboxResultReplacement } from './write-app-inbox-result-replacement.ts';

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

    writeMutation<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<Result>;

    writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: (transaction: PSqlSql) => Promise<AfterCommitResult>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>;
}

interface RecordAppInboxTransactionTimingInput {
    readonly context: AppInboxExecutionMetadata;
    readonly details: RallarTimingDetails;
    readonly startedAt: number | undefined;
    readonly status: 'ok' | 'error';
    readonly error?: Error;
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
            completedAtEpochMs: this.config.nowEpochMs?.() ?? Date.now()
        };
    }

    async writeMutation<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<Result> {
        await this.writeFinalizedMutation(context, computed, write);
        return computed.durableResult;
    }

    async writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: (transaction: PSqlSql) => Promise<AfterCommitResult>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>> {
        const afterCommitResult = await this.writeFinalizedMutation(context, computed, write);
        return { durableResult: computed.durableResult, afterCommitResult };
    }

    private async writeFinalizedMutation<DurableResult, WriteResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: (transaction: PSqlSql) => Promise<WriteResult>
    ): Promise<WriteResult> {
        this.ensurePending(context);
        const writeResult = await this.inTransaction(
            context,
            this.readTimingDetails(context),
            async (transaction) => {
                const result = await write(transaction);
                await writeAppInboxResultReplacement(transaction, computed.resultReplacement);
                await this.finishReservation(computed.reservationConflict, transaction, computed.reservationFinish);
                return result;
            }
        );
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            status: computed.reservationFinish.status,
            result: computed.encodedResult
        });
        return writeResult;
    }

    async writeTerminalFailure(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<AppInboxFailure>
    ): Promise<void> {
        this.ensurePending(context);
        const details = {
            ...this.readTimingDetails(context),
            classification: 'terminal'
        };
        await this.inTransaction(context, details, async (transaction) => {
            await writeAppInboxResultReplacement(transaction, computed.resultReplacement);
            await this.finishReservation(computed.reservationConflict, transaction, computed.reservationFinish);
        });
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            status: EntityStatus.FAILED,
            result: computed.encodedResult
        });
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
        const startedAt = this.config.timing ? nowMs() : undefined;
        try {
            const result = await runInPSqlTransaction(
                this.database,
                async (transaction) => await write(transaction)
            );
            this.recordTransactionTiming({ context, details, startedAt, status: 'ok' });
            return result;
        }
        catch (caught) {
            const error = caught instanceof Error ? caught : new Error(String(caught));
            this.recordTransactionTiming({
                context,
                details,
                startedAt,
                status: 'error',
                error
            });
            throw error;
        }
    }

    private readTimingDetails(context: AppInboxExecutionMetadata): RallarTimingDetails {
        return toAppInboxAttemptTimingDetails(
            context.enqueue,
            context.entry,
            this.config.timingNowEpochMs?.() ?? Date.now()
        );
    }

    private async finishReservation(
        conflict: AppInboxReservationConflictError,
        transaction: PSqlSql,
        computed: ResourceInboxReservationFinish
    ): Promise<void> {
        const completed = await writeResourceInboxReservationFinish(transaction, computed);
        if (!completed) {
            throw conflict;
        }
    }

    private recordTransactionTiming(input: RecordAppInboxTransactionTimingInput): void {
        const { context, details, startedAt, status, error } = input;
        if (startedAt === undefined) {
            return;
        }
        const durationMs = nowMs() - startedAt;
        for (const operation of ['transaction', 'write']) {
            recordRallarTiming({
                sink: this.config.timing,
                event: {
                    component: 'app-inbox-phase',
                    operation,
                    serviceId: this.config.serviceId,
                    requestId: context.enqueue.resourceId,
                    details
                },
                status,
                durationMs,
                error
            });
        }
    }
}
