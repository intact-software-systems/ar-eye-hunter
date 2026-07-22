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
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
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
export {
    createAppInboxRetryExhaustionHandler,
    createAppInboxRetryExhaustionRecoveryHandler,
} from './app-inbox-retry-finalization.ts';

export type AppInboxServiceOptions = Readonly<{
    phaseTiming?: boolean;
    waitMaxElapsedMsecs?: number;
    waitRetryIntervalMsecs?: number;
    waitMaxRetryIntervalMsecs?: number;
    waitJitterRatio?: number;
    nowEpochMs?: () => number;
}>;

type NormalizedAppInboxServiceOptions = Required<
    Omit<
    AppInboxServiceOptions,
    'nowEpochMs'
    >
>;

export class AppInboxService {
    public static readonly MAX_ELAPSED_MSECS = 10_000;
    public static readonly WAIT_RETRY_INTERVAL_MSECS = 500;
    public static readonly WAIT_MAX_RETRY_INTERVAL_MSECS = 20_000;
    public static readonly WAIT_JITTER_RATIO = 0.2;

    private readonly options: NormalizedAppInboxServiceOptions;
    private readonly optionsInput: AppInboxServiceOptions;
    private readonly transactionWriter: AppInboxTransactionWriter;

    constructor(
        public readonly inbox: InboxQueueReader,
        public readonly resourceInbox: ResourceInboxRepository,
        public readonly resourceInboxResults: ResourceInboxResultsRepository,
        protected readonly database: PSqlSql,
        public readonly serviceId: string,
        private readonly defaultTopicId: string = SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
        private readonly timing?: RallarTimingSink,
        options: AppInboxServiceOptions = {},
    ) {
        this.optionsInput = options;
        this.transactionWriter = new AppInboxTransactionWriter({
            database,
            serviceId,
            timing,
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
            waitJitterRatio: toRatio(
                options.waitJitterRatio,
                AppInboxService.WAIT_JITTER_RATIO,
            ),
        };
    }

    private async writeAppInboxResult(
        entry: ResourceEntry,
        status: EntityStatus.COMPLETED,
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

    public processEntryNoWaiting<V, R = V>(enqueue: AppInboxEnqueueInput<V>) {
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
            )
            .catch((err) => {
                console.error(`Error processing entry without waiting: ${err}`);
            });
    }

    // use this from client/group cleanup of expired
    public processEntryNoWaitingIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean,
    ) {
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
            )
            .catch((err) => {
                console.error(`Error processing entry without waiting: ${err}`);
            });
    }

    public async processEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): Promise<Either<string, R>> {
        const result = await this.processEntryUntilCompletionResult<V, R>(
            enqueue,
        );
        return result.mapLeft(toLegacyAppInboxFailure);
    }

    public async processEntryUntilCompletionResult<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
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
        );
    }

    public async processEntryUntilCompletionIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean,
    ): Promise<Either<string, R>> {
        const result = await this.processEntryUntilCompletionInternal<V, R>(
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
        );
        return result.mapLeft(toLegacyAppInboxFailure);
    }

    private async processEntryUntilCompletionInternal<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        waitForCompletion: boolean,
        enforceCommandIdentity: boolean,
        enqueuer: (
            key: Key,
            wireEnqueue: AppInboxEnqueueInput<V>,
        ) => Promise<ResourceEntry | undefined>,
    ): Promise<Either<AppInboxFailure, R>> {
        const wireEnqueue = toJsonWireAppInboxEnqueue(enqueue);
        const key: Key = this.toKey(wireEnqueue);
        const receivedCommandIdentity = enforceCommandIdentity
            ? serializeCanonicalJsonWire(
                toLogicalAppInboxCommand(wireEnqueue),
            )
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
                if (entry && enforceCommandIdentity) {
                    if (!receivedCommandIdentity) {
                        throw new Error('App inbox command identity was not captured');
                    }
                    await assertMatchingAppInboxCommand(
                        entry,
                        wireEnqueue,
                        receivedCommandIdentity,
                    );
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
                    async () => await this.findByKeyAndReturnEither<R>(key),
                );
            },
        );
    }

    private async findByKeyAndReturnEither<R>(
        key: Key,
    ): Promise<Either<AppInboxFailure, R>> {
        const result = await this.resourceInboxResults.findByKey(key);
        if (result === undefined) {
            return Either.ofLeft(toTerminalAppInboxFailure(
                Object.assign(new Error('App inbox entry result was not found'), {
                    status: 500,
                }),
                'app-inbox-result-not-found',
            ));
        }
        if (result.status === EntityStatus.FAILED) {
            return Either.ofLeft(readPersistedAppInboxFailure(result.resource));
        }
        if (result.status !== EntityStatus.COMPLETED) {
            return Either.ofLeft(toUnavailableAppInboxFailure());
        }

        return Either.ofRight(JSON.parse(result.resource) as R);
    }

    private async waitForCompletion<V>(
        enqueue: AppInboxEnqueueInput<V>,
        key: Key,
    ): Promise<boolean> {
        try {
            return await this.timePhase(
                'wait-completion',
                enqueue,
                key,
                async () =>
                    await tryWithPolicy<boolean>(
                    async () => {
                            const isCompleted = await this.resourceInbox.isEntryWithStatus(
                                key,
                                [
                                    EntityStatus.COMPLETED,
                                    EntityStatus.FAILED,
                                ],
                            );

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
        this.inbox.onInboxMessageDo(
            type,
            {
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
                                    throw new AppInboxCommandIdentityError(
                                        identity.identity.operationSource,
                                    );
                                }
                                const enqueue = identity.command as AppInboxEnqueueInput<V>;
                                context = { enqueue, message, entry };
                                this.transactionWriter.begin(context);
                                const result = await this.timePhase(
                                    'handler-action',
                                    enqueue,
                                    entry.key,
                                    async () => await handler(enqueue.data, context!),
                                );
                                const finalization = this.transactionWriter.read(context);
                                if (finalization.state === 'transaction-finalized') {
                                    return finalization.result;
                                }
                                await this.timePhase(
                                    'write-result',
                                    enqueue,
                                    entry.key,
                                    async () => {
                                        await this.writeAppInboxResult(
                                            entry,
                                            EntityStatus.COMPLETED,
                                            result,
                                        );
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
                                await this.writeTerminalFailure(
                                    terminalContext,
                                    classification.result,
                                );
                                throw new ResourceInboxFinalizedByHandlerError(
                                    toFinalizedResourceEntry(
                                        terminalContext,
                                        EntityStatus.FAILED,
                                        this.nowEpochMs(),
                                    ),
                                    error instanceof Error ? error : new Error(String(error)),
                                );
                            }
                        },
                    );
                },
            },
        );
    }

    private recordQueueRetryTiming<V>(
        enqueue: AppInboxEnqueueInput<V>,
        entry: ResourceEntry,
        classification: Extract<AppInboxErrorClassification, { kind: 'retryable' }>,
        error: unknown,
    ): void {
        recordRallarTiming(
            this.timing,
            {
                component: 'app-inbox-handler',
                operation: 'queue-retry',
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: {
                    ...this.toTimingDetails(enqueue, entry.key),
                    attempt: readResourceInboxAttemptTelemetry(entry)?.attempt ??
                        entry.dequeueAudit.attempts,
                    attempts: readResourceInboxAttemptTelemetry(entry)?.attempt ??
                        entry.dequeueAudit.attempts,
                    selectedLane: readResourceInboxAttemptTelemetry(entry)?.selectedLane,
                    queueAgeMs: readResourceInboxAttemptTelemetry(entry)?.queueAgeMs ??
                        toQueueAgeMs(entry, this.nowEpochMs()),
                    dueAgeMs: readResourceInboxAttemptTelemetry(entry)?.dueAgeMs ??
                        toDueAgeMs(entry, this.nowEpochMs()),
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

    private toWaitPolicy<V>(
        enqueue: AppInboxEnqueueInput<V>,
        key: Key,
    ): TryWithPolicy {
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
                            errorName: context.error instanceof Error
                                ? context.error.name
                                : undefined,
                            errorMessage: context.error instanceof Error
                                ? context.error.message
                                : String(context.error),
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

    private toTimingDetails<V>(
        enqueue: AppInboxEnqueueInput<V>,
        key: Key,
    ): RallarTimingDetails {
        return {
            type: enqueue.type,
            topicId: key.topicId,
            contextId: key.contextId,
            resourceId: key.resourceId,
            senderId: enqueue.senderId,
        };
    }

    private toMutationTimingDetails(
        context: AppInboxMessageContext,
    ): RallarTimingDetails {
        const nowEpochMs = this.nowEpochMs();
        return {
            ...this.toTimingDetails(context.enqueue, context.entry.key),
            attempt: context.entry.dequeueAudit.attempts,
            queueAgeMs: toQueueAgeMs(context.entry, nowEpochMs),
            dueAgeMs: toDueAgeMs(context.entry, nowEpochMs),
        };
    }

    protected nowEpochMs(): number {
        return this.optionsInput.nowEpochMs?.() ?? Date.now();
    }

    private toKey<V>(enqueue: AppInboxEnqueueInput<V>) {
        return toAppInboxQueueKey({
            topicId: enqueue.topicId ?? this.defaultTopicId,
            resourceId: enqueue.resourceId ?? crypto.randomUUID().toString(),
            contextId: enqueue.contextId ?? enqueue.senderId ?? 'rallar-server',
        });
    }
}

function toLegacyAppInboxFailure(failure: AppInboxFailure): string {
    if (failure.version === 'legacy-string.v0') {
        return failure.message;
    }
    if (failure.version === 'legacy-object.v0') {
        return JSON.stringify({
            error: failure.message,
            code: failure.code,
            message: failure.message,
            status: failure.status,
            ...(failure.denial?.details === null || failure.denial === null
                ? {}
                : { details: failure.denial.details }),
        });
    }
    if (failure.version === 'legacy-retry-exhausted.v0') {
        return JSON.stringify(failure.legacyWire);
    }
    if (failure.code === 'app-inbox-non-retryable') {
        return failure.message;
    }
    if (failure.denial !== null) {
        return JSON.stringify({
            error: failure.message.startsWith('Forbidden:')
                ? failure.message
                : `Forbidden: ${failure.denial.message}`,
            code: failure.denial.code,
            message: failure.denial.message,
            ...(failure.denial.details === null
                ? {}
                : { details: failure.denial.details }),
        });
    }
    if (failure.version === 'canonical.v1') {
        const { version: _version, ...persisted } = failure;
        return JSON.stringify(persisted);
    }
    return JSON.stringify(failure);
}

function toNonNegativeFiniteNumber(
    value: number | undefined,
    fallback: number,
): number {
    return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : value;
}

function toRatio(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.max(0, Math.min(1, value));
}

function toQueueAgeMs(
    entry: ResourceEntry,
    nowEpochMs: number = Date.now(),
): number | undefined {
    try {
        return Math.max(
            0,
            nowEpochMs -
                entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds,
        );
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
