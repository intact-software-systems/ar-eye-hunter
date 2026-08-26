import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { toAppQueueCreatedBy } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { timeRallarAsync, type RallarTimingDetails, type RallarTimingSink } from '../observability/timing.ts';
import { serializeCanonicalMutationCommand, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput, AppInboxMessageContext } from './app-inbox-contracts.ts';
import { toUnavailableAppInboxFailure, type AppInboxFailure } from './app-inbox-failure.ts';
import { normalizeAppInboxOptions, type AppInboxOptions, type NormalizedAppInboxOptions } from './app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from './app-inbox-persistence-ports.ts';
import { toPhysicalAppInboxQueueKey } from './app-inbox-queue-entry.ts';
import { AppInboxReservationClient, type MaterializedAppInboxReservation } from './app-inbox-reservation-client.ts';
import { AppInboxResultWaiter, type AppInboxResultDecoder } from './app-inbox-result-waiter.ts';
import { assertMatchingAppInboxCommand } from './assert-matching-app-inbox-command.ts';
import { toLogicalAppInboxCommand } from './logical-app-inbox-command.ts';

export const SIMPLER_GROUP_STATE_APP_INBOX_TOPIC = 'app-inbox.group-state';
export const SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC = 'app-inbox.client-state';

export namespace AppInboxQueueClient {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: AppInboxEntryRepository;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
    }

    export interface Config {
        readonly serviceId: string;
        readonly defaultTopicId?: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
    }
}

export class AppInboxQueueClient {
    private readonly options: NormalizedAppInboxOptions;
    private readonly optionsInput: AppInboxOptions;
    private readonly resultWaiter: AppInboxResultWaiter;
    private readonly reservationClient: AppInboxReservationClient;
    public readonly inbox: InboxQueueReader;
    public readonly resourceInbox: AppInboxEntryRepository;
    public readonly resourceInboxResults: AppInboxResultRepository;
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
        this.options = normalizeAppInboxOptions(options);
        this.resultWaiter = new AppInboxResultWaiter(
            {
                statusRepository: dependencies.resourceInboxRepository,
                resultRepository: dependencies.resourceInboxResultsRepository
            },
            {
                serviceId: config.serviceId,
                timing: config.timing,
                options: this.options
            }
        );
        this.reservationClient = new AppInboxReservationClient(
            {
                inboxQueueReader: dependencies.inboxQueueReader,
                repository: dependencies.resourceInboxRepository
            },
            { serviceId: config.serviceId }
        );
    }
    async persistReservedEntryAuthority<Result>(
        context: AppInboxMessageContext<Result>,
        authority: JsonWireValue
    ): Promise<void> {
        await this.reservationClient.persistAuthority(context, authority);
    }

    async reserveMaterializedEntry(
        placeholder: AppInboxEnqueueInput,
        materialize: () => Promise<AppInboxEnqueueInput>
    ): Promise<MaterializedAppInboxReservation> {
        return await this.reservationClient.reserveMaterializedEntry(placeholder, materialize);
    }

    async waitForReservedEntryResult<R>(
        enqueue: AppInboxEnqueueInput,
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

    public processEntryNoWaiting(enqueue: AppInboxEnqueueInput): void {
        this.processEntryUntilCompletionInternal(
            enqueue,
            false,
            true,
            async (key, wireEnqueue) => {
                return await this.inbox.enqueueIfAbsent(
                    newALUntargetedMessage(
                        toAppQueueCreatedBy(this.serviceId),
                        newALRoute(key.topicId, key.contextId, key.resourceId),
                        wireEnqueue.type.toString(),
                        wireEnqueue
                    )
                );
            },
            decodeJsonWireResult
        ).catch((caught) => {
            const error = caught instanceof Error ? caught : new Error(String(caught));
            console.error('Error processing AppInbox entry without waiting', error);
        });
    }

    public async enqueue(enqueue: AppInboxEnqueueInput): Promise<ResourceEntry> {
        const key = this.toKey(enqueue);
        const receivedIdentity = serializeCanonicalMutationCommand(
            toLogicalAppInboxCommand(enqueue)
        );
        const entry = await this.inbox.enqueueIfAbsent(
            newALUntargetedMessage(
                toAppQueueCreatedBy(this.serviceId),
                newALRoute(key.topicId, key.contextId, key.resourceId),
                enqueue.type.toString(),
                enqueue
            )
        );
        this.wakeOwningQueue?.();
        await assertMatchingAppInboxCommand(entry, enqueue, receivedIdentity);
        return entry;
    }

    public async processEntryUntilCompletion(
        enqueue: AppInboxEnqueueInput
    ): Promise<Either<AppInboxFailure, JsonWireValue>> {
        return await this.processEntryUntilCompletionInternal(
            enqueue,
            true,
            true,
            async (key, wireEnqueue) => {
                return await this.inbox.enqueueIfAbsent(
                    newALUntargetedMessage(
                        toAppQueueCreatedBy(this.serviceId),
                        newALRoute(key.topicId, key.contextId, key.resourceId),
                        wireEnqueue.type.toString(),
                        wireEnqueue
                    )
                );
            },
            decodeJsonWireResult
        );
    }

    public async processEntryUntilCompletionResult<R>(
        enqueue: AppInboxEnqueueInput,
        decodeResult: AppInboxResultDecoder<R>
    ): Promise<Either<AppInboxFailure, R>> {
        return await this.processEntryUntilCompletionInternal<R>(
            enqueue,
            true,
            true,
            async (key, wireEnqueue) => {
                return await this.inbox.enqueueIfAbsent(
                    newALUntargetedMessage(
                        toAppQueueCreatedBy(this.serviceId),
                        newALRoute(key.topicId, key.contextId, key.resourceId),
                        wireEnqueue.type.toString(),
                        wireEnqueue
                    )
                );
            },
            decodeResult
        );
    }

    async processEntryUntilCompletionIfResult<R>(
        enqueue: AppInboxEnqueueInput,
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
                        toAppQueueCreatedBy(this.serviceId),
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

    private async processEntryUntilCompletionInternal<R>(
        enqueue: AppInboxEnqueueInput,
        waitForCompletion: boolean,
        enforceCommandIdentity: boolean,
        enqueuer: (
            key: Key,
            wireEnqueue: AppInboxEnqueueInput
        ) => Promise<ResourceEntry | undefined>,
        decodeResult: AppInboxResultDecoder<R>,
        strictQueueIdentity = false
    ): Promise<Either<AppInboxFailure, R>> {
        const key: Key = this.toKey(enqueue, strictQueueIdentity);
        const receivedCommandIdentity = enforceCommandIdentity
            ? serializeCanonicalMutationCommand(toLogicalAppInboxCommand(enqueue))
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
                    async () => await enqueuer(key, enqueue)
                );
                if (entry) {
                    this.wakeOwningQueue?.();
                }
                if (entry && enforceCommandIdentity) {
                    if (!receivedCommandIdentity) {
                        throw new Error('App inbox command identity was not captured');
                    }
                    await assertMatchingAppInboxCommand(entry, enqueue, receivedCommandIdentity);
                }

                if (!waitForCompletion) {
                    return Either.ofLeft(toUnavailableAppInboxFailure());
                }

                return await this.resultWaiter.waitForResult(enqueue, key, decodeResult);
            }
        );
    }

    private async timePhase<T>(
        operation: string,
        enqueue: AppInboxEnqueueInput,
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

    private toTimingDetails(enqueue: AppInboxEnqueueInput, key: Key): RallarTimingDetails {
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

    private toKey(enqueue: AppInboxEnqueueInput, strictQueueIdentity = false): Key {
        return toPhysicalAppInboxQueueKey(enqueue, this.defaultTopicId, strictQueueIdentity);
    }
}

function decodeJsonWireResult(value: JsonWireValue): JsonWireValue {
    return value;
}
