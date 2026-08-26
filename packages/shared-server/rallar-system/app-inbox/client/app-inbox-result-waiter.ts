import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '@shared/resilience/TryWith.ts';
import {
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink
} from '../../observability/timing.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput } from '../app-inbox-contracts.ts';
import { decodePersistedAppInboxFailure } from '../app-inbox-failure-decoding.ts';
import { toTerminalAppInboxFailure, toUnavailableAppInboxFailure, type AppInboxFailure } from '../app-inbox-failure.ts';
import type { NormalizedAppInboxOptions } from '../app-inbox-options.ts';
import type { AppInboxReservationClient } from './app-inbox-reservation-client.ts';

export namespace AppInboxResultWaiter {
    export type ResultDecoder<Result> = (value: JsonWireValue) => Result;

    export interface StatusRepository {
        isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean>;
    }

    export interface ResultRepository {
        findByKey(key: Key): Promise<ResourceEntry | undefined>;
    }

    export interface Dependencies {
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
        this.statusRepository = dependencies.statusRepository;
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
        if (!(await this.waitForCompletion(enqueue, key))) {
            return Either.ofLeft(toUnavailableAppInboxFailure());
        }
        return await this.timePhase(
            'read-result',
            enqueue,
            key,
            async () => await this.readResult(key, decodeResult)
        );
    }

    async waitForReservedResult<Result>(
        reservation: AppInboxReservationClient.MaterializedReservation,
        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
    ): Promise<Either<AppInboxFailure, Result>> {
        if (reservation.winner) {
            this.wakeOwningQueue?.();
        }
        return await this.waitForResult(
            reservation.enqueue,
            reservation.key,
            decodeResult
        );
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

    private async waitForCompletion(
        enqueue: AppInboxEnqueueInput,
        key: Key
    ): Promise<boolean> {
        try {
            return await this.timePhase(
                'wait-completion',
                enqueue,
                key,
                async () =>
                    await tryWithPolicy(
                        async () => {
                            const completed = await this.statusRepository.isEntryWithStatus(key, [
                                EntityStatus.COMPLETED,
                                EntityStatus.FAILED
                            ]);
                            if (!completed) {
                                throw new Error('App inbox entry not found');
                            }
                            return true;
                        },
                        this.toWaitPolicy(enqueue, key)
                    ),
                { waitMaxElapsedMsecs: this.options.waitMaxElapsedMsecs }
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
                        ...toTimingDetails(enqueue, key),
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

    private toWaitPolicy(
        enqueue: AppInboxEnqueueInput,
        key: Key
    ): TryWithPolicy {
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
                            ...toTimingDetails(enqueue, key),
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
        return policy;
    }

    private async timePhase<Result>(
        operation: string,
        enqueue: AppInboxEnqueueInput,
        key: Key,
        action: () => Promise<Result>,
        details: RallarTimingDetails = {}
    ): Promise<Result> {
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
                details: { ...toTimingDetails(enqueue, key), ...details }
            },
            action
        );
    }
}

function toTimingDetails(
    enqueue: AppInboxEnqueueInput,
    key: Key
): RallarTimingDetails {
    return {
        type: enqueue.type,
        topicId: key.topicId,
        contextId: key.contextId,
        resourceId: key.resourceId,
        senderId: enqueue.senderId
    };
}
