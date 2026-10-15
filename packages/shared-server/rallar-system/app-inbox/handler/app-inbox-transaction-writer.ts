import type { ResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import type { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql, PSqlTransactionWrite } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import { writeResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { writeResourceInboxResultReplacement } from '../../../queuebox/postgres/resource-inbox-result-replacement.ts';
import type { RallarTimingDetails, RallarTimingSink } from '../../observability/timing.ts';
import {
    AppInboxReservationConflictError,
    type AppInboxExecutionMetadata
} from '../app-inbox-contracts.ts';
import { toAppInboxAttemptTimingDetails } from './app-inbox-attempt-timing.ts';
import type { AppInboxCompletionComputed, AppInboxCompletionFacts } from './app-inbox-completion-computation.ts';
import { timeAppInboxPhase } from './app-inbox-phase-timing.ts';

export type AppInboxHandlerFinalization =
    | Readonly<{ state: 'pending'; }>
    | Readonly<{
        state: 'transaction-finalized';
        entry: ResourceEntry;
    }>;

export interface AppInboxMutationTransactionWriter {
    readCompletionFacts(context: AppInboxExecutionMetadata): AppInboxCompletionFacts;

    writeComputedMutation<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: PSqlTransactionWrite<void>
    ): Promise<Result>;
}

export namespace AppInboxTransactionWriter {
    export interface Dependencies {
        readonly completionNotifications?: ResourceInboxCompletionNotifications;
        readonly database: PSqlSql;
        readonly nowEpochMs: () => number;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
    }
}

export class AppInboxTransactionWriter implements AppInboxMutationTransactionWriter {
    private readonly finalizationByContext = new WeakMap<object, AppInboxHandlerFinalization>();
    private readonly completionNotifications: ResourceInboxCompletionNotifications | undefined;
    private readonly database: PSqlSql;
    private readonly nowEpochMs: () => number;
    private readonly config: AppInboxTransactionWriter.Config;

    constructor(
        dependencies: AppInboxTransactionWriter.Dependencies,
        config: AppInboxTransactionWriter.Config
    ) {
        this.completionNotifications = dependencies.completionNotifications;
        this.database = dependencies.database;
        this.nowEpochMs = dependencies.nowEpochMs;
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
        write: PSqlTransactionWrite<void>
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
        const transactionScope = this.openTransactionScope();
        await timeAppInboxPhase({
            sink: this.config.timing,
            database: transactionScope,
            event: {
                component: 'app-inbox-phase',
                operation: 'transaction',
                serviceId: this.config.serviceId,
                requestId: attempt.entry.key.resourceId,
                details: { ...attempt.telemetry, classification: 'non-retryable' }
            }
        }, async () =>
            await runInPSqlTransaction(transactionScope, async (transaction) => {
                await writeAppInboxCompletion(transaction, computed);
            }));
        this.completionNotifications?.publish(computed.finalizedEntry.key);
    }

    private async writeFinalizedMutation<DurableResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: PSqlTransactionWrite<void>
    ): Promise<void> {
        this.ensurePending(context);
        await this.inTransaction(context, this.toTimingDetails(context), async (transaction) => {
            await write(transaction);
            await writeAppInboxCompletion(transaction, computed);
        });
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            entry: computed.finalizedEntry
        });
        this.completionNotifications?.publish(computed.finalizedEntry.key);
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
        write: PSqlTransactionWrite<ReturnResult>
    ): Promise<ReturnResult> {
        const transactionScope = this.openTransactionScope();
        return await timeAppInboxPhase(
            {
                sink: this.config.timing,
                database: transactionScope,
                event: {
                    component: 'app-inbox-phase',
                    operation: 'transaction',
                    serviceId: this.config.serviceId,
                    requestId: context.enqueue.resourceId,
                    details
                }
            },
            async () =>
                await runInPSqlTransaction(
                    transactionScope,
                    async (transaction) => await write(transaction)
                )
        );
    }

    /** One scope per transaction, so its line counts this transaction's statements alone when the port scopes. */
    private openTransactionScope(): PSqlSql {
        return this.database.openCounterScope?.() ?? this.database;
    }

    private toTimingDetails(context: AppInboxExecutionMetadata): RallarTimingDetails {
        return toAppInboxAttemptTimingDetails(
            context.enqueue,
            context.entry,
            context.attemptTelemetry
        );
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
