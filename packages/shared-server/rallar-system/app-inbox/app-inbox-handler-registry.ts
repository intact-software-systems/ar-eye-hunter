import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    readResourceInboxAttemptTelemetry,
    ResourceInboxFinalizedByHandlerError
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';

import {
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink
} from '../observability/timing.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';
import { AppInboxCommandIdentityError, validateAppInboxCommandIdentity } from './app-inbox-command-identity.ts';
import {
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxExecutionMetadata,
    type AppInboxMessageContext
} from './app-inbox-contracts.ts';
import type { AppInboxErrorClassification } from './app-inbox-error-classification.ts';
import { classifyAppInboxError } from './app-inbox-error-classification.ts';
import { encodeAppInboxFailure } from './app-inbox-failure.ts';
import type { AppInboxOptions } from './app-inbox-options.ts';
import type { AppInboxResultRepository } from './app-inbox-persistence-ports.ts';
import { AppInboxTransactionWriter, toFinalizedResourceEntry } from './app-inbox-transaction-writer.ts';

export namespace AppInboxHandlerRegistry {
    export interface Registration<Command, Result> {
        readonly type: AppInboxType;
        readonly decodeCommand: (value: JsonWireValue) => Command;
        readonly encodeResult: (result: Result) => JsonWireValue;
        readonly handle: (
            command: Command,
            context: AppInboxMessageContext<Result>
        ) => Promise<Result>;
    }

    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
        readonly database: PSqlSql;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
    }
}

export class AppInboxHandlerRegistry {
    readonly transactionWriter: AppInboxTransactionWriter;

    private readonly inbox: InboxQueueReader;
    private readonly results: AppInboxResultRepository;
    private readonly serviceId: string;
    private readonly timing: RallarTimingSink | undefined;
    private readonly options: AppInboxOptions;
    private readonly registeredTypes = new Set<AppInboxType>();

    constructor(
        dependencies: AppInboxHandlerRegistry.Dependencies,
        config: AppInboxHandlerRegistry.Config
    ) {
        this.inbox = dependencies.inboxQueueReader;
        this.results = dependencies.resourceInboxResultsRepository;
        this.serviceId = config.serviceId;
        this.timing = config.timing;
        this.options = config.options ?? {};
        this.transactionWriter = new AppInboxTransactionWriter({
            database: dependencies.database,
            serviceId: config.serviceId,
            timing: config.timing,
            nowEpochMs: () => this.nowEpochMs(),
            toTimingDetails: (context) => this.toMutationTimingDetails(context)
        });
    }

    async writeMutation<Result>(
        context: AppInboxMessageContext<Result>,
        write: (transaction: PSqlSql) => Promise<Result>
    ): Promise<Result> {
        return await this.transactionWriter.writeMutation(context, write);
    }

    registerHandler<Command, Result>(
        registration: AppInboxHandlerRegistry.Registration<Command, Result>
    ): void {
        const type = registration.type;
        if (this.registeredTypes.has(type)) {
            throw new Error(`AppInbox handler ${type} is already registered by ${this.serviceId}`);
        }
        this.inbox.onInboxMessageDo(registration.type, {
            onMessage: async (message, entry) => {
                await this.handleRegisteredMessage(registration, message, entry);
            }
        });
        this.registeredTypes.add(type);
    }

    private async handleRegisteredMessage<Command, Result>(
        registration: AppInboxHandlerRegistry.Registration<Command, Result>,
        message: ALMessage,
        entry: ResourceEntry
    ): Promise<void> {
        const type = registration.type;
        const fallbackEnqueue: AppInboxEnqueueInput<JsonWireValue> = {
            type,
            resourceId: entry.key.resourceId,
            contextId: entry.key.contextId,
            data: null
        };
        let context: AppInboxMessageContext<Result> | undefined;

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
                    resourceId: entry.key.resourceId
                }
            },
            async () => {
                try {
                    const identity = validateAppInboxCommandIdentity(entry);
                    if (!identity.valid) {
                        throw new AppInboxCommandIdentityError(
                            identity.identity.operationSource
                        );
                    }
                    const enqueue = identity.command;
                    const command = registration.decodeCommand(enqueue.data);
                    const validatedContext: AppInboxMessageContext<Result> = {
                        enqueue,
                        message,
                        entry,
                        encodeResult: registration.encodeResult
                    };
                    context = validatedContext;
                    this.transactionWriter.begin(validatedContext);
                    const result = await this.timePhase(
                        'handler-action',
                        enqueue,
                        entry.key,
                        async () => await registration.handle(command, validatedContext)
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
                            await this.results.replace(
                                toResourceEntryWithUpdatedResource(
                                    entry,
                                    EntityStatus.COMPLETED,
                                    registration.encodeResult(result)
                                )
                            );
                        },
                        { resultStatus: EntityStatus.COMPLETED }
                    );
                }
                catch (error) {
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
                            error
                        );
                        throw error;
                    }
                    const terminalContext = context ?? {
                        enqueue: fallbackEnqueue,
                        message,
                        entry,
                        encodeResult: registration.encodeResult
                    };
                    await this.transactionWriter.writeTerminalFailure(
                        terminalContext,
                        encodeAppInboxFailure(classification.result)
                    );
                    throw new ResourceInboxFinalizedByHandlerError(
                        toFinalizedResourceEntry(
                            terminalContext,
                            EntityStatus.FAILED,
                            this.nowEpochMs()
                        ),
                        error instanceof Error ? error : new Error(String(error))
                    );
                }
            }
        );
    }

    assertRegistrationComplete(expectedTypes: readonly AppInboxType[]): void {
        const missing = expectedTypes.filter((type) => !this.registeredTypes.has(type));
        const unexpected = [...this.registeredTypes].filter(
            (type) => !expectedTypes.includes(type)
        );
        if (missing.length > 0 || unexpected.length > 0) {
            throw new Error(
                `AppInbox handler registration for ${this.serviceId} is incomplete: ` +
                    `missing=${missing.join(',') || 'none'}; ` +
                    `unexpected=${unexpected.join(',') || 'none'}`
            );
        }
    }

    private recordQueueRetryTiming<V>(
        enqueue: AppInboxEnqueueInput<V>,
        entry: ResourceEntry,
        classification: Extract<AppInboxErrorClassification, { kind: 'retryable'; }>,
        error: unknown
    ): void {
        const nowEpochMs = this.timingNowEpochMs();
        const telemetry = readResourceInboxAttemptTelemetry(entry);
        recordRallarTiming({
            sink: this.timing,
            event: {
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
                    errorMessage: classification.message
                }
            },
            status: 'ok',
            durationMs: 0,
            error
        });
    }

    private async timePhase<T, V>(
        operation: string,
        enqueue: AppInboxEnqueueInput<V>,
        key: Key,
        action: () => Promise<T>,
        details: RallarTimingDetails = {}
    ): Promise<T> {
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
                details: { ...this.toTimingDetails(enqueue, key), ...details }
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

    private toMutationTimingDetails(context: AppInboxExecutionMetadata): RallarTimingDetails {
        const nowEpochMs = this.timingNowEpochMs();
        const telemetry = readResourceInboxAttemptTelemetry(context.entry);
        return {
            ...this.toTimingDetails(context.enqueue, context.entry.key),
            attempt: telemetry?.attempt ?? context.entry.dequeueAudit.attempts,
            selectedLane: telemetry?.selectedLane,
            queueAgeMs: telemetry?.queueAgeMs ?? toQueueAgeMs(context.entry, nowEpochMs),
            dueAgeMs: telemetry?.dueAgeMs ?? toDueAgeMs(context.entry, nowEpochMs)
        };
    }

    private nowEpochMs(): number {
        return this.options.nowEpochMs?.() ?? Date.now();
    }

    private timingNowEpochMs(): number {
        return this.options.timingNowEpochMs?.() ?? Date.now();
    }
}

function toQueueAgeMs(entry: ResourceEntry, nowEpochMs: number): number | undefined {
    try {
        return Math.max(
            0,
            nowEpochMs - entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds
        );
    }
    catch {
        return undefined;
    }
}

function toDueAgeMs(entry: ResourceEntry, nowEpochMs: number): number {
    const dueAtEpochMs = entry.dequeueAudit.nextTs
        ? Number(entry.dequeueAudit.nextTs.epochMilliseconds)
        : Number(entry.dequeueAudit.startTs?.epochMilliseconds ?? nowEpochMs);
    return Math.max(0, nowEpochMs - dueAtEpochMs);
}
