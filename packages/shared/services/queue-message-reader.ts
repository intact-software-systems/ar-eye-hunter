import type { ALMessage } from '../al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '../api/api-config.ts';
import type { DequeueController } from '../queuebox/dequeue/dequeue-controller.ts';
import type { DequeueLaneFlight } from '../queuebox/dequeue/dequeue-lane-flight.ts';
import type { QueueBoxResourceEntryRepository, ResourceInboxClaimOrder } from '../queuebox/queue-box-types.ts';
import {
    NonRetryableException,
    ResourceInboxHandlerEntryError,
    type DequeueResourceEntryOptions
} from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type {
    ResourceInboxAttempt,
    ResourceInboxAttemptTelemetry
} from '../queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import type { ResourceInboxHandlerOutcome } from '../queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import type { ResourceInboxResilience } from '../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { Key, ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { readRtcTopologyWorkEntry, RTC_TOPOLOGY_OUTBOX_TOPIC } from '../queuebox/rtc-topology-work-entry-contract.ts';
import { QueueBoxUtilities } from './queue-box-utilities.ts';
import type { OnQueuedMessageCallback, OnRejectedQueuedMessageCallback } from './queue-message-callbacks.ts';

export namespace QueueMessageReader {
    export interface Config {
        readonly enqueueType: string;
        readonly creationNow: QueueBoxUtilities.CreationClock;
        readonly dequeueOptions: DequeueResourceEntryOptions;
    }

    export interface DequeueInput {
        readonly typesToDequeue: Set<string>;
        readonly resilience: ResourceInboxResilience;
        readonly newLaneClaimOrder: ResourceInboxClaimOrder;
        readonly readLaneBudgets: DequeueController.ReadLaneBudgets | undefined;
        readonly workAdvertisement: DequeueController.WorkAdvertisement | undefined;
        /** Absent, the pass drains what it claims before it resolves. */
        readonly standingFlight:
            | DequeueLaneFlight<Key, ResourceInboxAttempt, ResourceInboxHandlerOutcome | undefined>
            | undefined;
    }

    /**
     * The lifecycle of one engine pass over this queue: a probe, then the pass it advertised, with every entry the
     * pass claimed and the handler of every claimed entry, which with a standing flight may run after the pass. One
     * observer at a time; the owner measures what it will at each step.
     */
    export interface DequeuePassObserver extends QueueBoxUtilities.DequeueHandlerObserver {
        onProbeStarted(): void;
        onProbeFinished(advertisedLanes: DequeueController.WorkAdvertisement): void;
        onPassStarted(): void;
        onPassFinished(): void;
    }
}

export class QueueMessageReader {
    private readonly callbacks = new Map<string, OnQueuedMessageCallback>();
    private rejectedMessageCallback: OnRejectedQueuedMessageCallback | undefined;
    private dequeuePassObserver: QueueMessageReader.DequeuePassObserver | undefined;
    private readonly repository: QueueBoxResourceEntryRepository;
    private readonly config: QueueMessageReader.Config;

    constructor(repository: QueueBoxResourceEntryRepository, config: QueueMessageReader.Config) {
        this.repository = repository;
        this.config = config;
    }

    /** The persisted message a claimed entry carries, as the dispatcher reads it; malformed throws. */
    static decodeQueuedMessage(entry: ResourceEntry): ALMessage {
        return entry.typeId === EnqueuedType.APP_OUTBOX && entry.key.topicId === RTC_TOPOLOGY_OUTBOX_TOPIC
            ? readRtcTopologyWorkEntry(entry)
            : decodePersistedALMessage(entry.resource);
    }

    onMessageDo(type: string, callback: OnQueuedMessageCallback): void {
        this.callbacks.set(type, callback);
    }

    removeMessageCallback(type: string): boolean {
        return this.callbacks.delete(type);
    }

    onRejectedMessageDo(callback: OnRejectedQueuedMessageCallback): void {
        this.rejectedMessageCallback = callback;
    }

    onDequeuePassDo(observer: QueueMessageReader.DequeuePassObserver): void {
        if (this.dequeuePassObserver !== undefined) {
            throw new Error('A dequeue-pass observer is already installed on this queue reader');
        }
        this.dequeuePassObserver = observer;
    }

    async enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return await this.repository.enqueueIfAbsent(
            QueueBoxUtilities.toResourceEntryFromMsg(message, this.config.enqueueType, this.config.creationNow())
        );
    }

    /** One storage read naming the lanes the next pass may claim from; the engine's work probe for this queue. */
    async readWorkAdvertisement(
        typesToDequeue: Set<string>,
        resilience: ResourceInboxResilience
    ): Promise<DequeueController.WorkAdvertisement> {
        this.dequeuePassObserver?.onProbeStarted();
        const advertisedLanes = await this.repository.readWorkAdvertisement(
            typesToDequeue,
            resilience.toWorkAdvertisementOptions()
        );
        this.dequeuePassObserver?.onProbeFinished(advertisedLanes);
        return advertisedLanes;
    }

    /** Resolves with the number of entries this invocation claimed; a preceding probe limits the lanes it offers. */
    async dequeue(input: QueueMessageReader.DequeueInput): Promise<number> {
        const observer = this.dequeuePassObserver;
        observer?.onPassStarted();
        try {
            return await QueueBoxUtilities.defaultDequeue(
                {
                    qbox: this.repository,
                    typesToDequeue: input.typesToDequeue,
                    resilience: input.resilience,
                    newLaneClaimOrder: input.newLaneClaimOrder,
                    onDequeuedDo: (entry, attemptTelemetry) => this.dispatchQueuedMessage(entry, attemptTelemetry),
                    options: this.config.dequeueOptions,
                    readLaneBudgets: input.readLaneBudgets,
                    workAdvertisement: input.workAdvertisement,
                    handlerObserver: observer,
                    standingFlight: input.standingFlight
                }
            );
        }
        finally {
            observer?.onPassFinished();
        }
    }

    private async dispatchQueuedMessage(
        entry: ResourceEntry,
        attemptTelemetry: ResourceInboxAttemptTelemetry
    ): Promise<void | ResourceInboxHandlerOutcome> {
        let message: ALMessage;
        try {
            message = QueueMessageReader.decodeQueuedMessage(entry);
        }
        catch {
            const error = new NonRetryableException('Persisted queue message is malformed or unsupported');
            if (this.rejectedMessageCallback) {
                const finalized = await this.rejectedMessageCallback.onRejectedMessage(entry, attemptTelemetry, error);
                throw new ResourceInboxHandlerEntryError(finalized, error);
            }
            throw error;
        }
        const callback = this.callbacks.get(message.payload.typeId);
        if (!callback) {
            throw new Error(`No ${this.config.enqueueType} callback registered for type ${message.payload.typeId}`);
        }
        return await callback.onMessage(message, entry, attemptTelemetry);
    }
}
