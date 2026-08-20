import { ALMessage, newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import {
  EntityStatus,
  Key,
  ResourceEntry,
  toResourceEntryWithUpdatedResource,
} from '@shared/queuebox/ResourceEntry.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
  readResourceInboxAttemptTelemetry,
  ResourceInboxFinalizedByHandlerError,
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import { Either } from '@shared/resilience/Either.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '@shared/resilience/TryWith.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  type RallarTimingDetails,
  type RallarTimingSink,
  recordRallarTiming,
  timeRallarAsync,
} from './timing.ts';
import { toAppInboxQueueCreatedBy, toAppInboxQueueKey } from './app-inbox-queue-key.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxIdempotencyConflictError,
  type AppInboxMessageContext,
  AppInboxReservationConflictError,
  AppInboxType,
} from './app-inbox-contracts.ts';
import {
  type AppInboxErrorClassification,
  classifyAppInboxError,
  toAppInboxErrorCode,
} from './app-inbox-error-classification.ts';
import {
  AppInboxTransactionWriter,
  toFinalizedResourceEntry,
} from './app-inbox-transaction-writer.ts';
import {
  assertMatchingAppInboxCommand,
  serializeCanonicalJsonWire,
  toJsonWireAppInboxEnqueue,
  toLogicalAppInboxCommand,
} from './app-inbox-command-wire.ts';
import type { JsonWireValue } from './mutation-command-identity.ts';
import {
  AppInboxCommandIdentityError,
  validateAppInboxCommandIdentity,
} from './app-inbox-command-identity.ts';
import {
  type AppInboxFailure,
  readPersistedAppInboxFailure,
  toTerminalAppInboxFailure,
  toUnavailableAppInboxFailure,
} from './app-inbox-failure.ts';
import { toLegacyAppInboxFailure } from './app-inbox-legacy-failure.ts';

export const SIMPLER_GROUP_STATE_APP_INBOX_TOPIC = 'app-inbox.group-state';
export const SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC = 'app-inbox.client-state';

export {
  AppInboxIdempotencyConflictError,
  AppInboxReservationConflictError,
  AppInboxType,
  classifyAppInboxError,
  NonRetryableException,
};
export type {
  AppInboxEnqueueInput,
  AppInboxErrorClassification,
  AppInboxFailure,
  AppInboxMessageContext,
};

export type AppInboxResultDecoder<R> = (value: JsonWireValue) => R;
export {
  createAppInboxRetryExhaustionHandler,
  createAppInboxRetryExhaustionRecoveryHandler,
} from './app-inbox-retry-finalization.ts';

export interface AppInboxServiceOptions {
  readonly phaseTiming?: boolean;
  readonly waitMaxElapsedMsecs?: number;
  readonly waitRetryIntervalMsecs?: number;
  readonly waitMaxRetryIntervalMsecs?: number;
  readonly waitJitterRatio?: number;
  readonly nowEpochMs?: () => number;
  readonly timingNowEpochMs?: () => number;
}

interface NormalizedAppInboxServiceOptions {
  readonly phaseTiming: boolean;
  readonly waitMaxElapsedMsecs: number;
  readonly waitRetryIntervalMsecs: number;
  readonly waitMaxRetryIntervalMsecs: number;
  readonly waitJitterRatio: number;
}

export namespace AppInboxService {
  export interface InboxRepository {
    isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean>;
  }

  export interface ResultRepository {
    replace(entry: ResourceEntry): Promise<ResourceEntry>;
    findByKey(key: Key): Promise<ResourceEntry | undefined>;
  }

  export interface Dependencies {
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: InboxRepository;
    readonly resourceInboxResultsRepository: ResultRepository;
    readonly database: PSqlSql;
  }

  export interface Config {
    readonly serviceId: string;
    readonly defaultTopicId?: string;
    readonly timing?: RallarTimingSink;
    readonly options?: AppInboxServiceOptions;
    readonly wakeOwningQueue?: () => void;
  }
}

export class AppInboxService {
  public static readonly MAX_ELAPSED_MSECS = 10_000;
  public static readonly WAIT_RETRY_INTERVAL_MSECS = 500;
  public static readonly WAIT_MAX_RETRY_INTERVAL_MSECS = 20_000;
  public static readonly WAIT_JITTER_RATIO = 0.2;

  private readonly options: NormalizedAppInboxServiceOptions;
  private readonly optionsInput: AppInboxServiceOptions;
  protected readonly transactionWriter: AppInboxTransactionWriter;
  public readonly inbox: InboxQueueReader;
  public readonly resourceInbox: AppInboxService.InboxRepository;
  public readonly resourceInboxResults: AppInboxService.ResultRepository;
  protected readonly database: PSqlSql;
  public readonly serviceId: string;
  private readonly defaultTopicId: string;
  private readonly timing?: RallarTimingSink;
  private readonly wakeOwningQueue?: () => void;

  constructor(dependencies: AppInboxService.Dependencies, config: AppInboxService.Config) {
    const options = config.options ?? {};
    this.inbox = dependencies.inboxQueueReader;
    this.resourceInbox = dependencies.resourceInboxRepository;
    this.resourceInboxResults = dependencies.resourceInboxResultsRepository;
    this.database = dependencies.database;
    this.serviceId = config.serviceId;
    this.defaultTopicId = config.defaultTopicId ?? SIMPLER_GROUP_STATE_APP_INBOX_TOPIC;
    this.timing = config.timing;
    this.wakeOwningQueue = config.wakeOwningQueue;
    this.optionsInput = options;
    this.transactionWriter = new AppInboxTransactionWriter({
      database: dependencies.database,
      serviceId: config.serviceId,
      timing: config.timing,
      nowEpochMs: () => this.nowEpochMs(),
      toTimingDetails: (context) => this.toMutationTimingDetails(context),
    });
    this.options = {
      phaseTiming: options.phaseTiming ?? false,
      waitMaxElapsedMsecs: toNonNegativeFiniteNumber(
        options.waitMaxElapsedMsecs,
        AppInboxService.MAX_ELAPSED_MSECS,
      ),
      waitRetryIntervalMsecs: toNonNegativeFiniteNumber(
        options.waitRetryIntervalMsecs,
        AppInboxService.WAIT_RETRY_INTERVAL_MSECS,
      ),
      waitMaxRetryIntervalMsecs: toNonNegativeFiniteNumber(
        options.waitMaxRetryIntervalMsecs,
        AppInboxService.WAIT_MAX_RETRY_INTERVAL_MSECS,
      ),
      waitJitterRatio: toRatio(options.waitJitterRatio, AppInboxService.WAIT_JITTER_RATIO),
    };
  }
  private async writeAppInboxResult(
    entry: ResourceEntry,
    status: typeof EntityStatus.COMPLETED,
    value: unknown,
  ): Promise<void> {
    await this.resourceInboxResults.replace(
      toResourceEntryWithUpdatedResource(entry, status, value),
    );
  }
  protected async writeMutation<R>(
    context: AppInboxMessageContext,
    write: (transaction: PSqlTransactionSql) => Promise<R>,
  ): Promise<R> {
    return await this.transactionWriter.writeMutation(context, write);
  }

  protected async writeTerminalFailure(
    context: AppInboxMessageContext,
    error: unknown,
  ): Promise<void> {
    await this.transactionWriter.writeTerminalFailure(context, error);
  }

  protected async persistReservedEntryAuthority<Authority>(
    context: AppInboxMessageContext,
    authority: Authority,
  ): Promise<void> {
    const enqueue = toJsonWireAppInboxEnqueue({ ...context.enqueue, authority });
    const message: ALMessage = {
      ...context.message,
      payload: {
        ...context.message.payload,
        resource: JSON.stringify(enqueue),
      },
    };
    const replacement: ResourceEntry = {
      ...context.entry,
      resource: JSON.stringify(message),
    };
    const result = await this.inbox.inbox.enqueueOrUpdate(replacement, (existing) =>
      existing.status === EntityStatus.RESERVED &&
      existing.dequeueAudit.attempts === context.entry.dequeueAudit.attempts &&
      existing.resource === context.entry.resource
        ? replacement
        : undefined,
    );
    if (result.action !== 'updated') {
      throw new AppInboxReservationConflictError(context.entry.key);
    }
  }

  public processEntryNoWaiting<V>(enqueue: AppInboxEnqueueInput<V>): void {
    this.processEntryUntilCompletionInternal(
      enqueue,
      false,
      true,
      async (key, wireEnqueue) => {
        return await this.inbox.enqueueIfAbsent(
          newALUntargetedMessage(
            toAppInboxQueueCreatedBy(this.serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            wireEnqueue.type.toString(),
            wireEnqueue,
          ),
        );
      },
      decodeJsonWireResult,
    ).catch((err) => {
      console.error(`Error processing entry without waiting: ${err}`);
    });
  }

  public async enqueue<V>(enqueue: AppInboxEnqueueInput<V>): Promise<ResourceEntry> {
    const wireEnqueue = toJsonWireAppInboxEnqueue(enqueue);
    const key = this.toKey(wireEnqueue);
    const receivedIdentity = serializeCanonicalJsonWire(toLogicalAppInboxCommand(wireEnqueue));
    const entry = await this.inbox.enqueueIfAbsent(
      newALUntargetedMessage(
        toAppInboxQueueCreatedBy(this.serviceId),
        newALRoute(key.topicId, key.contextId, key.resourceId),
        wireEnqueue.type.toString(),
        wireEnqueue,
      ),
    );
    this.wakeOwningQueue?.();
    await assertMatchingAppInboxCommand(entry, wireEnqueue, receivedIdentity);
    return entry;
  }

  // use this from client/group cleanup of expired
  public processEntryNoWaitingIf<V>(
    enqueue: AppInboxEnqueueInput<V>,
    enqueueIf: (entry: ResourceEntry) => boolean,
  ): void {
    this.processEntryUntilCompletionInternal(
      enqueue,
      false,
      false,
      async (key, wireEnqueue) => {
        return await this.inbox.enqueueIf(
          newALUntargetedMessage(
            toAppInboxQueueCreatedBy(this.serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            wireEnqueue.type.toString(),
            wireEnqueue,
          ),
          enqueueIf,
        );
      },
      decodeJsonWireResult,
    ).catch((err) => {
      console.error(`Error processing entry without waiting: ${err}`);
    });
  }

  public async processEntryUntilCompletion<V>(
    enqueue: AppInboxEnqueueInput<V>,
  ): Promise<Either<string, JsonWireValue>> {
    const result = await this.processEntryUntilCompletionInternal(
      enqueue,
      true,
      true,
      async (key, wireEnqueue) => {
        return await this.inbox.enqueueIfAbsent(
          newALUntargetedMessage(
            toAppInboxQueueCreatedBy(this.serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            wireEnqueue.type.toString(),
            wireEnqueue,
          ),
        );
      },
      decodeJsonWireResult,
    );
    return result.mapLeft(toLegacyAppInboxFailure);
  }

  public async processEntryUntilCompletionResult<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
    decodeResult: AppInboxResultDecoder<R>,
  ): Promise<Either<AppInboxFailure, R>> {
    return await this.processEntryUntilCompletionInternal<V, R>(
      enqueue,
      true,
      true,
      async (key, wireEnqueue) => {
        return await this.inbox.enqueueIfAbsent(
          newALUntargetedMessage(
            toAppInboxQueueCreatedBy(this.serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            wireEnqueue.type.toString(),
            wireEnqueue,
          ),
        );
      },
      decodeResult,
    );
  }

  public async processEntryUntilCompletionIf<V>(
    enqueue: AppInboxEnqueueInput<V>,
    enqueueIf: (entry: ResourceEntry) => boolean,
  ): Promise<Either<string, JsonWireValue>> {
    const result = await this.processEntryUntilCompletionInternal(
      enqueue,
      true,
      false,
      async (key, wireEnqueue) => {
        return await this.inbox.enqueueIf(
          newALUntargetedMessage(
            toAppInboxQueueCreatedBy(this.serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            wireEnqueue.type.toString(),
            wireEnqueue,
          ),
          enqueueIf,
        );
      },
      decodeJsonWireResult,
    );
    return result.mapLeft(toLegacyAppInboxFailure);
  }

  protected async processEntryUntilCompletionIfResult<V, R>(
    enqueue: AppInboxEnqueueInput<V>,
    enqueueIf: (entry: ResourceEntry) => boolean,
    decodeResult: AppInboxResultDecoder<R>,
  ): Promise<Either<AppInboxFailure, R>> {
    return await this.processEntryUntilCompletionInternal(
      enqueue,
      true,
      false,
      async (key, wireEnqueue) => {
        return await this.inbox.enqueueIf(
          newALUntargetedMessage(
            toAppInboxQueueCreatedBy(this.serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            wireEnqueue.type.toString(),
            wireEnqueue,
          ),
          enqueueIf,
        );
      },
      decodeResult,
    );
  }

  private async processEntryUntilCompletionInternal<V, R = V>(
    enqueue: AppInboxEnqueueInput<V>,
    waitForCompletion: boolean,
    enforceCommandIdentity: boolean,
    enqueuer: (
      key: Key,
      wireEnqueue: AppInboxEnqueueInput<V>,
    ) => Promise<ResourceEntry | undefined>,
    decodeResult: AppInboxResultDecoder<R>,
  ): Promise<Either<AppInboxFailure, R>> {
    const wireEnqueue = toJsonWireAppInboxEnqueue(enqueue);
    const key: Key = this.toKey(wireEnqueue);
    const receivedCommandIdentity = enforceCommandIdentity
      ? serializeCanonicalJsonWire(toLogicalAppInboxCommand(wireEnqueue))
      : undefined;

    return await timeRallarAsync(
      this.timing,
      {
        component: 'app-inbox',
        operation: 'processEntryUntilCompletion',
        serviceId: this.serviceId,
        requestId: enqueue.resourceId,
        details: {
          type: enqueue.type,
          waitForCompletion,
          topicId: key.topicId,
          contextId: key.contextId,
          resourceId: key.resourceId,
          senderId: enqueue.senderId,
        },
      },
      async () => {
        const entry = await this.timePhase(
          'enqueue',
          enqueue,
          key,
          async () => await enqueuer(key, wireEnqueue),
        );
        if (entry) this.wakeOwningQueue?.();
        if (entry && enforceCommandIdentity) {
          if (!receivedCommandIdentity) {
            throw new Error('App inbox command identity was not captured');
          }
          await assertMatchingAppInboxCommand(entry, wireEnqueue, receivedCommandIdentity);
        }

        if (!waitForCompletion) {
          return Either.ofLeft(toUnavailableAppInboxFailure());
        }

        const isCompleted = await this.waitForCompletion(wireEnqueue, key);

        if (!isCompleted) {
          return Either.ofLeft(toUnavailableAppInboxFailure());
        }

        return await this.timePhase(
          'read-result',
          enqueue,
          key,
          async () => await this.findByKeyAndReturnEither(key, decodeResult),
        );
      },
    );
  }

  private async findByKeyAndReturnEither<R>(
    key: Key,
    decodeResult: AppInboxResultDecoder<R>,
  ): Promise<Either<AppInboxFailure, R>> {
    const result = await this.resourceInboxResults.findByKey(key);
    if (result === undefined) {
      return Either.ofLeft(
        toTerminalAppInboxFailure(
          Object.assign(new Error('App inbox entry result was not found'), {
            status: 500,
          }),
          'app-inbox-result-not-found',
        ),
      );
    }
    if (result.status === EntityStatus.FAILED) {
      return Either.ofLeft(readPersistedAppInboxFailure(result.resource));
    }
    if (result.status !== EntityStatus.COMPLETED) {
      return Either.ofLeft(toUnavailableAppInboxFailure());
    }

    try {
      const parsed: JsonWireValue = JSON.parse(result.resource);
      return Either.ofRight(decodeResult(parsed));
    } catch (error) {
      return Either.ofLeft(toTerminalAppInboxFailure(error, toAppInboxErrorCode(error)));
    }
  }

  private async waitForCompletion<V>(enqueue: AppInboxEnqueueInput<V>, key: Key): Promise<boolean> {
    try {
      return await this.timePhase(
        'wait-completion',
        enqueue,
        key,
        async () =>
          await tryWithPolicy<boolean>(
            async () => {
              const isCompleted = await this.resourceInbox.isEntryWithStatus(key, [
                EntityStatus.COMPLETED,
                EntityStatus.FAILED,
              ]);

              if (!isCompleted) {
                throw new Error('App inbox entry not found');
              }

              return true;
            },
            this.toWaitPolicy(enqueue, key),
          ),
        {
          waitMaxElapsedMsecs: this.options.waitMaxElapsedMsecs,
        },
      );
    } catch (error) {
      if (!(error instanceof TryWithExhaustedError)) {
        throw error;
      }

      recordRallarTiming(
        this.timing,
        {
          component: 'app-inbox-phase',
          operation: 'wait-fallback',
          serviceId: this.serviceId,
          requestId: enqueue.resourceId,
          details: {
            ...this.toTimingDetails(enqueue, key),
            attempt: error.context.attempt,
            elapsedMsecs: error.context.elapsedMsecs,
            waitMaxElapsedMsecs: this.options.waitMaxElapsedMsecs,
            errorName: error.name,
            errorMessage: error.message,
          },
        },
        'ok',
        0,
      );
      return false;
    }
  }

  onStateMessage<V>(
    type: AppInboxType,
    handler: (data: V, context: AppInboxMessageContext) => Promise<unknown>,
  ): void {
    this.inbox.onInboxMessageDo(type, {
      onMessage: async (message: ALMessage, entry: ResourceEntry) => {
        const fallbackEnqueue: AppInboxEnqueueInput<unknown> = {
          type,
          resourceId: entry.key.resourceId,
          contextId: entry.key.contextId,
          data: null,
        };
        let context: AppInboxMessageContext | undefined;

        await timeRallarAsync(
          this.timing,
          {
            component: 'app-inbox-handler',
            operation: String(type),
            serviceId: this.serviceId,
            requestId: entry.key.resourceId,
            details: {
              type,
              topicId: entry.key.topicId,
              contextId: entry.key.contextId,
              resourceId: entry.key.resourceId,
            },
          },
          async () => {
            try {
              const identity = validateAppInboxCommandIdentity(entry);
              if (!identity.valid) {
                throw new AppInboxCommandIdentityError(identity.identity.operationSource);
              }
              const enqueue = identity.command as AppInboxEnqueueInput<V>;
              const validatedContext = { enqueue, message, entry };
              context = validatedContext;
              this.transactionWriter.begin(validatedContext);
              const result = await this.timePhase(
                'handler-action',
                enqueue,
                entry.key,
                async () => await handler(enqueue.data, validatedContext),
              );
              const finalization = this.transactionWriter.read(validatedContext);
              if (finalization.state === 'transaction-finalized') {
                return finalization.result;
              }
              await this.timePhase(
                'write-result',
                enqueue,
                entry.key,
                async () => {
                  await this.writeAppInboxResult(entry, EntityStatus.COMPLETED, result);
                },
                { resultStatus: EntityStatus.COMPLETED },
              );
            } catch (error) {
              if (context) {
                const finalization = this.transactionWriter.read(context);
                if (
                  finalization.state === 'transaction-finalized' &&
                  finalization.status === EntityStatus.COMPLETED
                ) {
                  return finalization.result;
                }
              }
              const classification = classifyAppInboxError(error);
              if (classification.kind === 'retryable') {
                this.recordQueueRetryTiming(
                  context?.enqueue ?? fallbackEnqueue,
                  entry,
                  classification,
                  error,
                );
                throw error;
              }

              const terminalContext = context ?? {
                enqueue: fallbackEnqueue,
                message,
                entry,
              };
              await this.writeTerminalFailure(terminalContext, classification.result);
              throw new ResourceInboxFinalizedByHandlerError(
                toFinalizedResourceEntry(terminalContext, EntityStatus.FAILED, this.nowEpochMs()),
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          },
        );
      },
    });
  }

  private recordQueueRetryTiming<V>(
    enqueue: AppInboxEnqueueInput<V>,
    entry: ResourceEntry,
    classification: Extract<AppInboxErrorClassification, { kind: 'retryable' }>,
    error: unknown,
  ): void {
    const nowEpochMs = this.timingNowEpochMs();
    const telemetry = readResourceInboxAttemptTelemetry(entry);
    recordRallarTiming(
      this.timing,
      {
        component: 'app-inbox-handler',
        operation: 'queue-retry',
        serviceId: this.serviceId,
        requestId: enqueue.resourceId,
        details: {
          ...this.toTimingDetails(enqueue, entry.key),
          attempt: telemetry?.attempt ?? entry.dequeueAudit.attempts,
          attempts: telemetry?.attempt ?? entry.dequeueAudit.attempts,
          selectedLane: telemetry?.selectedLane,
          queueAgeMs: telemetry?.queueAgeMs ?? toQueueAgeMs(entry, nowEpochMs),
          dueAgeMs: telemetry?.dueAgeMs ?? toDueAgeMs(entry, nowEpochMs),
          classification: classification.kind,
          errorCode: classification.code,
          errorMessage: classification.message,
        },
      },
      'ok',
      0,
      error,
    );
  }

  private toWaitPolicy<V>(enqueue: AppInboxEnqueueInput<V>, key: Key): TryWithPolicy {
    let policy = TryWithPolicy.defaults()
      .label(`app-inbox:${key.topicId}:${key.resourceId}`)
      .maxElapsedMsecs(this.options.waitMaxElapsedMsecs)
      .retryIntervalMsecs(this.options.waitRetryIntervalMsecs)
      .maxRetryIntervalMsecs(this.options.waitMaxRetryIntervalMsecs)
      .jitterRatio(this.options.waitJitterRatio);

    if (this.options.phaseTiming) {
      policy = policy.onRetry((context) => {
        recordRallarTiming(
          this.timing,
          {
            component: 'app-inbox-phase',
            operation: 'wait-retry',
            serviceId: this.serviceId,
            requestId: enqueue.resourceId,
            details: {
              ...this.toTimingDetails(enqueue, key),
              attempt: context.attempt,
              nextAttempt: context.nextAttempt,
              delayMsecs: context.delayMsecs,
              elapsedMsecs: context.elapsedMsecs,
              errorName: context.error instanceof Error ? context.error.name : undefined,
              errorMessage:
                context.error instanceof Error ? context.error.message : String(context.error),
            },
          },
          'ok',
          0,
        );
      });
    }

    return policy;
  }

  private async timePhase<T, V>(
    operation: string,
    enqueue: AppInboxEnqueueInput<V>,
    key: Key,
    action: () => Promise<T>,
    details: RallarTimingDetails = {},
  ): Promise<T> {
    if (!this.options.phaseTiming) {
      return await action();
    }

    return await timeRallarAsync(
      this.timing,
      {
        component: 'app-inbox-phase',
        operation,
        serviceId: this.serviceId,
        requestId: enqueue.resourceId,
        details: {
          ...this.toTimingDetails(enqueue, key),
          ...details,
        },
      },
      action,
    );
  }

  private toTimingDetails<V>(enqueue: AppInboxEnqueueInput<V>, key: Key): RallarTimingDetails {
    return {
      type: enqueue.type,
      topicId: key.topicId,
      contextId: key.contextId,
      resourceId: key.resourceId,
      senderId: enqueue.senderId,
    };
  }
  private toMutationTimingDetails(context: AppInboxMessageContext): RallarTimingDetails {
    const nowEpochMs = this.timingNowEpochMs();
    const telemetry = readResourceInboxAttemptTelemetry(context.entry);
    return {
      ...this.toTimingDetails(context.enqueue, context.entry.key),
      attempt: telemetry?.attempt ?? context.entry.dequeueAudit.attempts,
      selectedLane: telemetry?.selectedLane,
      queueAgeMs: telemetry?.queueAgeMs ?? toQueueAgeMs(context.entry, nowEpochMs),
      dueAgeMs: telemetry?.dueAgeMs ?? toDueAgeMs(context.entry, nowEpochMs),
    };
  }
  protected nowEpochMs(): number {
    return this.optionsInput.nowEpochMs?.() ?? Date.now();
  }

  private timingNowEpochMs(): number {
    return this.optionsInput.timingNowEpochMs?.() ?? Date.now();
  }

  private toKey<V>(enqueue: AppInboxEnqueueInput<V>): Key {
    return toAppInboxQueueKey({
      topicId: enqueue.topicId ?? this.defaultTopicId,
      resourceId: enqueue.resourceId ?? crypto.randomUUID().toString(),
      contextId: enqueue.contextId ?? enqueue.senderId ?? 'rallar-server',
    });
  }
}

function toNonNegativeFiniteNumber(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : value;
}

function decodeJsonWireResult(value: JsonWireValue): JsonWireValue {
  return value;
}

function toRatio(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, value));
}

function toQueueAgeMs(entry: ResourceEntry, nowEpochMs: number = Date.now()): number | undefined {
  try {
    return Math.max(0, nowEpochMs - entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds);
  } catch {
    return undefined;
  }
}

function toDueAgeMs(entry: ResourceEntry, nowEpochMs: number): number {
  const dueAtEpochMs = entry.dequeueAudit.nextTs
    ? Number(entry.dequeueAudit.nextTs.epochMilliseconds)
    : Number(entry.dequeueAudit.startTs?.epochMilliseconds ?? nowEpochMs);
  return Math.max(0, nowEpochMs - dueAtEpochMs);
}
