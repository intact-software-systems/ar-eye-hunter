import type { AuthSession } from '@shared/api/api-config.ts';
import {
  ADMIN_PRUNE_EXPIRED_CATEGORIES,
  type AdminPruneExpiredCategory,
} from '@shared/api/admin-operations-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '@shared/resilience/TryWith.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql } from '../../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '../../postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
  type AdminPruneAppData,
  type AdminPruneCommand,
  createAdminPruneCommand,
  decodeAdminPruneCommand,
  toAdminPruneOutbox,
} from '../admin-operations/AdminPruneExpiredWork.ts';
import type { AdminOperationsPruner } from '../admin-operations/AdminOperationsService.ts';
import {
  createAdminPruneAggregate,
  decodeAdminPruneAggregate,
  toAdminPruneAggregateEntry,
  toAdminPruneAggregateKey,
  toAdminPruneCompletedResult,
} from '../admin-operations/admin-prune-progress.ts';
import type { AppInboxFailure } from './app-inbox-failure.ts';
import { toUnavailableAppInboxFailure } from './app-inbox-failure.ts';
import { AppInboxService, type AppInboxServiceOptions } from './AppInboxService.ts';
import { type AppInboxMessageContext, AppInboxType } from './app-inbox-contracts.ts';
import type { RallarTimingSink } from './timing.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

export const ADMIN_APP_INBOX_TOPIC = 'app-inbox.admin-operations';

export type AdminPruneEnqueueResult = Readonly<{
  generatedAtEpochMs: number;
  serverId: string;
  warnings: readonly [];
  operation: 'maintenance.prune-expired';
  status: 'dry-run' | 'queued' | 'completed';
  changed: boolean;
  jobId: string;
  results: readonly Readonly<{
    category: AdminPruneExpiredCategory;
    expiredRows: number;
    deletedRows: number;
    dryRun: boolean;
  }>[];
}>;

type AdminPruneRead = Readonly<{
  expiredRows: Readonly<Record<AdminPruneExpiredCategory, number>>;
  authority: Readonly<{ allowed: boolean; code: string }>;
  nowEpochMs: number;
}>;

export type AdminPruneAuthorityReader = (
  input: Readonly<{
    requestedBy: string;
    requestedSessionId: string;
    nowEpochMs: number;
  }>,
) => Promise<Readonly<{ allowed: boolean; code: string }>>;

type AdminPruneComputed = Readonly<{
  result: AdminPruneEnqueueResult;
  outboxEntries: readonly ResourceEntry[];
  aggregateEntry: ResourceEntry | null;
}>;

export class AppAdminInboxService extends AppInboxService {
  private readonly aggregateWaitPolicy: TryWithPolicy;

  constructor(
    public override readonly inbox: InboxQueueReader,
    public override readonly resourceInbox: ResourceInboxRepository,
    public override readonly resourceInboxResults: ResourceInboxResultsRepository,
    database: PSqlSql,
    private readonly pruner: AdminOperationsPruner,
    public override readonly serviceId: string,
    private readonly pageSize: number,
    timing?: RallarTimingSink,
    options?: AppInboxServiceOptions,
    private readonly readAuthority: AdminPruneAuthorityReader = () =>
      Promise.resolve({ allowed: false, code: 'current-authority-reader-missing' }),
    private readonly wakeQueue?: () => void,
  ) {
    super(
      inbox,
      resourceInbox,
      resourceInboxResults,
      database,
      serviceId,
      ADMIN_APP_INBOX_TOPIC,
      timing,
      options,
      wakeQueue,
    );
    this.aggregateWaitPolicy = TryWithPolicy.defaults()
      .label('app-inbox:admin-prune-aggregate')
      .maxElapsedMsecs(options?.waitMaxElapsedMsecs ?? AppInboxService.MAX_ELAPSED_MSECS)
      .retryIntervalMsecs(
        options?.waitRetryIntervalMsecs ?? AppInboxService.WAIT_RETRY_INTERVAL_MSECS,
      )
      .maxRetryIntervalMsecs(
        options?.waitMaxRetryIntervalMsecs ?? AppInboxService.WAIT_MAX_RETRY_INTERVAL_MSECS,
      )
      .jitterRatio(options?.waitJitterRatio ?? AppInboxService.WAIT_JITTER_RATIO);
    this.onStateMessage<unknown>(
      AppInboxType.ADMIN_PRUNE_EXPIRED,
      async (data, context) => await this.processCommand(data, context),
    );
  }

  async pruneExpired(
    input: Readonly<{ adminSession: AuthSession; request: unknown }>,
  ): Promise<Either<AppInboxFailure, AdminPruneEnqueueResult>> {
    const request = requireRecord(input.request);
    const capturedAtEpochMs = this.nowEpochMs();
    const categories = readCategories(request.categories);
    const appData = readAppData(request.appData);
    if (categories.includes('app-data') && appData === null) {
      throw new TypeError('appData.namespace is required for app-data pruning');
    }
    const command = await createAdminPruneCommand({
      jobId: readString(request.requestId) ?? crypto.randomUUID(),
      requestedBy: input.adminSession.clientId,
      requestedSessionId: input.adminSession.sessionId,
      capturedAtEpochMs,
      expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(capturedAtEpochMs),
      dryRun: request.dryRun === undefined ? true : requireBoolean(request.dryRun),
      categories,
      appData,
      pageSize: this.pageSize,
    });
    const enqueued = await this.processEntryUntilCompletionResult<
      AdminPruneCommand,
      AdminPruneEnqueueResult
    >({
      type: AppInboxType.ADMIN_PRUNE_EXPIRED,
      topicId: ADMIN_APP_INBOX_TOPIC,
      resourceId: command.jobId,
      contextId: input.adminSession.clientId,
      senderId: input.adminSession.sessionId,
      data: command,
    });
    if (enqueued.left !== undefined || command.dryRun) return enqueued;
    return await this.waitForAggregate(command.jobId);
  }

  private async processCommand(
    input: unknown,
    context: AppInboxMessageContext,
  ): Promise<AdminPruneEnqueueResult> {
    const command = decodeAdminPruneCommand(input);
    if (
      context.entry.key.resourceId !== command.jobId ||
      context.enqueue.type !== AppInboxType.ADMIN_PRUNE_EXPIRED
    )
      throw new TypeError('Admin prune AppInbox identity differs from queue key');
    const read = await this.read(command);
    const computed = this.compute(command, read);
    this.validate(command, read, computed);
    const result = await this.writeMutation(context, async (transaction) => {
      const outbox = new ResourceInboxRepository(transaction);
      for (const entry of computed.outboxEntries) {
        await outbox.writeIfAbsentOrMatch(entry);
      }
      if (computed.aggregateEntry) {
        const stored = await new ResourceInboxResultsRepository(
          transaction,
        ).writeIfAbsentOrReplaceExpired(computed.aggregateEntry);
        if (stored.resource !== computed.aggregateEntry.resource) {
          throw new Error('Admin prune aggregate collides with an active job');
        }
      }
      return computed.result;
    });
    if (!command.dryRun) this.wakeQueue?.();
    return result;
  }

  private async read(command: AdminPruneCommand): Promise<AdminPruneRead> {
    const nowEpochMs = this.nowEpochMs();
    const [pairs, authority] = await Promise.all([
      Promise.all(
        ADMIN_PRUNE_EXPIRED_CATEGORIES.map(
          async (category) =>
            [
              category,
              command.categories.includes(category)
                ? await this.pruner.countExpired(
                    category,
                    command.appData === null
                      ? {
                          cutoffEpochMs: command.capturedAtEpochMs,
                        }
                      : {
                          cutoffEpochMs: command.capturedAtEpochMs,
                          appData: {
                            namespace: command.appData.namespace,
                            ...(command.appData.storeName === null
                              ? {}
                              : { storeName: command.appData.storeName }),
                          },
                        },
                  )
                : 0,
            ] as const,
        ),
      ),
      this.readAuthority({
        requestedBy: command.requestedBy,
        requestedSessionId: command.requestedSessionId,
        nowEpochMs,
      }),
    ]);
    return {
      expiredRows: Object.fromEntries(pairs) as Record<AdminPruneExpiredCategory, number>,
      authority,
      nowEpochMs,
    };
  }

  private compute(command: AdminPruneCommand, read: AdminPruneRead): AdminPruneComputed {
    if (!read.authority.allowed || command.expireAtEpochMs <= read.nowEpochMs) {
      throw Object.assign(new Error('Admin prune current authority is denied'), {
        code: 'admin-prune-authority-denied',
        status: 403,
      });
    }
    const results = command.categories.map((category) => ({
      category,
      expiredRows: read.expiredRows[category],
      deletedRows: 0,
      dryRun: command.dryRun,
    }));
    const outboxEntries = command.dryRun
      ? []
      : command.categories.map((category) =>
          toAdminPruneOutbox(
            {
              kind: 'page',
              jobId: command.jobId,
              category,
              requestedBy: command.requestedBy,
              requestedSessionId: command.requestedSessionId,
              capturedAtEpochMs: command.capturedAtEpochMs,
              expireAtEpochMs: command.expireAtEpochMs,
              pageSize: command.pageSize,
              afterCursor: null,
              pageIndex: 0,
              appData: command.appData,
            },
            this.serviceId,
          ),
        );
    return {
      outboxEntries,
      aggregateEntry: command.dryRun
        ? null
        : toAdminPruneAggregateEntry(
            createAdminPruneAggregate({
              jobId: command.jobId,
              generatedAtEpochMs: command.capturedAtEpochMs,
              expireAtEpochMs: command.expireAtEpochMs,
              serverId: this.serviceId,
              requestedBy: command.requestedBy,
              requestedSessionId: command.requestedSessionId,
              categories: command.categories,
              expiredRows: read.expiredRows,
            }),
          ),
      result: {
        generatedAtEpochMs: command.capturedAtEpochMs,
        serverId: this.serviceId,
        warnings: [],
        operation: 'maintenance.prune-expired',
        status: command.dryRun ? 'dry-run' : 'queued',
        changed: false,
        jobId: command.jobId,
        results,
      },
    };
  }

  private validate(
    command: AdminPruneCommand,
    _read: AdminPruneRead,
    computed: AdminPruneComputed,
  ): void {
    if (computed.result.jobId !== command.jobId) {
      throw new TypeError('Admin prune computed identity differs from command');
    }
    if (computed.outboxEntries.length !== (command.dryRun ? 0 : command.categories.length)) {
      throw new TypeError('Admin prune computed category count is invalid');
    }
    if ((computed.aggregateEntry === null) !== command.dryRun) {
      throw new TypeError('Admin prune aggregate presence is invalid');
    }
  }

  private async waitForAggregate(
    jobId: string,
  ): Promise<Either<AppInboxFailure, AdminPruneEnqueueResult>> {
    try {
      const result = await tryWithPolicy(async () => {
        const entry = await this.resourceInboxResults.findByKey(toAdminPruneAggregateKey(jobId));
        if (!entry || entry.status !== EntityStatus.COMPLETED) {
          throw new Error('Admin prune aggregate is pending');
        }
        return toAdminPruneCompletedResult(decodeAdminPruneAggregate(JSON.parse(entry.resource)));
      }, this.aggregateWaitPolicy);
      return Either.ofRight(result);
    } catch (error) {
      if (error instanceof TryWithExhaustedError) {
        return Either.ofLeft(toUnavailableAppInboxFailure());
      }
      throw error;
    }
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Admin prune request must be an object');
  }
  return value as Record<string, unknown>;
}

function readCategories(value: unknown): readonly AdminPruneExpiredCategory[] {
  if (value === undefined) {
    return ADMIN_PRUNE_EXPIRED_CATEGORIES.filter((category) => category !== 'app-data');
  }
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('categories are invalid');
  const categories = value as readonly AdminPruneExpiredCategory[];
  if (categories.some((entry) => !ADMIN_PRUNE_EXPIRED_CATEGORIES.includes(entry))) {
    throw new TypeError('Admin prune category is invalid');
  }
  return [...new Set(categories)];
}

function readAppData(value: unknown): AdminPruneAppData | null {
  if (value === undefined || value === null) return null;
  const data = requireRecord(value);
  const namespace = readString(data.namespace);
  if (!namespace) throw new TypeError('appData.namespace is required');
  return { namespace, storeName: readString(data.storeName) };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('dryRun must be boolean');
  return value;
}
