import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ResourceInboxFinalizedByHandlerError } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import {
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink
} from '../../observability/timing.ts';
import { AppInboxCommandIdentityError, validateAppInboxCommandIdentity } from '../app-inbox-command-identity.ts';
import type { AppInboxEnqueueInput, AppInboxMessageContext } from '../app-inbox-contracts.ts';
import { classifyAppInboxError, type AppInboxErrorClassification } from '../app-inbox-error-classification.ts';
import type { AppInboxOptions } from '../app-inbox-options.ts';
import type { AppInboxResultRepository } from '../app-inbox-persistence-ports.ts';
import { toAppInboxAttemptTimingDetails, toAppInboxTimingDetails } from './app-inbox-attempt-timing.ts';
import { computeAppInboxCompletion, validateAppInboxCompletion } from './app-inbox-completion-computation.ts';
import type { AppInboxHandlerRegistration } from './app-inbox-handler-registration.ts';
import { AppInboxTransactionWriter } from './app-inbox-transaction-writer.ts';

interface AppInboxExecutionAttempt<Command, Result> {
    readonly registration: AppInboxHandlerRegistration<Command, Result>;
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly fallbackEnqueue: AppInboxEnqueueInput;
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
    export interface Dependencies {
        readonly resultRepository: AppInboxResultRepository;
        readonly transactionWriter: AppInboxTransactionWriter;
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
    private readonly serviceId: string;
    private readonly timing: RallarTimingSink | undefined;
    private readonly options: AppInboxOptions;

    constructor(
        dependencies: AppInboxHandlerExecutor.Dependencies,
        config: AppInboxHandlerExecutor.Config
    ) {
        this.resultRepository = dependencies.resultRepository;
        this.transactionWriter = dependencies.transactionWriter;
        this.serviceId = config.serviceId;
        this.timing = config.timing;
        this.options = config.options ?? {};
    }

    async execute<Command, Result>(
        registration: AppInboxHandlerRegistration<Command, Result>,
        message: ALMessage,
        entry: ResourceEntry
    ): Promise<void> {
        const fallbackEnqueue: AppInboxEnqueueInput = {
            type: registration.type,
            resourceId: entry.key.resourceId,
            contextId: entry.key.contextId,
            data: null
        };
        await timeRallarAsync(
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
            async () => await this.executeAttempt({ registration, message, entry, fallbackEnqueue })
        );
    }

    private async executeAttempt<Command, Result>(
        attempt: AppInboxExecutionAttempt<Command, Result>
    ): Promise<void> {
        let context: AppInboxMessageContext<Result> | undefined;
        try {
            const begun = this.beginExecution(attempt);
            context = begun.context;
            const result = await this.timePhase(
                'handler-action',
                begun.context.enqueue,
                attempt.entry.key,
                async () => await attempt.registration.handle(begun.command, begun.context)
            );
            const finalization = this.transactionWriter.read(begun.context);
            if (finalization.state === 'transaction-finalized') {
                return;
            }
            await this.writeNonTransactionalResult(attempt.registration, begun.context, result);
        }
        catch (caught) {
            await this.finishFailedExecution({
                ...attempt,
                error: caught instanceof Error ? caught : new Error(String(caught)),
                classification: classifyAppInboxError(caught),
                context
            });
        }
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
            encodeResult: attempt.registration.encodeResult
        };
        this.transactionWriter.begin(context);
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
        await this.timePhase(
            'write-result',
            context.enqueue,
            context.entry.key,
            async () => {
                await this.resultRepository.replace(
                    toResourceEntryWithUpdatedResource(
                        context.entry,
                        EntityStatus.COMPLETED,
                        registration.encodeResult(result)
                    )
                );
            },
            { resultStatus: EntityStatus.COMPLETED }
        );
    }

    private async finishFailedExecution<Command, Result>(
        input: FailedAppInboxExecution<Command, Result>
    ): Promise<void> {
        if (input.context) {
            const finalization = this.transactionWriter.read(input.context);
            if (
                finalization.state === 'transaction-finalized' &&
                finalization.status === EntityStatus.COMPLETED
            ) {
                return;
            }
        }
        if (input.classification.kind === 'retryable') {
            this.recordQueueRetryTiming(
                input.context?.enqueue ?? input.fallbackEnqueue,
                input.entry,
                input.classification,
                input.error
            );
            throw input.error;
        }
        const terminalContext = input.context ?? {
            enqueue: input.fallbackEnqueue,
            message: input.message,
            entry: input.entry,
            encodeResult: input.registration.encodeResult
        };
        const completionInput = {
            ...this.transactionWriter.readCompletionFacts(terminalContext),
            durableResult: input.classification.result,
            status: EntityStatus.FAILED
        } as const;
        const computed = computeAppInboxCompletion(completionInput);
        const issues = validateAppInboxCompletion(completionInput, computed);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
        await this.transactionWriter.writeComputedTerminalFailure(terminalContext, computed);
        throw new ResourceInboxFinalizedByHandlerError(
            computed.finalizedEntry,
            input.error
        );
    }

    private recordQueueRetryTiming(
        enqueue: AppInboxEnqueueInput,
        entry: ResourceEntry,
        classification: Extract<AppInboxErrorClassification, { kind: 'retryable'; }>,
        error: Error
    ): void {
        const nowEpochMs = this.timingNowEpochMs();
        const attemptDetails = toAppInboxAttemptTimingDetails(enqueue, entry, nowEpochMs);
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

    private async timePhase<Result>(
        operation: string,
        enqueue: AppInboxEnqueueInput,
        key: Key,
        action: () => Promise<Result>,
        details: RallarTimingDetails = {}
    ): Promise<Result> {
        if (!(this.options.phaseTiming ?? false)) {
            return await action();
        }
        return await timeRallarAsync(
            this.timing,
            {
                component: 'app-inbox-phase',
                operation,
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: { ...toAppInboxTimingDetails(enqueue, key), ...details }
            },
            action
        );
    }

    private timingNowEpochMs(): number {
        return this.options.timingNowEpochMs?.() ?? Date.now();
    }
}
