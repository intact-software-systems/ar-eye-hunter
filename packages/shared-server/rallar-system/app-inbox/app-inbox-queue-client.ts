import { ALMessage, newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import {
    toAppQueueCreatedBy as toAppInboxQueueCreatedBy,
    toAppQueueKey as toAppInboxQueueKey,
    toStrictAppInboxQueueKey
} from '@shared/queuebox/AppQueueIdentity.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '@shared/resilience/TryWith.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { validateAppInboxCommandIdentity } from '../app-inbox/app-inbox-command-identity.ts';
import {
    AppInboxIdempotencyConflictError,
    AppInboxReservationConflictError,
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from '../app-inbox/app-inbox-contracts.ts';
import {
    classifyAppInboxError,
    type AppInboxErrorClassification
} from '../app-inbox/app-inbox-error-classification.ts';
import {
    toTerminalAppInboxFailure,
    toUnavailableAppInboxFailure,
    type AppInboxFailure
} from '../app-inbox/app-inbox-failure.ts';
import {
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink
} from '../observability/timing.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { serializeCanonicalJsonWire, toJsonWireAppInboxEnqueue } from './app-inbox-command-wire.ts';
import { decodePersistedAppInboxFailure } from './app-inbox-failure-decoding.ts';
import { assertMatchingAppInboxCommand } from './assert-matching-app-inbox-command.ts';
import { toLogicalAppInboxCommand } from './logical-app-inbox-command.ts';

export const SIMPLER_GROUP_STATE_APP_INBOX_TOPIC = 'app-inbox.group-state';
export const SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC = 'app-inbox.client-state';

export {
    AppInboxIdempotencyConflictError,
    AppInboxReservationConflictError,
    AppInboxType,
    classifyAppInboxError,
    NonRetryableException
};
export type {
    AppInboxEnqueueInput,
    AppInboxErrorClassification,
    AppInboxFailure,
    AppInboxMessageContext
};

export type AppInboxResultDecoder<R> = (value: JsonWireValue) => R;
export {
    createAppInboxRetryExhaustionHandler,
    createAppInboxRetryExhaustionRecoveryHandler
} from '../app-inbox/app-inbox-retry-finalization.ts';

export interface AppInboxOptions {
    readonly phaseTiming?: boolean;
    readonly waitMaxElapsedMsecs?: number;
    readonly waitRetryIntervalMsecs?: number;
    readonly waitMaxRetryIntervalMsecs?: number;
    readonly waitJitterRatio?: number;
    readonly nowEpochMs?: () => number;
    readonly timingNowEpochMs?: () => number;
}

interface NormalizedAppInboxOptions {
    readonly phaseTiming: boolean;
    readonly waitMaxElapsedMsecs: number;
    readonly waitRetryIntervalMsecs: number;
    readonly waitMaxRetryIntervalMsecs: number;
    readonly waitJitterRatio: number;
}

export namespace AppInboxQueueClient {
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
    }

    export interface Config {
        readonly serviceId: string;
        readonly defaultTopicId?: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
    }
}

interface MaterializedAppInboxRepository {
    writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry>;
}

interface MaterializedAppInboxReservation<V> {
    readonly enqueue: AppInboxEnqueueInput<V>;
    readonly winner: boolean;
}

export class AppInboxQueueClient {
    public static readonly MAX_ELAPSED_MSECS = 10_000;
    public static readonly WAIT_RETRY_INTERVAL_MSECS = 500;
    public static readonly WAIT_MAX_RETRY_INTERVAL_MSECS = 20_000;
    public static readonly WAIT_JITTER_RATIO = 0.2;

    private readonly options: NormalizedAppInboxOptions;
    private readonly optionsInput: AppInboxOptions;
    public readonly inbox: InboxQueueReader;
    public readonly resourceInbox: AppInboxQueueClient.InboxRepository;
    public readonly resourceInboxResults: AppInboxQueueClient.ResultRepository;
    public readonly serviceId: string;
    private readonly defaultTopicId: string;
    private readonly timing?: RallarTimingSink;
    private readonly wakeOwningQueue?: () => void;

    constructor(dependencies: AppInboxQueueClient.Dependencies, config: AppInboxQueueClient.Config) {
        const options = config.options ?? {};
        this.inbox = dependencies.inboxQueueReader;
        this.resourceInbox = dependencies.resourceInboxRepository;
        this.resourceInboxResults = dependencies.resourceInboxResultsRepository;
        this.serviceId = config.serviceId;
        this.defaultTopicId = config.defaultTopicId ?? SIMPLER_GROUP_STATE_APP_INBOX_TOPIC;
        this.timing = config.timing;
        this.wakeOwningQueue = config.wakeOwningQueue;
        this.optionsInput = options;
        this.options = {
            phaseTiming: options.phaseTiming ?? false,
            waitMaxElapsedMsecs: toNonNegativeFiniteNumber(
                options.waitMaxElapsedMsecs,
                AppInboxQueueClient.MAX_ELAPSED_MSECS
            ),
            waitRetryIntervalMsecs: toNonNegativeFiniteNumber(
                options.waitRetryIntervalMsecs,
                AppInboxQueueClient.WAIT_RETRY_INTERVAL_MSECS
            ),
            waitMaxRetryIntervalMsecs: toNonNegativeFiniteNumber(
                options.waitMaxRetryIntervalMsecs,
                AppInboxQueueClient.WAIT_MAX_RETRY_INTERVAL_MSECS
            ),
            waitJitterRatio: toRatio(options.waitJitterRatio, AppInboxQueueClient.WAIT_JITTER_RATIO)
        };
    }
    async persistReservedEntryAuthority<Authority>(
        context: AppInboxMessageContext,
        authority: Authority
    ): Promise<void> {
        const enqueue = toJsonWireAppInboxEnqueue({ ...context.enqueue, authority });
        const message: ALMessage = {
            ...context.message,
            payload: {
                ...context.message.payload,
                resource: JSON.stringify(enqueue)
            }
        };
        const replacement: ResourceEntry = {
            ...context.entry,
            resource: JSON.stringify(message)
        };
        const result = await this.inbox.inbox.enqueueOrUpdate(
            replacement,
            (existing) =>
                existing.status === EntityStatus.RESERVED &&
                    existing.dequeueAudit.attempts === context.entry.dequeueAudit.attempts &&
                    existing.resource === context.entry.resource
                    ? replacement
                    : undefined
        );
        if (result.action !== 'updated') {
            throw new AppInboxReservationConflictError(context.entry.key);
        }
    }

    async reserveMaterializedEntry<V>(
        placeholder: AppInboxEnqueueInput<null>,
        materialize: () => Promise<AppInboxEnqueueInput<V>>
    ): Promise<MaterializedAppInboxReservation<V>> {
        if (!isMaterializedAppInboxRepository(this.resourceInbox)) {
            throw new Error('App inbox repository does not support atomic fact materialization');
        }
        let winner = false;
        const entry = await this.resourceInbox.writeMaterializedIfAbsentOrReplaceExpired(
            toAppInboxResourceEntry(placeholder, `${this.serviceId}:fact-reservation`),
            async () => {
                winner = true;
                return toAppInboxResourceEntry(await materialize(), this.serviceId);
            }
        );
        const validation = validateAppInboxCommandIdentity(entry);
        if (!validation.valid) {
            throw new AppInboxIdempotencyConflictError(
                entry.key.resourceId,
                'invalid-existing-command',
                'invalid-received-command'
            );
        }
        return {
            enqueue: validation.command as AppInboxEnqueueInput<V>,
            winner
        };
    }

    async waitForReservedEntryResult<V, R>(
        enqueue: AppInboxEnqueueInput<V>,
        decodeResult: AppInboxResultDecoder<R>,
        wakeOwningQueue: boolean
    ): Promise<Either<AppInboxFailure, R>> {
        if (wakeOwningQueue) {
            this.wakeOwningQueue?.();
        }
        return await this.processEntryUntilCompletionInternal(
            enqueue,
            true,
            false,
            () => Promise.resolve(undefined),
            decodeResult,
            true
        );
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
                        wireEnqueue
                    )
                );
            },
            decodeJsonWireResult
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
                wireEnqueue
            )
        );
        this.wakeOwningQueue?.();
        await assertMatchingAppInboxCommand(entry, wireEnqueue, receivedIdentity);
        return entry;
    }

    // use this from client/group cleanup of expired
    public processEntryNoWaitingIf<V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean
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
                        wireEnqueue
                    ),
                    enqueueIf
                );
            },
            decodeJsonWireResult
        ).catch((err) => {
            console.error(`Error processing entry without waiting: ${err}`);
        });
    }

    public async processEntryUntilCompletion<V>(
        enqueue: AppInboxEnqueueInput<V>
    ): Promise<Either<AppInboxFailure, JsonWireValue>> {
        return await this.processEntryUntilCompletionInternal(
            enqueue,
            true,
            true,
            async (key, wireEnqueue) => {
                return await this.inbox.enqueueIfAbsent(
                    newALUntargetedMessage(
                        toAppInboxQueueCreatedBy(this.serviceId),
                        newALRoute(key.topicId, key.contextId, key.resourceId),
                        wireEnqueue.type.toString(),
                        wireEnqueue
                    )
                );
            },
            decodeJsonWireResult
        );
    }

    public async processEntryUntilCompletionResult<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        decodeResult: AppInboxResultDecoder<R>
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
                        wireEnqueue
                    )
                );
            },
            decodeResult
        );
    }

    public async processEntryUntilCompletionIf<V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean
    ): Promise<Either<AppInboxFailure, JsonWireValue>> {
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
                        wireEnqueue
                    ),
                    enqueueIf
                );
            },
            decodeJsonWireResult
        );
    }

    async processEntryUntilCompletionIfResult<V, R>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean,
        decodeResult: AppInboxResultDecoder<R>
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
                        wireEnqueue
                    ),
                    enqueueIf
                );
            },
            decodeResult
        );
    }

    private async processEntryUntilCompletionInternal<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        waitForCompletion: boolean,
        enforceCommandIdentity: boolean,
        enqueuer: (
            key: Key,
            wireEnqueue: AppInboxEnqueueInput<V>
        ) => Promise<ResourceEntry | undefined>,
        decodeResult: AppInboxResultDecoder<R>,
        strictQueueIdentity = false
    ): Promise<Either<AppInboxFailure, R>> {
        const wireEnqueue = toJsonWireAppInboxEnqueue(enqueue);
        const key: Key = this.toKey(wireEnqueue, strictQueueIdentity);
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
                    senderId: enqueue.senderId
                }
            },
            async () => {
                const entry = await this.timePhase(
                    'enqueue',
                    enqueue,
                    key,
                    async () => await enqueuer(key, wireEnqueue)
                );
                if (entry) {
                    this.wakeOwningQueue?.();
                }
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
                    async () => await this.findByKeyAndReturnEither(key, decodeResult)
                );
            }
        );
    }

    private async findByKeyAndReturnEither<R>(
        key: Key,
        decodeResult: AppInboxResultDecoder<R>
    ): Promise<Either<AppInboxFailure, R>> {
        const result = await this.resourceInboxResults.findByKey(key);
        if (result === undefined) {
            return Either.ofLeft(
                toTerminalAppInboxFailure(
                    {
                        code: 'app-inbox-result-not-found',
                        status: 500,
                        message: 'App inbox entry result was not found'
                    }
                )
            );
        }
        if (result.status === EntityStatus.FAILED) {
            return Either.ofLeft(decodePersistedAppInboxFailure(result.resource));
        }
        if (result.status !== EntityStatus.COMPLETED) {
            return Either.ofLeft(toUnavailableAppInboxFailure());
        }

        try {
            const parsed = decodeJsonWireValue(
                JSON.parse(result.resource),
                'Persisted AppInbox result'
            );
            return Either.ofRight(decodeResult(parsed));
        }
        catch {
            return Either.ofLeft(toTerminalAppInboxFailure({
                code: 'app-inbox-result-corrupt',
                status: 500,
                message: 'Persisted AppInbox result is corrupt'
            }));
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
                                EntityStatus.FAILED
                            ]);

                            if (!isCompleted) {
                                throw new Error('App inbox entry not found');
                            }

                            return true;
                        },
                        this.toWaitPolicy(enqueue, key)
                    ),
                {
                    waitMaxElapsedMsecs: this.options.waitMaxElapsedMsecs
                }
            );
        }
        catch (error) {
            if (!(error instanceof TryWithExhaustedError)) {
                throw error;
            }

            recordRallarTiming({
                sink: this.timing,
                event: {
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
                        errorMessage: error.message
                    }
                },
                status: 'ok',
                durationMs: 0
            });
            return false;
        }
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
                recordRallarTiming({
                    sink: this.timing,
                    event: {
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
                            errorMessage: context.error instanceof Error ? context.error.message : String(context.error)
                        }
                    },
                    status: 'ok',
                    durationMs: 0
                });
            });
        }

        return policy;
    }

    private async timePhase<T, V>(
        operation: string,
        enqueue: AppInboxEnqueueInput<V>,
        key: Key,
        action: () => Promise<T>,
        details: RallarTimingDetails = {}
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
                    ...details
                }
            },
            action
        );
    }

    private toTimingDetails<V>(enqueue: AppInboxEnqueueInput<V>, key: Key): RallarTimingDetails {
        return {
            type: enqueue.type,
            topicId: key.topicId,
            contextId: key.contextId,
            resourceId: key.resourceId,
            senderId: enqueue.senderId
        };
    }
    nowEpochMs(): number {
        return this.optionsInput.nowEpochMs?.() ?? Date.now();
    }

    private toKey<V>(enqueue: AppInboxEnqueueInput<V>, strictQueueIdentity = false): Key {
        return toPhysicalAppInboxQueueKey(enqueue, this.defaultTopicId, strictQueueIdentity);
    }
}

function toNonNegativeFiniteNumber(value: number | undefined, fallback: number): number {
    return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : value;
}

function isMaterializedAppInboxRepository(
    repository: AppInboxQueueClient.InboxRepository
): repository is AppInboxQueueClient.InboxRepository & MaterializedAppInboxRepository {
    return (
        'writeMaterializedIfAbsentOrReplaceExpired' in repository &&
        typeof Reflect.get(repository, 'writeMaterializedIfAbsentOrReplaceExpired') === 'function'
    );
}

function toAppInboxResourceEntry<V>(
    enqueue: AppInboxEnqueueInput<V>,
    serviceId: string
): ResourceEntry {
    const wire = toJsonWireAppInboxEnqueue(enqueue);
    const key = toPhysicalAppInboxQueueKey(
        {
            ...wire,
            topicId: wire.topicId ?? '',
            resourceId: wire.resourceId ?? '',
            contextId: wire.contextId ?? ''
        },
        '',
        true
    );
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALUntargetedMessage(
            toAppInboxQueueCreatedBy(serviceId),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            wire.type,
            wire
        ),
        'APP_INBOX'
    );
}

function toPhysicalAppInboxQueueKey<V>(
    enqueue: AppInboxEnqueueInput<V>,
    defaultTopicId = '',
    strictQueueIdentity = false
): Key {
    const key = {
        topicId: enqueue.topicId ?? defaultTopicId,
        resourceId: enqueue.resourceId ?? crypto.randomUUID().toString(),
        contextId: enqueue.contextId ?? enqueue.senderId ?? 'rallar-server'
    };
    return strictQueueIdentity ? toStrictAppInboxQueueKey(key) : toAppInboxQueueKey(key);
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
