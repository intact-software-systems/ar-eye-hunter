import type { ResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import type { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { ClaimableDeadlineClaim } from '@shared/resilience/run-with-claimable-deadline.ts';

import { createPSqlCounterScope } from '../../../postgres/create-p-sql-counter-scope.ts';
import type { PSqlSql, PSqlTransactionWrite } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import { writeResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { writeResourceInboxResultReplacement } from '../../../queuebox/postgres/resource-inbox-result-replacement.ts';
import type { RallarTimingDetails, RallarTimingSink } from '../../observability/timing.ts';
import { toAppInboxEntryCompletionAwaitability } from '../app-inbox-command-identity.ts';
import {
    AppInboxAttemptDeadlineExceededError,
    AppInboxReservationConflictError,
    toAppInboxCompletionAwaitability,
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

/** A write outside an executor-run attempt has no deadline to lose. */
const UNBOUNDED_ATTEMPT_DEADLINE: ClaimableDeadlineClaim = { tryClaim: () => true, isExpired: () => false };

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
    private readonly deadlineByContext = new WeakMap<object, ClaimableDeadlineClaim>();
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

    /** The attempt's transaction claims the deadline just before it commits; a lost claim rolls the attempt back. */
    begin(context: AppInboxExecutionMetadata, deadline: ClaimableDeadlineClaim): void {
        this.finalizationByContext.set(context, { state: 'pending' });
        this.deadlineByContext.set(context, deadline);
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
                details: {
                    selectedLane: attempt.telemetry.selectedLane,
                    queueAgeMs: attempt.telemetry.queueAgeMs,
                    dueAgeMs: attempt.telemetry.dueAgeMs,
                    attempt: attempt.telemetry.attempt,
                    selectedDueAtEpochMs: attempt.telemetry.selectedDueAtEpochMs,
                    reservationLeaseMs: attempt.telemetry.reservationLeaseMs,
                    selectedAtEpochMs: attempt.telemetry.selectedAtEpochMs,
                    classification: 'non-retryable'
                }
            }
        }, async () =>
            await runInPSqlTransaction(transactionScope, async (transaction) => {
                await writeAppInboxCompletion(transaction, computed);
            }));
        this.completionNotifications?.publish(
            computed.finalizedEntry.key,
            toAppInboxEntryCompletionAwaitability(attempt.entry)
        );
    }

    private async writeFinalizedMutation<DurableResult>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<DurableResult>,
        write: PSqlTransactionWrite<void>
    ): Promise<void> {
        this.ensurePending(context);
        const deadline = this.deadlineByContext.get(context) ?? UNBOUNDED_ATTEMPT_DEADLINE;
        await this.inTransaction(context, this.toTimingDetails(context), async (transaction) => {
            await write(transaction);
            await writeAppInboxCompletion(transaction, computed);
            if (!deadline.tryClaim()) {
                throw new AppInboxAttemptDeadlineExceededError(context.entry.key);
            }
        });
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            entry: computed.finalizedEntry
        });
        this.completionNotifications?.publish(
            computed.finalizedEntry.key,
            toAppInboxCompletionAwaitability(context.enqueue.type)
        );
    }

    private ensurePending(context: AppInboxExecutionMetadata): void {
        const current = this.finalizationByContext.get(context);
        if (current?.state === 'transaction-finalized') {
            throw new Error('App inbox handler context is already finalized');
        }
        if (!current) {
            this.begin(context, UNBOUNDED_ATTEMPT_DEADLINE);
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

    /**
     * One scope per transaction when the port counts, so its line counts this transaction's statements alone;
     * the scope opens the transaction through this writer's own handle, and times its begin only for a timing line.
     */
    private openTransactionScope(): PSqlSql {
        return this.database.getExecutorCounters
            ? createPSqlCounterScope(this.database, { timesBeginWait: this.config.timing !== undefined })
            : this.database;
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
