import { Temporal } from '@js-temporal/polyfill';
import { EntityStatus, toResourceEntryWithUpdatedResource } from '@shared/queuebox/ResourceEntry.ts';
import type {
    PSqlSql,
    PSqlTransactionSql,
} from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { runInTransaction } from '@shared-server/postgres/run-in-transaction.ts';
import type { RallarTimingDetails, RallarTimingSink } from './timing.ts';
import { timeRallarAsync } from './timing.ts';
import {
    AppInboxReservationConflictError,
    type AppInboxMessageContext,
} from './app-inbox-contracts.ts';

export type AppInboxHandlerFinalization =
    | Readonly<{ state: 'pending' }>
    | Readonly<{
        state: 'transaction-finalized';
        status: EntityStatus.COMPLETED | EntityStatus.FAILED;
        result: unknown;
    }>;

export class AppInboxTransactionWriter {
    private readonly finalizationByContext = new WeakMap<
        AppInboxMessageContext,
        AppInboxHandlerFinalization
    >();

    constructor(private readonly options: Readonly<{
        database: PSqlSql;
        serviceId: string;
        timing?: RallarTimingSink;
        nowEpochMs: () => number;
        toTimingDetails: (context: AppInboxMessageContext) => RallarTimingDetails;
    }>) {}

    begin(context: AppInboxMessageContext): void {
        this.finalizationByContext.set(context, { state: 'pending' });
    }

    read(context: AppInboxMessageContext): AppInboxHandlerFinalization {
        return this.finalizationByContext.get(context) ?? { state: 'pending' };
    }

    async writeMutation<R>(
        context: AppInboxMessageContext,
        write: (transaction: PSqlTransactionSql) => Promise<R>,
    ): Promise<R> {
        this.ensurePending(context);
        const result = await this.inTransaction(
            context,
            this.options.toTimingDetails(context),
            async (transaction, repositories) => {
                const value = await this.timeWrite(
                    context,
                    this.options.toTimingDetails(context),
                    async () => await write(transaction),
                );
                await repositories.results.replace(
                    toResourceEntryWithUpdatedResource(
                        context.entry,
                        EntityStatus.COMPLETED,
                        value,
                    ),
                );
                await this.finish(
                    context,
                    repositories.inbox,
                    EntityStatus.COMPLETED,
                    this.options.nowEpochMs(),
                );
                return value;
            },
        );
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            status: EntityStatus.COMPLETED,
            result,
        });
        return result;
    }

    async writeTerminalFailure(
        context: AppInboxMessageContext,
        result: unknown,
    ): Promise<void> {
        this.ensurePending(context);
        const details = {
            ...this.options.toTimingDetails(context),
            classification: 'terminal',
        };
        await this.inTransaction(context, details, async (_transaction, repositories) => {
            await this.timeWrite(context, details, async () => {
                await repositories.results.replace(
                    toResourceEntryWithUpdatedResource(
                        context.entry,
                        EntityStatus.FAILED,
                        result,
                    ),
                );
                await this.finish(
                    context,
                    repositories.inbox,
                    EntityStatus.FAILED,
                    this.options.nowEpochMs(),
                );
            });
        });
        this.finalizationByContext.set(context, {
            state: 'transaction-finalized',
            status: EntityStatus.FAILED,
            result,
        });
    }

    private ensurePending(context: AppInboxMessageContext): void {
        const current = this.finalizationByContext.get(context);
        if (current?.state === 'transaction-finalized') {
            throw new Error('App inbox handler context is already finalized');
        }
        if (!current) this.begin(context);
    }

    private async inTransaction<R>(
        context: AppInboxMessageContext,
        details: RallarTimingDetails,
        write: (
            transaction: PSqlTransactionSql,
            repositories: Readonly<{
                inbox: ResourceInboxRepository;
                results: ResourceInboxResultsRepository;
            }>,
        ) => Promise<R>,
    ): Promise<R> {
        return await timeRallarAsync(
            this.options.timing,
            {
                component: 'app-inbox-phase',
                operation: 'transaction',
                serviceId: this.options.serviceId,
                requestId: context.enqueue.resourceId,
                details,
            },
            async () => await runInTransaction(this.options.database, async (transaction) =>
                await write(transaction, {
                    inbox: new ResourceInboxRepository(transaction),
                    results: new ResourceInboxResultsRepository(transaction),
                })
            ),
        );
    }

    private async timeWrite<R>(
        context: AppInboxMessageContext,
        details: RallarTimingDetails,
        write: () => Promise<R>,
    ): Promise<R> {
        return await timeRallarAsync(
            this.options.timing,
            {
                component: 'app-inbox-phase',
                operation: 'write',
                serviceId: this.options.serviceId,
                requestId: context.enqueue.resourceId,
                details,
            },
            write,
        );
    }

    private async finish(
        context: AppInboxMessageContext,
        inbox: ResourceInboxRepository,
        status: EntityStatus.COMPLETED | EntityStatus.FAILED,
        completedAtEpochMs: number,
    ): Promise<void> {
        const completed = await inbox.finishReserved(
            context.entry.key,
            context.entry.dequeueAudit.attempts,
            status,
            new Date(completedAtEpochMs),
        );
        if (!completed) {
            throw new AppInboxReservationConflictError(context.entry.key);
        }
    }
}

export function toFinalizedResourceEntry(
    context: AppInboxMessageContext,
    status: EntityStatus.COMPLETED | EntityStatus.FAILED,
    completedAtEpochMs: number,
) {
    return {
        ...context.entry,
        status,
        dequeueAudit: {
            ...context.entry.dequeueAudit,
            endTs: Temporal.Instant.fromEpochMilliseconds(completedAtEpochMs),
            nextTs: undefined,
        },
    };
}
