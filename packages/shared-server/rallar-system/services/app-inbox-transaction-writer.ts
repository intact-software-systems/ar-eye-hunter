import { Temporal } from '@js-temporal/polyfill';
import {
  EntityStatus,
  toResourceEntryWithUpdatedResource,
} from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
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
      status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED;
      result: unknown;
    }>;

export interface AppInboxMutationTransactionResult<DurableResult, AfterCommitResult> {
  readonly durableResult: DurableResult;
  readonly afterCommitResult: AfterCommitResult;
}

export interface AppInboxMutationTransactionWriter {
  writeMutation<Result>(
    context: AppInboxMessageContext,
    write: (transaction: PSqlTransactionSql) => Promise<Result>,
  ): Promise<Result>;

  writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
    context: AppInboxMessageContext,
    write: (
      transaction: PSqlTransactionSql,
    ) => Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>,
  ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>;
}

interface AppInboxMutationFinalization<DurableResult, ReturnResult> {
  readonly durableResult: DurableResult;
  readonly returnResult: ReturnResult;
}

export class AppInboxTransactionWriter implements AppInboxMutationTransactionWriter {
  private readonly finalizationByContext = new WeakMap<
    AppInboxMessageContext,
    AppInboxHandlerFinalization
  >();

  private readonly options: Readonly<{
      database: PSqlSql;
      serviceId: string;
      timing?: RallarTimingSink;
      nowEpochMs: () => number;
      toTimingDetails: (context: AppInboxMessageContext) => RallarTimingDetails;
    }>;

  constructor(
    options: Readonly<{
      database: PSqlSql;
      serviceId: string;
      timing?: RallarTimingSink;
      nowEpochMs: () => number;
      toTimingDetails: (context: AppInboxMessageContext) => RallarTimingDetails;
    }>,
  ) {
    this.options = options;
  }

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
    return await this.writeFinalizedMutation(context, async (transaction) => {
      const durableResult = await write(transaction);
      return { durableResult, returnResult: durableResult };
    });
  }

  async writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
    context: AppInboxMessageContext,
    write: (
      transaction: PSqlTransactionSql,
    ) => Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>,
  ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>> {
    return await this.writeFinalizedMutation(context, async (transaction) => {
      const result = await write(transaction);
      return { durableResult: result.durableResult, returnResult: result };
    });
  }

  private async writeFinalizedMutation<DurableResult, ReturnResult>(
    context: AppInboxMessageContext,
    write: (
      transaction: PSqlTransactionSql,
    ) => Promise<AppInboxMutationFinalization<DurableResult, ReturnResult>>,
  ): Promise<ReturnResult> {
    this.ensurePending(context);
    const finalized = await this.inTransaction(
      context,
      this.options.toTimingDetails(context),
      async (transaction, repositories) => {
        const result = await this.timeWrite(
          context,
          this.options.toTimingDetails(context),
          async () => await write(transaction),
        );
        await repositories.results.replace(
          toResourceEntryWithUpdatedResource(
            context.entry,
            EntityStatus.COMPLETED,
            result.durableResult,
          ),
        );
        await this.finish(
          context,
          repositories.inbox,
          EntityStatus.COMPLETED,
          this.options.nowEpochMs(),
        );
        return result;
      },
    );
    this.finalizationByContext.set(context, {
      state: 'transaction-finalized',
      status: EntityStatus.COMPLETED,
      result: finalized.durableResult,
    });
    return finalized.returnResult;
  }

  async writeTerminalFailure(context: AppInboxMessageContext, result: unknown): Promise<void> {
    this.ensurePending(context);
    const details = {
      ...this.options.toTimingDetails(context),
      classification: 'terminal',
    };
    await this.inTransaction(context, details, async (_transaction, repositories) => {
      await this.timeWrite(context, details, async () => {
        await repositories.results.replace(
          toResourceEntryWithUpdatedResource(context.entry, EntityStatus.FAILED, result),
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
      async () =>
        await runInTransaction(
          this.options.database,
          async (transaction) =>
            await write(transaction, {
              inbox: new ResourceInboxRepository(transaction),
              results: new ResourceInboxResultsRepository(transaction),
            }),
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
    status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED,
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
  status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED,
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
