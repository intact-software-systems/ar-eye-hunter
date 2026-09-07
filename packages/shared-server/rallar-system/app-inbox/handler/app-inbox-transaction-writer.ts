import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { ResourceInboxAttempt } from '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import {
    writeResourceInboxReservationFinish,
    type ResourceInboxReservationFinish
} from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { writeResourceInboxResultReplacement } from '../../../queuebox/postgres/resource-inbox-result-replacement.ts';
import type { RallarTimingDetails, RallarTimingSink } from '../../observability/timing.ts';
import { timeRallarAsync } from '../../observability/timing.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    AppInboxReservationConflictError,
    type AppInboxExecutionMetadata
} from '../app-inbox-contracts.ts';
import { toAppInboxAttemptTimingDetails } from './app-inbox-attempt-timing.ts';
import type { AppInboxCompletionComputed, AppInboxCompletionFacts } from './app-inbox-completion-computation.ts';

export type AppInboxHandlerFinalization =
    | Readonly<{ state: 'pending'; }>
    | Readonly<{
        state: 'transaction-finalized';
        status: ResourceInboxReservationFinish['status'];
        result: JsonWireValue;
    }>;

export interface AppInboxMutationTransactionWriter {
    readCompletionFacts(context: AppInboxExecutionMetadata): AppInboxCompletionFacts;

    writeComputedMutation<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<Result>;
}

export namespace AppInboxTransactionWriter {
    export interface Dependencies {
        readonly database: PSqlSql;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly nowEpochMs?: () => number;
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

    async writeComputedTerminalFailure<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>
    ): Promise<void> {
        await this.writeFinalizedMutation(context, computed, async () => {});
    }

    async writeComputedQueueFailure<Result>(
        attempt: ResourceInboxAttempt,
        computed: AppInboxCompletionComputed<Result>
    ): Promise<void> {
        await timeRallarAsync(this.config.timing, {
            component: 'app-inbox-phase',
            operation: 'transaction',
            serviceId: this.config.serviceId,
            requestId: attempt.entry.key.resourceId,
            details: { ...attempt.telemetry, classification: 'non-retryable' }
        }, async () =>
            await runInPSqlTransaction(this.database, async (transaction) => {
                await writeAppInboxCompletion(transaction, computed);
            }));
    }

    private async writeFinalizedMutation<DurableResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<void> {
        this.ensurePending(context);
        await this.inTransaction(context, this.toTimingDetails(context), async (transaction) => {
            await write(transaction);
            await writeAppInboxCompletion(transaction, computed);
        });
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            status: computed.reservationFinish.status,
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
            context.attemptTelemetry
        );
    }

    private nowEpochMs(): number {
        return this.config.nowEpochMs?.() ?? Date.now();
    }
}

async function writeAppInboxCompletion<Result>(
    transaction: PSqlSql,
    computed: AppInboxCompletionComputed<Result>
): Promise<void> {
    if (!await writeResourceInboxReservationFinish(transaction, computed.reservationFinish)) {
        throw new AppInboxReservationConflictError(computed.reservationFinish.key);
    }
    await writeResourceInboxResultReplacement(transaction, computed.resultReplacement);
}
