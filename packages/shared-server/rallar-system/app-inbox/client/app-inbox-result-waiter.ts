import {
    RESOURCE_INBOX_COMPLETION_SAFETY_TICK_MSECS,
    type ResourceInboxCompletionNotifications
} from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    TryWithExhaustedError,
    TryWithPolicy,
    tryWithPolicy
} from '@shared/resilience/try-with-policy.ts';

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

/** Why a read of the wait runs: its first read, or what ended the wait before it. */
type AppInboxReadTrigger = 'first' | ResourceInboxCompletionNotifications.WakeReason;

/** The trigger of the wait's next read; a wait without a subscription re-reads after its own delay. */
interface AppInboxWaitProgress {
    nextTrigger: AppInboxReadTrigger;
}

/** A terminal entry: the result row its wake read, or a terminal status whose result row is read next. */
type AppInboxTerminalObservation<Result> =
    | { readonly readRow: 'result'; readonly result: Either<AppInboxFailure, Result>; }
    | { readonly readRow: 'status'; };

interface AppInboxSubscribedWait<Result> {
    readonly enqueue: AppInboxEnqueueInput;
    readonly key: Key;
    readonly decodeResult: AppInboxResultWaiter.ResultDecoder<Result>;
    /** This wait's reservation or write created the entry, so the entry was not terminal when the wait subscribed. */
    readonly winner: boolean;
}

interface AppInboxCompletedResultRead<Result> {
    readonly enqueue: AppInboxEnqueueInput;
    readonly key: Key;
    readonly decodeResult: AppInboxResultWaiter.ResultDecoder<Result>;
    readonly subscription: ResourceInboxCompletionNotifications.Subscription | undefined;
    readonly firstObservation: AppInboxFirstObservation;
}

/**
 * The entry is not terminal yet; the wait retries on it exactly as on a failed read. `unread` is a winner's first
 * attempt, which waits for its wake or the safety tick before it reads anything.
 */
class AppInboxEntryPendingError extends Error {
    constructor(observation: AppInboxQueueObservation | 'unread') {
        super(`App inbox entry is not complete: ${observation}`);
        this.name = 'AppInboxEntryPendingError';
    }
}

/** One read of the wait: what caused it and which row it reads. */
interface AppInboxPoll {
    readonly enqueue: AppInboxEnqueueInput;
    readonly key: Key;
    readonly trigger: AppInboxReadTrigger;
    readonly readRow: 'result' | 'status';
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
        readStatusAndAttempts(key: Key): Promise<ResourceInboxStatusAndAttempts | undefined>;
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
    private readonly statusRepository: AppInboxResultWaiter.StatusRepository;
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
        this.statusRepository = dependencies.statusRepository;
        this.resultRepository = dependencies.resultRepository;
        this.serviceId = config.serviceId;
        this.timing = config.timing;
        this.options = config.options;
        this.wakeOwningQueue = config.wakeOwningQueue;
    }

    /** Waits for the entry its key holds; a winner's reservation or write created that entry. */
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
        const terminal = await this.waitForCompletion(read);
        if (terminal === undefined) {
            return Either.ofLeft(toUnavailableAppInboxFailure());
        }
        if (terminal.readRow === 'result') {
            return terminal.result;
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
        return toAppInboxResult(result, decodeResult);
    }

    /** Answers the terminal observation, or nothing once the wait's budget is spent. */
    private async waitForCompletion<Result>(
        read: AppInboxCompletedResultRead<Result>
    ): Promise<AppInboxTerminalObservation<Result> | undefined> {
        const { enqueue, key } = read;
        const progress: AppInboxWaitProgress = { nextTrigger: 'first' };
        try {
            return await this.timePhase({
                operation: 'wait-completion',
                enqueue,
                key,
                action: async () =>
                    await tryWithPolicy(
                        this.createCompletionAttempt(read, progress),
                        this.toWaitPolicy(read, progress)
                    ),
                details: { waitMaxElapsedMsecs: this.options.waitMaxElapsedMsecs }
            });
        }
        catch (error) {
            if (!(error instanceof TryWithExhaustedError)) {
                throw error;
            }
            this.recordWaitFallback(enqueue, key, error);
            return undefined;
        }
    }

    /** A completion of the waiter's own key reads the result row, the only authority; any other read, the status. */
    private createCompletionAttempt<Result>(
        read: AppInboxCompletedResultRead<Result>,
        progress: AppInboxWaitProgress
    ): () => Promise<AppInboxTerminalObservation<Result>> {
        const { enqueue, key, subscription } = read;
        let unread = read.firstObservation === 'wait';
        return async () => {
            const trigger = progress.nextTrigger;
            progress.nextTrigger = 'delay';
            if (unread) {
                unread = false;
                throw new AppInboxEntryPendingError('unread');
            }
            subscription?.beginRead();
            if (trigger === 'completion') {
                return await this.readWokenResult(read, trigger);
            }
            return await this.readCompletionPoll(enqueue, key, trigger);
        };
    }

    /** A wake whose result row is missing still settles on the entry's status, as any other read does. */
    private async readWokenResult<Result>(
        read: AppInboxCompletedResultRead<Result>,
        trigger: AppInboxReadTrigger
    ): Promise<AppInboxTerminalObservation<Result>> {
        const { enqueue, key } = read;
        const poll = { enqueue, key, trigger, readRow: 'result' } as const;
        let result: ResourceEntry | undefined;
        try {
            result = await this.resultRepository.findByKey(key);
        }
        catch (error) {
            this.recordPoll(poll, { queueObservation: 'read-failure' });
            throw error;
        }
        if (result === undefined) {
            this.recordPoll(poll, { queueObservation: 'missing' });
            return await this.readCompletionPoll(enqueue, key, trigger);
        }
        const observed = { status: result.status, attempts: result.dequeueAudit.attempts };
        const queueObservation = toAppInboxQueueObservation(observed);
        this.recordPoll(poll, { queueObservation, attempts: observed.attempts });
        if (!isTerminalAppInboxStatus(observed)) {
            throw new AppInboxEntryPendingError(queueObservation);
        }
        return { readRow: 'result', result: toAppInboxResult(result, read.decodeResult) };
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

    private async readCompletionPoll<Result>(
        enqueue: AppInboxEnqueueInput,
        key: Key,
        trigger: AppInboxReadTrigger
    ): Promise<AppInboxTerminalObservation<Result>> {
        const poll = { enqueue, key, trigger, readRow: 'status' } as const;
        let observed: ResourceInboxStatusAndAttempts | undefined;
        try {
            observed = await this.statusRepository.readStatusAndAttempts(key);
        }
        catch (error) {
            this.recordPoll(poll, { queueObservation: 'read-failure' });
            throw error;
        }
        const queueObservation = toAppInboxQueueObservation(observed);
        this.recordPoll(poll, {
            queueObservation,
            ...(observed === undefined ? {} : { attempts: observed.attempts })
        });
        if (!isTerminalAppInboxStatus(observed)) {
            throw new AppInboxEntryPendingError(queueObservation);
        }
        return { readRow: 'status' };
    }

    /** One line per observation, naming the row read and what caused the read. */
    private recordPoll(poll: AppInboxPoll, observation: RallarTimingDetails): void {
        if (!this.options.phaseTiming) {
            return;
        }
        recordRallarTiming({
            sink: this.timing,
            event: {
                component: 'app-inbox-phase',
                operation: 'wait-poll',
                serviceId: this.serviceId,
                requestId: poll.enqueue.resourceId,
                details: {
                    ...toAppInboxTimingDetails(poll.enqueue, poll.key),
                    ...observation,
                    trigger: poll.trigger,
                    readRow: poll.readRow
                }
            },
            status: observation.queueObservation === 'read-failure' ? 'error' : 'ok',
            durationMs: 0
        });
    }

    private toWaitPolicy<Result>(
        read: AppInboxCompletedResultRead<Result>,
        progress: AppInboxWaitProgress
    ): TryWithPolicy {
        const { enqueue, key, subscription } = read;
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
        if (!subscription) {
            return policy;
        }
        return policy.waitBeforeRetry(async (context) => {
            progress.nextTrigger = await subscription.wait(context.delayMsecs);
        });
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

function isTerminalAppInboxStatus(observed: ResourceInboxStatusAndAttempts | undefined): boolean {
    return observed?.status === EntityStatus.COMPLETED ||
        observed?.status === EntityStatus.FAILED ||
        observed?.status === EntityStatus.NON_RETRYABLE;
}

/** The answer a result row carries; a row that is not terminal leaves the command unavailable. */
function toAppInboxResult<Result>(
    result: ResourceEntry,
    decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
): Either<AppInboxFailure, Result> {
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
