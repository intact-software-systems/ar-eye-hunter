import type { AuthSession } from '@shared/api/api-config.ts';
import {
  ADMIN_PRUNE_EXPIRED_CATEGORIES,
  type AdminPruneExpiredCategory,
  type AdminPruneExpiredRequest,
} from '@shared/api/admin-operations-types.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '@shared/resilience/TryWith.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
// prettier-ignore
import {
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
// prettier-ignore
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
  type AdminPruneCommand,
  createAdminPruneCommand,
  decodeAdminPruneCommand,
  toAdminPruneOutbox,
} from '../AdminPruneExpiredWork.ts';
import type { AdminOperationsPruner } from '../AdminOperationsService.ts';
import { toAdminPruneExpiredOptions } from '../admin-prune-options.ts';
import {
  createAdminPruneAggregate,
  decodeAdminPruneAggregate,
  toAdminPruneAggregateEntry,
  toAdminPruneAggregateKey,
  toAdminPruneCompletedResult,
} from '../admin-prune-progress.ts';
import type { AppInboxFailure } from '../../services/app-inbox-failure.ts';
import {
  readPersistedAppInboxFailure,
  toUnavailableAppInboxFailure,
} from '../../services/app-inbox-failure.ts';
import {
  AppInboxIdempotencyConflictError,
  AppInboxService,
  type AppInboxServiceOptions,
} from '../../services/AppInboxService.ts';
// prettier-ignore
import { type AppInboxMessageContext, AppInboxType } from '../../services/app-inbox-contracts.ts';
// prettier-ignore
import {
  validatePersistedAppInboxCommandIdentity,
} from '../../services/app-inbox-command-identity.ts';
import {
  type RallarTimingSink,
  recordRallarTiming,
  timeRallarAsync,
} from '../../services/timing.ts';
import {
  type AdminPruneEnqueueResult,
  decodeAdminPruneEnqueueResult,
  decodeAdminPruneRequest,
} from './admin-prune-inbox-codec.ts';
import {
  ADMIN_APP_INBOX_TOPIC,
  type AdminPruneIdempotencyIdentity,
  type AdminPruneIdempotencyIdentityInput,
  type AdminPruneTimingIdentity,
  assertAdminPruneQueueIdentity,
  assertAdminPruneStoredIdentity,
  assertMatchingAdminPruneIdentity,
  toAdminPruneQueueKey,
  toAdminPruneTimingIdentity,
} from './admin-prune-inbox-identity.ts';
import {
  type AdminPruneValidationIssue,
  throwOnAdminPruneValidationIssues,
} from './admin-prune-inbox-validation.ts';

export type { AdminPruneEnqueueResult } from './admin-prune-inbox-codec.ts';
export {
  ADMIN_APP_INBOX_TOPIC,
  createAdminPruneIdempotencyIdentity,
} from './admin-prune-inbox-identity.ts';
export type {
  AdminPruneIdempotencyIdentity,
  AdminPruneIdempotencyIdentityInput,
} from './admin-prune-inbox-identity.ts';

export interface AdminPruneAuthorityReaderInput {
  readonly requestedBy: string;
  readonly requestedSessionId: string;
  readonly nowEpochMs: number;
}

export interface AdminPruneAuthority {
  readonly allowed: boolean;
  readonly code: string;
}

export type AdminPruneAuthorityReader = (
  input: AdminPruneAuthorityReaderInput,
) => Promise<AdminPruneAuthority>;

export interface AppAdminInboxServiceDependencies {
  readonly inboxQueueReader: InboxQueueReader;
  readonly resourceInboxRepository: AppInboxService.InboxRepository;
  readonly resourceInboxResultsRepository: AppInboxService.ResultRepository;
  readonly database: PSqlSql;
  readonly pruner: Pick<AdminOperationsPruner, 'countExpired'>;
  readonly readAuthority: AdminPruneAuthorityReader;
  readonly wakeQueueEngine: () => void;
  readonly computeRetryExpiryAtEpochMs: (capturedAtEpochMs: number) => number;
  readonly createAdminPruneIdempotencyIdentity: (
    input: AdminPruneIdempotencyIdentityInput,
  ) => Promise<AdminPruneIdempotencyIdentity>;
}

export interface AppAdminInboxServiceConfig {
  readonly serviceId: string;
  readonly pageSize: number;
  readonly timing?: RallarTimingSink;
  readonly appInbox: AppInboxServiceOptions;
}

interface AdminPruneRead {
  readonly command: AdminPruneCommand;
  readonly expiredRows: Readonly<Record<AdminPruneExpiredCategory, number>>;
  readonly authority: AdminPruneAuthority;
  readonly nowEpochMs: number;
}

interface AdminPruneComputed {
  readonly read: AdminPruneRead;
  readonly result: AdminPruneEnqueueResult;
  readonly outboxEntries: readonly ResourceEntry[];
  readonly aggregateEntry: ResourceEntry | null;
}

export class AppAdminInboxService extends AppInboxService {
  private readonly dependencies: AppAdminInboxServiceDependencies;
  private readonly config: AppAdminInboxServiceConfig;
  private readonly aggregateWaitPolicy: TryWithPolicy;
  private readonly resultWaitPolicy: TryWithPolicy;

  constructor(dependencies: AppAdminInboxServiceDependencies, config: AppAdminInboxServiceConfig) {
    super(
      {
        inboxQueueReader: dependencies.inboxQueueReader,
        resourceInboxRepository: dependencies.resourceInboxRepository,
        resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
        database: dependencies.database,
      },
      {
        serviceId: config.serviceId,
        defaultTopicId: ADMIN_APP_INBOX_TOPIC,
        timing: config.timing,
        options: config.appInbox,
        wakeOwningQueue: dependencies.wakeQueueEngine,
      },
    );
    this.dependencies = dependencies;
    this.config = config;
    this.aggregateWaitPolicy = createWaitPolicy('app-inbox:admin-prune-aggregate', config.appInbox);
    this.resultWaitPolicy = createWaitPolicy('app-inbox:admin-prune-result', config.appInbox);
    this.onStateMessage<AdminPruneCommand>(
      AppInboxType.ADMIN_PRUNE_EXPIRED,
      async (value, context) => await this.processCommand(value, context),
    );
  }

  async pruneExpired(
    input: Readonly<{ adminSession: AuthSession; request: AdminPruneExpiredRequest }>,
  ): Promise<Either<AppInboxFailure, AdminPruneEnqueueResult>> {
    const normalizedRequest = decodeAdminPruneRequest(input.request);
    const identity = await this.dependencies.createAdminPruneIdempotencyIdentity({
      requestId: normalizedRequest.requestId,
      requestedBy: input.adminSession.clientId,
      requestedSessionId: input.adminSession.sessionId,
      categories: normalizedRequest.categories,
      appData: normalizedRequest.appData,
      dryRun: normalizedRequest.dryRun,
    });
    this.recordPhase('semantic-identity', identity, {
      semanticHash: identity.semanticHash,
    });

    const key = toAdminPruneQueueKey(identity);
    const durableCommand = await this.timeAdminPrunePhase(
      'durable-command-read',
      identity,
      async () => await this.readDurableCommand(key),
    );
    if (durableCommand !== undefined) {
      assertMatchingAdminPruneIdentity(identity, durableCommand);
      return await this.readDurableCommandResult(durableCommand, key);
    }

    const capturedAtEpochMs = this.nowEpochMs();
    const command = await createAdminPruneCommand({
      jobId: identity.requestId,
      requestedBy: identity.requestedBy,
      requestedSessionId: identity.requestedSessionId,
      capturedAtEpochMs,
      expireAtEpochMs: this.dependencies.computeRetryExpiryAtEpochMs(capturedAtEpochMs),
      dryRun: identity.dryRun,
      categories: identity.categories,
      appData: identity.appData,
      pageSize: this.config.pageSize,
    });

    try {
      const enqueued = await this.processEntryUntilCompletionResult<
        AdminPruneCommand,
        AdminPruneEnqueueResult
      >(
        {
          type: AppInboxType.ADMIN_PRUNE_EXPIRED,
          topicId: ADMIN_APP_INBOX_TOPIC,
          resourceId: command.jobId,
          contextId: command.requestedBy,
          senderId: command.requestedSessionId,
          data: command,
        },
        decodeAdminPruneEnqueueResult,
      );
      return await this.toCallerResult(command, enqueued);
    } catch (error) {
      if (!(error instanceof AppInboxIdempotencyConflictError)) {
        throw error;
      }
      const winner = await this.readDurableCommand(key);
      if (winner === undefined) {
        throw error;
      }
      assertMatchingAdminPruneIdentity(identity, winner);
      return await this.readDurableCommandResult(winner, key);
    }
  }

  private async processCommand(
    value: AdminPruneCommand,
    context: AppInboxMessageContext,
  ): Promise<AdminPruneEnqueueResult> {
    const command = decodeAdminPruneCommand(value);
    assertAdminPruneQueueIdentity(command, context);

    const read = await this.timeAdminPrunePhase(
      'read',
      command,
      async () => await this.read(command),
    );
    const computed = await this.timeAdminPrunePhase('compute', command, () =>
      Promise.resolve(this.compute(read)),
    );
    const issues = await this.timeAdminPrunePhase('validate', command, () =>
      Promise.resolve(this.validate(computed)),
    );
    throwOnAdminPruneValidationIssues(issues);

    const result = await this.writeMutation(context, async (transaction) => {
      const outbox = new ResourceInboxRepository(transaction);
      for (const entry of computed.outboxEntries) {
        await outbox.writeIfAbsentOrMatch(entry);
      }
      if (computed.aggregateEntry !== null) {
        const stored = await new ResourceInboxResultsRepository(
          transaction,
        ).writeIfAbsentOrReplaceExpired(computed.aggregateEntry);
        if (stored.resource !== computed.aggregateEntry.resource) {
          throw new Error('Admin prune aggregate collides with an active job');
        }
      }
      return computed.result;
    });
    if (!command.dryRun) {
      this.dependencies.wakeQueueEngine();
    }
    return result;
  }

  private async read(command: AdminPruneCommand): Promise<AdminPruneRead> {
    const nowEpochMs = this.nowEpochMs();
    const countPairs = ADMIN_PRUNE_EXPIRED_CATEGORIES.map(async (category) => {
      const count = command.categories.includes(category)
        ? await this.dependencies.pruner.countExpired(category, toAdminPruneExpiredOptions(command))
        : 0;
      return [category, count] as const;
    });
    const [pairs, authority] = await Promise.all([
      Promise.all(countPairs),
      this.dependencies.readAuthority({
        requestedBy: command.requestedBy,
        requestedSessionId: command.requestedSessionId,
        nowEpochMs,
      }),
    ]);
    const expiredRows: Record<AdminPruneExpiredCategory, number> = {
      'runtime-state': 0,
      'resource-inbox': 0,
      'resource-inbox-results': 0,
      'app-data': 0,
    };
    for (const [category, count] of pairs) {
      expiredRows[category] = count;
    }
    return { command, expiredRows, authority, nowEpochMs };
  }

  private compute(read: AdminPruneRead): AdminPruneComputed {
    const command = read.command;
    const results = command.categories.map((category) => ({
      category,
      expiredRows: read.expiredRows[category],
      deletedRows: 0,
      dryRun: command.dryRun,
    }));
    return {
      read,
      outboxEntries: createInitialAdminPrunePages(command, this.serviceId),
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

  private validate(computed: AdminPruneComputed): readonly AdminPruneValidationIssue[] {
    const { command } = computed.read;
    const issues: AdminPruneValidationIssue[] = [];
    if (!computed.read.authority.allowed || command.expireAtEpochMs <= computed.read.nowEpochMs) {
      issues.push({
        code: 'admin-prune-authority-denied',
        message: 'Admin prune current authority is denied',
        status: 403,
      });
    }
    if (computed.result.jobId !== command.jobId) {
      issues.push({
        code: 'admin-prune-computed-identity-invalid',
        message: 'Admin prune computed identity differs from command',
        status: 400,
      });
    }
    if (computed.outboxEntries.length !== (command.dryRun ? 0 : command.categories.length)) {
      issues.push({
        code: 'admin-prune-computed-category-count-invalid',
        message: 'Admin prune computed category count is invalid',
        status: 400,
      });
    }
    if ((computed.aggregateEntry === null) !== command.dryRun) {
      issues.push({
        code: 'admin-prune-aggregate-presence-invalid',
        message: 'Admin prune aggregate presence is invalid',
        status: 400,
      });
    }
    return issues;
  }

  private async readDurableCommand(key: Key): Promise<AdminPruneCommand | undefined> {
    const entry = await this.inbox.inbox.getItem(key);
    if (entry === undefined) {
      return undefined;
    }
    const validation = validatePersistedAppInboxCommandIdentity({
      topicId: entry.key.topicId,
      resource: entry.resource,
    });
    if (!validation.valid || validation.identity.operation !== AppInboxType.ADMIN_PRUNE_EXPIRED) {
      throw new AppInboxIdempotencyConflictError(
        key.resourceId,
        'invalid-existing-command',
        'invalid-received-command',
      );
    }
    const command = decodeAdminPruneCommand(validation.command.data);
    assertAdminPruneStoredIdentity(key, validation.command, command);
    return command;
  }

  private async readDurableCommandResult(
    command: AdminPruneCommand,
    key: Key,
  ): Promise<Either<AppInboxFailure, AdminPruneEnqueueResult>> {
    try {
      await tryWithPolicy(async () => {
        if (
          !(await this.resourceInbox.isEntryWithStatus(key, [
            EntityStatus.COMPLETED,
            EntityStatus.FAILED,
          ]))
        ) {
          throw new Error('Admin prune AppInbox result is pending');
        }
      }, this.resultWaitPolicy);
    } catch (error) {
      if (error instanceof TryWithExhaustedError) {
        return Either.ofLeft(toUnavailableAppInboxFailure());
      }
      throw error;
    }

    const resultEntry = await this.resourceInboxResults.findByKey(key);
    if (resultEntry === undefined) {
      return Either.ofLeft(toUnavailableAppInboxFailure());
    }
    if (resultEntry.status === EntityStatus.FAILED) {
      return Either.ofLeft(readPersistedAppInboxFailure(resultEntry.resource));
    }
    if (resultEntry.status !== EntityStatus.COMPLETED) {
      return Either.ofLeft(toUnavailableAppInboxFailure());
    }
    const result = decodeAdminPruneEnqueueResult(JSON.parse(resultEntry.resource));
    return await this.toCallerResult(command, Either.ofRight(result));
  }

  private async toCallerResult(
    command: AdminPruneCommand,
    result: Either<AppInboxFailure, AdminPruneEnqueueResult>,
  ): Promise<Either<AppInboxFailure, AdminPruneEnqueueResult>> {
    if (result.left !== undefined || command.dryRun) {
      return result;
    }
    return await this.waitForAggregate(command.jobId);
  }

  private async waitForAggregate(
    jobId: string,
  ): Promise<Either<AppInboxFailure, AdminPruneEnqueueResult>> {
    try {
      const result = await tryWithPolicy(async () => {
        const entry = await this.resourceInboxResults.findByKey(toAdminPruneAggregateKey(jobId));
        if (entry === undefined || entry.status !== EntityStatus.COMPLETED) {
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

  private async timeAdminPrunePhase<T>(
    operation: string,
    identity: AdminPruneTimingIdentity | AdminPruneCommand,
    action: () => Promise<T>,
  ): Promise<T> {
    const timingIdentity = toAdminPruneTimingIdentity(identity);
    return await timeRallarAsync(
      this.config.timing,
      {
        component: 'admin-prune-inbox',
        operation,
        serviceId: this.serviceId,
        requestId: timingIdentity.requestId,
        principalId: timingIdentity.requestedBy,
        sessionId: timingIdentity.requestedSessionId,
      },
      action,
    );
  }

  private recordPhase(
    operation: string,
    identity: Pick<
      AdminPruneIdempotencyIdentityInput,
      'requestId' | 'requestedBy' | 'requestedSessionId'
    >,
    details: Readonly<Record<string, string | number | boolean | undefined>>,
  ): void {
    recordRallarTiming(
      this.config.timing,
      {
        component: 'admin-prune-inbox',
        operation,
        serviceId: this.serviceId,
        requestId: identity.requestId,
        principalId: identity.requestedBy,
        sessionId: identity.requestedSessionId,
        details,
      },
      'ok',
      0,
    );
  }
}

function createWaitPolicy(label: string, options: AppInboxServiceOptions): TryWithPolicy {
  return TryWithPolicy.defaults()
    .label(label)
    .maxElapsedMsecs(options.waitMaxElapsedMsecs ?? AppInboxService.MAX_ELAPSED_MSECS)
    .retryIntervalMsecs(options.waitRetryIntervalMsecs ?? AppInboxService.WAIT_RETRY_INTERVAL_MSECS)
    .maxRetryIntervalMsecs(
      options.waitMaxRetryIntervalMsecs ?? AppInboxService.WAIT_MAX_RETRY_INTERVAL_MSECS,
    )
    .jitterRatio(options.waitJitterRatio ?? AppInboxService.WAIT_JITTER_RATIO);
}

function createInitialAdminPrunePages(
  command: AdminPruneCommand,
  serviceId: string,
): readonly ResourceEntry[] {
  if (command.dryRun) {
    return [];
  }
  return command.categories.map((category) =>
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
      serviceId,
    ),
  );
}
