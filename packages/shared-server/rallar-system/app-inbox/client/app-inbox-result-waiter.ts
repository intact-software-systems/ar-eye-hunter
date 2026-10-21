import {
    RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS,
    toResourceInboxCompletionKey,
    type ResourceInboxCompletionNotifications
} from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    TryWithExhaustedError,
    TryWithPolicy,
    tryWithPolicy
} from '@shared/resilience/try-with-policy.ts';
import { TurnBatchedReads } from '@shared/resilience/turn-batched-reads.ts';

import type { ResourceInboxStatusAndAttempts } from '../../../queuebox/postgres/resource-inbox-row-codec.ts';
import {
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink
} from '../../observability/timing.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput } from '../app-inbox-contracts.ts';
import { decodePersistedAppInboxFailure } from '../app-inbox-failure-decoding.ts';
import {
    toTerminalAppInboxFailure,
    toUnavailableAppInboxFailure,
    type AppInboxFailure
} from '../app-inbox-failure.ts';
import type { NormalizedAppInboxOptions } from '../app-inbox-options.ts';
import { toAppInboxTimingDetails } from '../handler/app-inbox-attempt-timing.ts';
import type { AppInboxReservationClient } from './app-inbox-reservation-client.ts';

type AppInboxQueueObservation =
    | 'missing'
    | 'NEW'
    | 'RESERVED'
    | 'RETRY'
    | 'COMPLETED'
    | 'FAILED'
    | 'NON_RETRYABLE'
    | 'other-status'
    | 'read-failure';

/** A winner wrote the entry it waits for, so its first observation is its wake or safety tick, not a read. */
type AppInboxFirstObservation = 'read' | 'wait';

/** One key's answer from a batched status read, with the size of the batch it was read in. */
type AppInboxStatusRead =
    | {
        readonly outcome: 'observed';
        readonly batchSize: number;
        readonly observed: ResourceInboxStatusAndAttempts | undefined;
    }
    | {
        readonly outcome: 'failed';
        readonly batchSize: number;
        readonly error: Error;
    };

interface AppInboxSubscribedWait<Result> {
    readonly enqueue: AppInboxEnqueueInput;
    readonly key: Key;
    readonly decodeResult: AppInboxResultWaiter.ResultDecoder<Result>;
    /** This wait's reservation created the entry, so the entry was not terminal when the wait subscribed. */
    readonly winner: boolean;
}

interface AppInboxCompletedResultRead<Result> {
    readonly enqueue: AppInboxEnqueueInput;
    readonly key: Key;
    readonly decodeResult: AppInboxResultWaiter.ResultDecoder<Result>;
    readonly subscription: ResourceInboxCompletionNotifications.Subscription | undefined;
    readonly firstObservation: AppInboxFirstObservation;
}

/** The entry is not terminal yet; the wait retries on it exactly as on a failed read. */
class AppInboxEntryPendingError extends Error {
    constructor(observation: AppInboxQueueObservation) {
        super(`App inbox entry is not complete: ${observation}`);
        this.name = 'AppInboxEntryPendingError';
    }
}

interface AppInboxWaitPhase<Result> {
    readonly operation: 'read-result' | 'wait-completion';
    readonly enqueue: AppInboxEnqueueInput;
    readonly key: Key;
    readonly action: () => Promise<Result>;
    readonly details: RallarTimingDetails;
}

export namespace AppInboxResultWaiter {
    export type ResultDecoder<Result> = (value: JsonWireValue) => Result;

    export interface StatusRepository {
        /** One answer per key, in key order; `undefined` for a key without a live entry. */
        readStatusesAndAttempts(keys: readonly Key[]): Promise<readonly (ResourceInboxStatusAndAttempts | undefined)[]>;
    }

    export interface ResultRepository {
        findByKey(key: Key): Promise<ResourceEntry | undefined>;
    }

    export interface Dependencies {
        readonly completionNotifications?: ResourceInboxCompletionNotifications;
        readonly statusRepository: StatusRepository;
        readonly resultRepository: ResultRepository;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options: NormalizedAppInboxOptions;
        readonly wakeOwningQueue?: () => void;
    }
}

export class AppInboxResultWaiter {
    private readonly completionNotifications: ResourceInboxCompletionNotifications | undefined;
    private readonly statusReads: TurnBatchedReads<Key, AppInboxStatusRead>;
    private readonly resultRepository: AppInboxResultWaiter.ResultRepository;
    private readonly serviceId: string;
    private readonly timing: RallarTimingSink | undefined;
    private readonly options: NormalizedAppInboxOptions;
    private readonly wakeOwningQueue: (() => void) | undefined;

    constructor(
        dependencies: AppInboxResultWaiter.Dependencies,
        config: AppInboxResultWaiter.Config
    ) {
        this.completionNotifications = dependencies.completionNotifications;
        const statusRepository = dependencies.statusRepository;
        this.statusReads = new TurnBatchedReads<Key, AppInboxStatusRead>({
            toKeyId: toResourceInboxCompletionKey,
            readBatch: async (keys) => await readStatusBatch(statusRepository, keys)
        });
        this.resultRepository = dependencies.resultRepository;
        this.serviceId = config.serviceId;
        this.timing = config.timing;
        this.options = config.options;
        this.wakeOwningQueue = config.wakeOwningQueue;
    }

    async waitForResult<Result>(
        enqueue: AppInboxEnqueueInput,
        key: Key,
        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
    ): Promise<Either<AppInboxFailure, Result>> {
        return await this.waitSubscribed({ enqueue, key, decodeResult, winner: false });
    }

    async waitForReservedResult<Result>(
        reservation: AppInboxReservationClient.MaterializedReservation,
        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
    ): Promise<Either<AppInboxFailure, Result>> {
        const { enqueue, key, winner } = reservation;
        return await this.waitSubscribed({ enqueue, key, decodeResult, winner });
    }

    /**
     * A winner subscribes before it wakes the queue, so the completion of the entry it created finds the subscription and
     * its first read waits for that wake or the safety tick; any other waiter reads first, as its entry may be terminal.
     */
    private async waitSubscribed<Result>(
        wait: AppInboxSubscribedWait<Result>
    ): Promise<Either<AppInboxFailure, Result>> {
        const subscription = this.completionNotifications?.subscribe(wait.key);
        try {
            if (wait.winner) {
                this.wakeOwningQueue?.();
            }
            const firstObservation = wait.winner && subscription !== undefined ? 'wait' : 'read';
            return await this.readCompletedResult({ ...wait, subscription, firstObservation });
        }
        finally {
            subscription?.close();
        }
    }

    private async readCompletedResult<Result>(
        read: AppInboxCompletedResultRead<Result>
    ): Promise<Either<AppInboxFailure, Result>> {
        const { enqueue, key, decodeResult } = read;
        if (!(await this.waitForCompletion(read))) {
            return Either.ofLeft(toUnavailableAppInboxFailure());
        }
        return await this.timePhase({
            operation: 'read-result',
            enqueue,
            key,
            action: async () => await this.readResult(key, decodeResult),
            details: {}
        });
    }

    private async readResult<Result>(
        key: Key,
        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
    ): Promise<Either<AppInboxFailure, Result>> {
        const result = await this.resultRepository.findByKey(key);
        if (result === undefined) {
            return Either.ofLeft(toTerminalAppInboxFailure({
                code: 'app-inbox-result-not-found',
                status: 500,
                message: 'App inbox entry result was not found'
            }));
        }
        if (result.status === EntityStatus.FAILED || result.status === EntityStatus.NON_RETRYABLE) {
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

    private async waitForCompletion<Result>(read: AppInboxCompletedResultRead<Result>): Promise<boolean> {
        const { enqueue, key, subscription } = read;
        try {
            return await this.timePhase({
                operation: 'wait-completion',
                enqueue,
                key,
                action: async () =>
                    await tryWithPolicy(
                        this.createCompletionAttempt(read),
                        this.toWaitPolicy(enqueue, key, subscription)
                    ),
                details: { waitMaxElapsedMsecs: this.options.waitMaxElapsedMsecs }
            });
        }
        catch (error) {
            if (!(error instanceof TryWithExhaustedError)) {
                throw error;
            }
            this.recordWaitFallback(enqueue, key, error);
            return false;
        }
    }

    private createCompletionAttempt<Result>(read: AppInboxCompletedResultRead<Result>): () => Promise<boolean> {
        const { enqueue, key, subscription } = read;
        let unread = read.firstObservation === 'wait';
        return async () => {
            subscription?.beginRead();
            if (unread) {
                unread = false;
                throw new AppInboxEntryPendingError(EntityStatus.NEW);
            }
            return await this.readCompletionPoll(enqueue, key);
        };
    }

    private recordWaitFallback(enqueue: AppInboxEnqueueInput, key: Key, error: TryWithExhaustedError): void {
        recordRallarTiming({
            sink: this.timing,
            event: {
                component: 'app-inbox-phase',
                operation: 'wait-fallback',
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: {
                    ...toAppInboxTimingDetails(enqueue, key),
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
    }

    private async readCompletionPoll(enqueue: AppInboxEnqueueInput, key: Key): Promise<boolean> {
        const read = await this.statusReads.read(key);
        if (read.outcome === 'failed') {
            this.recordPoll(enqueue, key, { queueObservation: 'read-failure', batchSize: read.batchSize });
            throw read.error;
        }
        const { observed, batchSize } = read;
        const queueObservation = toAppInboxQueueObservation(observed);
        this.recordPoll(enqueue, key, {
            queueObservation,
            ...(observed === undefined ? {} : { attempts: observed.attempts }),
            batchSize
        });
        if (
            observed?.status !== EntityStatus.COMPLETED &&
            observed?.status !== EntityStatus.FAILED &&
            observed?.status !== EntityStatus.NON_RETRYABLE
        ) {
            throw new AppInboxEntryPendingError(queueObservation);
        }
        return true;
    }

    private recordPoll(enqueue: AppInboxEnqueueInput, key: Key, details: RallarTimingDetails): void {
        if (!this.options.phaseTiming) {
            return;
        }
        recordRallarTiming({
            sink: this.timing,
            event: {
                component: 'app-inbox-phase',
                operation: 'wait-poll',
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: { ...toAppInboxTimingDetails(enqueue, key), ...details }
            },
            status: details.queueObservation === 'read-failure' ? 'error' : 'ok',
            durationMs: 0
        });
    }

    private toWaitPolicy(
        enqueue: AppInboxEnqueueInput,
        key: Key,
        subscription: ResourceInboxCompletionNotifications.Subscription | undefined
    ): TryWithPolicy {
        const labelled = TryWithPolicy.defaults()
            .label(`app-inbox:${key.topicId}:${key.resourceId}`)
            .maxElapsedMsecs(this.options.waitMaxElapsedMsecs);
        let policy = subscription ? this.toSubscribedWaitPolicy(labelled) : this.toPollingWaitPolicy(labelled);
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
                            ...toAppInboxTimingDetails(enqueue, key),
                            attempt: context.attempt,
                            nextAttempt: context.nextAttempt,
                            delayMsecs: context.delayMsecs,
                            elapsedMsecs: context.elapsedMsecs,
                            errorName: context.error instanceof Error ? context.error.name : undefined,
                            errorMessage: context.error instanceof Error
                                ? context.error.message
                                : String(context.error)
                        }
                    },
                    status: 'ok',
                    durationMs: 0
                });
            });
        }
        return subscription ? policy.waitBeforeRetry((context) => subscription.wait(context.delayMsecs)) : policy;
    }

    /** A wake ends the wait early; the safety tick, cut to what remains of the budget, is the only timed re-read. */
    private toSubscribedWaitPolicy(policy: TryWithPolicy): TryWithPolicy {
        return policy
            .retryIntervalMsecs(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS)
            .maxRetryIntervalMsecs(RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS)
            .backoffFactor(1)
            .jitterRatio(0)
            .fitDelayToElapsedBudget();
    }

    private toPollingWaitPolicy(policy: TryWithPolicy): TryWithPolicy {
        return policy
            .retryIntervalMsecs(this.options.waitRetryIntervalMsecs)
            .maxRetryIntervalMsecs(this.options.waitMaxRetryIntervalMsecs)
            .jitterRatio(this.options.waitJitterRatio);
    }

    private async timePhase<Result>(
        phase: AppInboxWaitPhase<Result>
    ): Promise<Result> {
        if (!this.options.phaseTiming) {
            return await phase.action();
        }
        return await timeRallarAsync(
            this.timing,
            {
                component: 'app-inbox-phase',
                operation: phase.operation,
                serviceId: this.serviceId,
                requestId: phase.enqueue.resourceId,
                details: { ...toAppInboxTimingDetails(phase.enqueue, phase.key), ...phase.details }
            },
            phase.action
        );
    }
}

async function readStatusBatch(
    repository: AppInboxResultWaiter.StatusRepository,
    keys: readonly Key[]
): Promise<readonly AppInboxStatusRead[]> {
    const batchSize = keys.length;
    try {
        const statuses = await repository.readStatusesAndAttempts(keys);
        return statuses.map((observed) => ({ outcome: 'observed', batchSize, observed }));
    }
    catch (error) {
        const failed: AppInboxStatusRead = { outcome: 'failed', batchSize, error: toError(error) };
        return keys.map(() => failed);
    }
}

function toAppInboxQueueObservation(observed: ResourceInboxStatusAndAttempts | undefined): AppInboxQueueObservation {
    if (observed === undefined) {
        return 'missing';
    }
    switch (observed.status) {
        case EntityStatus.NEW:
        case EntityStatus.RESERVED:
        case EntityStatus.RETRY:
        case EntityStatus.COMPLETED:
        case EntityStatus.FAILED:
        case EntityStatus.NON_RETRYABLE:
            return observed.status;
        default:
            return 'other-status';
    }
}
