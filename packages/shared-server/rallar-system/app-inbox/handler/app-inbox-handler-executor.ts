import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ResourceInboxHandlerEntryError } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type {
    ResourceInboxAttempt,
    ResourceInboxAttemptTelemetry
} from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import {
    ResourceInboxHandlerFinalizedRejection,
    ResourceInboxHandlerFinalizedSuccess,
    ResourceInboxHandlerRetryableConflict,
    type ResourceInboxHandlerOutcome
} from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import {
    runWithClaimableDeadline,
    type ClaimableDeadlineClaim
} from '@shared/resilience/run-with-claimable-deadline.ts';
import type { Timers } from '@shared/resilience/timers.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink
} from '../../observability/timing.ts';
import { AppInboxCommandIdentityError, validateAppInboxCommandIdentity } from '../app-inbox-command-identity.ts';
import {
    AppInboxAttemptDeadlineExceededError,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from '../app-inbox-contracts.ts';
import {
    classifyAppInboxError,
    isAppInboxRetryableConflict,
    type AppInboxErrorClassification
} from '../app-inbox-error-classification.ts';
import { toTerminalAppInboxFailure } from '../app-inbox-failure.ts';
import {
    MAX_APP_INBOX_FINISHED_RETENTION_MS,
    resolveAppInboxAttemptDeadlineMarginMs,
    type AppInboxOptions
} from '../app-inbox-options.ts';
import type { AppInboxResultRepository } from '../app-inbox-persistence-ports.ts';
import { toAppInboxAttemptTimingDetails, toAppInboxTimingDetails } from './app-inbox-attempt-timing.ts';
import { computeAppInboxCompletion, validateAppInboxCompletion } from './app-inbox-completion-computation.ts';
import type { AppInboxHandlerRegistration } from './app-inbox-handler-registration.ts';
import { timeAppInboxPhase } from './app-inbox-phase-timing.ts';
import { AppInboxTransactionWriter } from './app-inbox-transaction-writer.ts';

const DEFAULT_APP_INBOX_CONFLICT_RETRY_MAX_DELAY_MS = 36_000;

interface AppInboxExecutionAttempt<Command, Result> extends AppInboxHandlerExecutor.Input<Command, Result> {
    readonly undecodedEnqueue: AppInboxEnqueueInput;
    readonly deadline: ClaimableDeadlineClaim;
}

interface AppInboxPhaseOperation<Result> {
    readonly operation: 'handler-action' | 'write-result';
    readonly enqueue: AppInboxEnqueueInput;
    readonly key: Key;
    readonly action: () => Promise<Result>;
    readonly details: RallarTimingDetails;
}

interface HandlerLeaseDuration {
    readonly handlerDurationMs: number;
    readonly leaseRemainingMs: number;
}

interface BegunAppInboxExecution<Command, Result> {
    readonly command: Command;
    readonly context: AppInboxMessageContext<Result>;
}

interface FailedAppInboxExecution<Command, Result> extends AppInboxExecutionAttempt<Command, Result> {
    readonly error: Error;
    readonly classification: AppInboxErrorClassification;
    readonly context: AppInboxMessageContext<Result> | undefined;
}

export namespace AppInboxHandlerExecutor {
    export interface Input<Command, Result> {
        readonly registration: AppInboxHandlerRegistration<Command, Result>;
        readonly message: ALMessage;
        readonly entry: ResourceEntry;
        readonly attemptTelemetry: ResourceInboxAttemptTelemetry;
    }

    export interface Dependencies {
        readonly resultRepository: AppInboxResultRepository;
        readonly transactionWriter: AppInboxTransactionWriter;
        /** The executor whose statement and wait counters the phase lines report. */
        readonly database: Pick<PSqlSql, 'getExecutorCounters'>;
        readonly nowEpochMs: () => number;
        /** The dequeue clock that selected the claim; the claim's lease is reckoned on it. */
        readonly dequeueNowEpochMs: () => number;
        readonly timers: Timers;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
    }
}

export class AppInboxHandlerExecutor {
    private readonly resultRepository: AppInboxResultRepository;
    private readonly transactionWriter: AppInboxTransactionWriter;
    private readonly database: Pick<PSqlSql, 'getExecutorCounters'>;
    private readonly nowEpochMs: () => number;
    private readonly dequeueNowEpochMs: () => number;
    private readonly timers: Timers;
    private readonly serviceId: string;
    private readonly timing: RallarTimingSink | undefined;
    private readonly options: AppInboxOptions;
    private readonly attemptDeadlineMarginMs: number;
    private readonly conflictRetryMaxDelayMs: number;

    constructor(
        dependencies: AppInboxHandlerExecutor.Dependencies,
        config: AppInboxHandlerExecutor.Config
    ) {
        this.resultRepository = dependencies.resultRepository;
        this.transactionWriter = dependencies.transactionWriter;
        this.database = dependencies.database;
        this.nowEpochMs = dependencies.nowEpochMs;
        this.dequeueNowEpochMs = dependencies.dequeueNowEpochMs;
        this.timers = dependencies.timers;
        this.serviceId = config.serviceId;
        this.timing = config.timing;
        this.options = config.options ?? {};
        this.attemptDeadlineMarginMs = resolveAppInboxAttemptDeadlineMarginMs(this.options);
        this.conflictRetryMaxDelayMs = resolveAppInboxConflictRetryMaxDelayMs(this.options);
    }

    /**
     * Resolves with the committed entry when the handler's own transaction finalized it, as a success or as a typed
     * rejection, so the queue releases nothing. The deadline falls the configured margin below what remains of the
     * claim's lease since its selection. An attempt that has not claimed it by committing is abandoned there: it rejects
     * as retryable so the lane serves the next entry and the entry follows the retry path, while the abandoned
     * handler's own commit is refused and rolls back.
     */
    async execute<Command, Result>(
        input: AppInboxHandlerExecutor.Input<Command, Result>
    ): Promise<ResourceInboxHandlerOutcome | undefined> {
        const { registration, entry } = input;
        const undecodedEnqueue: AppInboxEnqueueInput = {
            type: registration.type,
            resourceId: entry.key.resourceId,
            contextId: entry.key.contextId,
            data: null
        };
        const leaseRemainingMs = Math.max(
            0,
            input.attemptTelemetry.selectedAtEpochMs + input.attemptTelemetry.reservationLeaseMs -
                this.dequeueNowEpochMs()
        );
        return await timeRallarAsync(
            this.timing,
            {
                component: 'app-inbox-handler',
                operation: String(registration.type),
                serviceId: this.serviceId,
                requestId: entry.key.resourceId,
                details: {
                    type: registration.type,
                    topicId: entry.key.topicId,
                    contextId: entry.key.contextId,
                    resourceId: entry.key.resourceId
                }
            },
            async () => await this.executeAgainstDeadline({ ...input, undecodedEnqueue }, leaseRemainingMs)
        );
    }

    /** The handler line ends at the deadline for an abandoned attempt, which records no lease outrun of its own. */
    private async executeAgainstDeadline<Command, Result>(
        attempt: Omit<AppInboxExecutionAttempt<Command, Result>, 'deadline'>,
        leaseRemainingMs: number
    ): Promise<ResourceInboxHandlerOutcome | undefined> {
        const startedAtEpochMs = this.nowEpochMs();
        let abandoned = false;
        try {
            const outcome = await runWithClaimableDeadline(
                this.timers,
                Math.max(0, leaseRemainingMs - this.attemptDeadlineMarginMs),
                async (deadline) => await this.executeAttempt({ ...attempt, deadline })
            );
            if (outcome.kind === 'expired') {
                abandoned = true;
                this.recordHandlerDeadlineExpired(attempt, outcome.deadlineMs);
                throw new AppInboxAttemptDeadlineExceededError(attempt.entry.key);
            }
            return outcome.value;
        }
        finally {
            if (!abandoned) {
                this.recordHandlerOutranLease(attempt, {
                    handlerDurationMs: this.nowEpochMs() - startedAtEpochMs,
                    leaseRemainingMs
                });
            }
        }
    }

    async rejectMalformedMessage(attempt: ResourceInboxAttempt): Promise<ResourceEntry> {
        const completionInput = {
            ...this.transactionWriter.readEntryCompletionFacts(attempt.entry),
            durableResult: toTerminalAppInboxFailure({
                code: 'app-inbox-malformed-command',
                status: 400,
                message: 'Persisted AppInbox message is malformed or unsupported'
            }),
            status: EntityStatus.NON_RETRYABLE
        } as const;
        const computed = computeAppInboxCompletion(completionInput);
        const issues = validateAppInboxCompletion(completionInput, computed);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
        await this.transactionWriter.writeComputedQueueFailure(attempt, computed);
        return computed.finalizedEntry;
    }

    private async executeAttempt<Command, Result>(
        attempt: AppInboxExecutionAttempt<Command, Result>
    ): Promise<ResourceInboxHandlerOutcome | undefined> {
        let context: AppInboxMessageContext<Result> | undefined;
        let finalizedEntry: ResourceEntry;
        try {
            const begun = this.beginExecution(attempt);
            context = begun.context;
            const result = await this.timePhase({
                operation: 'handler-action',
                enqueue: begun.context.enqueue,
                key: attempt.entry.key,
                action: async () => await attempt.registration.handle(begun.command, begun.context),
                details: {}
            });
            const finalization = this.transactionWriter.read(begun.context);
            if (finalization.state !== 'transaction-finalized') {
                if (!attempt.deadline.tryClaim()) {
                    throw new AppInboxAttemptDeadlineExceededError(attempt.entry.key);
                }
                await this.writeNonTransactionalResult(attempt.registration, begun.context, result);
                return undefined;
            }
            finalizedEntry = finalization.entry;
        }
        catch (caught) {
            const error = caught instanceof Error ? caught : new Error(String(caught));
            return await this.finishFailedExecution({
                ...attempt,
                error,
                classification: classifyAppInboxError(error),
                context
            });
        }
        if (finalizedEntry.status !== EntityStatus.COMPLETED) {
            throw new Error(
                `AppInbox handler returned after finalizing its entry as ${finalizedEntry.status}; a returning handler must finalize it COMPLETED`
            );
        }
        return new ResourceInboxHandlerFinalizedSuccess(finalizedEntry);
    }

    private beginExecution<Command, Result>(
        attempt: AppInboxExecutionAttempt<Command, Result>
    ): BegunAppInboxExecution<Command, Result> {
        const identity = validateAppInboxCommandIdentity(attempt.entry);
        if (!identity.valid) {
            throw new AppInboxCommandIdentityError(identity.identity.operationSource);
        }
        const command = attempt.registration.decodeCommand(identity.command.data);
        const context: AppInboxMessageContext<Result> = {
            enqueue: identity.command,
            message: attempt.message,
            entry: attempt.entry,
            attemptTelemetry: attempt.attemptTelemetry,
            encodeResult: attempt.registration.encodeResult
        };
        this.transactionWriter.begin(context, attempt.deadline);
        return {
            command,
            context
        };
    }

    private async writeNonTransactionalResult<Command, Result>(
        registration: AppInboxHandlerRegistration<Command, Result>,
        context: AppInboxMessageContext<Result>,
        result: Result
    ): Promise<void> {
        await this.timePhase({
            operation: 'write-result',
            enqueue: context.enqueue,
            key: context.entry.key,
            action: async () => {
                await this.resultRepository.replace(
                    toResourceEntryWithUpdatedResource(
                        context.entry,
                        EntityStatus.COMPLETED,
                        registration.encodeResult(result)
                    )
                );
            },
            details: { resultStatus: EntityStatus.COMPLETED }
        });
    }

    /**
     * An optimistic conflict is a retryable value and any other retryable failure rethrows, both for redelivery; a typed
     * rejection commits its terminal entry and is a value.
     */
    private async finishFailedExecution<Command, Result>(
        input: FailedAppInboxExecution<Command, Result>
    ): Promise<ResourceInboxHandlerOutcome> {
        if (input.context) {
            const finalization = this.transactionWriter.read(input.context);
            if (
                finalization.state === 'transaction-finalized' &&
                finalization.entry.status === EntityStatus.COMPLETED
            ) {
                return new ResourceInboxHandlerFinalizedSuccess(finalization.entry);
            }
        }
        if (input.classification.kind === 'retryable') {
            if (!input.deadline.isExpired()) {
                this.recordQueueRetryTiming(input);
            }
            if (isAppInboxRetryableConflict(input.error)) {
                return new ResourceInboxHandlerRetryableConflict(
                    input.entry,
                    input.classification.code,
                    input.error,
                    this.conflictRetryMaxDelayMs
                );
            }
            throw input.error;
        }
        const terminalContext = input.context ?? this.beginTerminalContext(input);
        const completionInput = {
            ...this.transactionWriter.readCompletionFacts(terminalContext),
            entry: input.entry,
            durableResult: input.classification.result,
            status: input.classification.code === 'app-inbox-malformed-command' ||
                    input.classification.code === 'app-inbox-non-retryable'
                ? EntityStatus.NON_RETRYABLE
                : EntityStatus.FAILED
        } as const;
        const computed = computeAppInboxCompletion(completionInput);
        const issues = validateAppInboxCompletion(completionInput, computed);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
        await this.transactionWriter.writeComputedTerminalFailure(terminalContext, computed);
        if (input.classification.queueFailure === 'command-rejected') {
            return new ResourceInboxHandlerFinalizedRejection(
                computed.finalizedEntry,
                input.classification.code,
                input.error
            );
        }
        throw new ResourceInboxHandlerEntryError(computed.finalizedEntry, input.error);
    }

    /** A failure before the attempt's own context began still commits under the attempt's deadline. */
    private beginTerminalContext<Command, Result>(
        input: FailedAppInboxExecution<Command, Result>
    ): AppInboxMessageContext<Result> {
        const context: AppInboxMessageContext<Result> = {
            enqueue: input.undecodedEnqueue,
            message: input.message,
            entry: input.entry,
            attemptTelemetry: input.attemptTelemetry,
            encodeResult: input.registration.encodeResult
        };
        this.transactionWriter.begin(context, input.deadline);
        return context;
    }

    private recordQueueRetryTiming<Command, Result>(
        input: FailedAppInboxExecution<Command, Result>
    ): void {
        if (input.classification.kind !== 'retryable') {
            throw new Error('Queue retry timing requires a retryable failure');
        }
        const { entry, attemptTelemetry, classification, error } = input;
        const enqueue = input.context?.enqueue ?? input.undecodedEnqueue;
        const attemptDetails = toAppInboxAttemptTimingDetails(enqueue, entry, attemptTelemetry);
        recordRallarTiming({
            sink: this.timing,
            event: {
                component: 'app-inbox-handler',
                operation: 'queue-retry',
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: {
                    ...attemptDetails,
                    attempts: attemptDetails.attempt,
                    classification: classification.kind,
                    errorCode: classification.code,
                    errorMessage: classification.message
                }
            },
            status: 'ok',
            durationMs: 0,
            error
        });
    }

    private recordHandlerDeadlineExpired<Command, Result>(
        input: AppInboxHandlerExecutor.Input<Command, Result>,
        deadlineMs: number
    ): void {
        const { entry, attemptTelemetry } = input;
        recordRallarTiming({
            sink: this.timing,
            event: {
                component: 'app-inbox-handler',
                operation: 'handler-deadline-expired',
                serviceId: this.serviceId,
                requestId: entry.key.resourceId,
                details: {
                    type: input.registration.type,
                    topicId: entry.key.topicId,
                    contextId: entry.key.contextId,
                    resourceId: entry.key.resourceId,
                    attempt: attemptTelemetry.attempt,
                    reservationLeaseMs: attemptTelemetry.reservationLeaseMs,
                    deadlineMs
                }
            },
            status: 'error',
            durationMs: deadlineMs
        });
    }

    /** A handler that claimed its deadline and still ran past what remained of its claim's lease, such as a slow commit. */
    private recordHandlerOutranLease<Command, Result>(
        input: AppInboxHandlerExecutor.Input<Command, Result>,
        duration: HandlerLeaseDuration
    ): void {
        const { entry, attemptTelemetry } = input;
        const { handlerDurationMs, leaseRemainingMs } = duration;
        if (handlerDurationMs <= leaseRemainingMs) {
            return;
        }
        recordRallarTiming({
            sink: this.timing,
            event: {
                component: 'app-inbox-handler',
                operation: 'handler-outran-lease',
                serviceId: this.serviceId,
                requestId: entry.key.resourceId,
                details: {
                    type: input.registration.type,
                    topicId: entry.key.topicId,
                    contextId: entry.key.contextId,
                    resourceId: entry.key.resourceId,
                    attempt: attemptTelemetry.attempt,
                    reservationLeaseMs: attemptTelemetry.reservationLeaseMs,
                    leaseRemainingMs
                }
            },
            status: 'error',
            durationMs: handlerDurationMs
        });
    }

    private async timePhase<Result>(
        phase: AppInboxPhaseOperation<Result>
    ): Promise<Result> {
        if (!(this.options.phaseTiming ?? false)) {
            return await phase.action();
        }
        return await timeAppInboxPhase(
            {
                sink: this.timing,
                database: this.database,
                event: {
                    component: 'app-inbox-phase',
                    operation: phase.operation,
                    serviceId: this.serviceId,
                    requestId: phase.enqueue.resourceId,
                    details: { ...toAppInboxTimingDetails(phase.enqueue, phase.key), ...phase.details }
                }
            },
            phase.action
        );
    }
}

/** A positive integer ceiling; invalid explicit policy fails at construction instead of silently defaulting. */
function resolveAppInboxConflictRetryMaxDelayMs(options: AppInboxOptions): number {
    const delayMs = options.conflictRetryMaxDelayMs ?? DEFAULT_APP_INBOX_CONFLICT_RETRY_MAX_DELAY_MS;
    if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > MAX_APP_INBOX_FINISHED_RETENTION_MS) {
        throw new RangeError(
            `AppInbox conflict retry maximum delay must be a positive safe integer no greater than ${MAX_APP_INBOX_FINISHED_RETENTION_MS}`
        );
    }
    return delayMs;
}
