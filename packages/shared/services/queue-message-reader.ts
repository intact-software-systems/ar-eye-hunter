import type { ALMessage } from '../al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '../api/api-config.ts';
import {
    NonRetryableException,
    ResourceInboxHandlerEntryError,
    type DequeueResourceEntryOptions,
    type ResilienceDto
} from '../queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import type { ResourceInboxAttemptTelemetry } from '../queuebox/ResourceInboxAttemptTelemetry.ts';
import { readRtcTopologyWorkEntry, RTC_TOPOLOGY_OUTBOX_TOPIC } from '../queuebox/rtc-topology-work-entry-contract.ts';

import type { OnQueuedMessageCallback, OnRejectedQueuedMessageCallback } from './queue-message-callbacks.ts';
import { QueueBoxUtilities } from './QueueBoxUtilities.ts';

export namespace QueueMessageReader {
    export interface Config {
        readonly enqueueType: string;
        readonly dequeueOptions: DequeueResourceEntryOptions;
    }
}

export class QueueMessageReader {
    private readonly callbacks = new Map<string, OnQueuedMessageCallback>();
    private rejectedMessageCallback: OnRejectedQueuedMessageCallback | undefined;
    private readonly repository: QueueBoxResourceEntryRepository;
    private readonly config: QueueMessageReader.Config;

    constructor(repository: QueueBoxResourceEntryRepository, config: QueueMessageReader.Config) {
        this.repository = repository;
        this.config = config;
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

    async enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return await this.repository.enqueueIfAbsent(
            QueueBoxUtilities.toResourceEntryFromMsg(message, this.config.enqueueType)
        );
    }

    async dequeue(typesToDequeue: Set<string>, resilience: ResilienceDto): Promise<void> {
        await QueueBoxUtilities.defaultDequeue(
            this.repository,
            typesToDequeue,
            resilience,
            (entry, attemptTelemetry) => this.dispatchQueuedMessage(entry, attemptTelemetry),
            this.config.dequeueOptions
        );
    }

    private async dispatchQueuedMessage(
        entry: ResourceEntry,
        attemptTelemetry: ResourceInboxAttemptTelemetry
    ): Promise<void> {
        let message: ALMessage;
        try {
            message = entry.typeId === EnqueuedType.APP_OUTBOX && entry.key.topicId === RTC_TOPOLOGY_OUTBOX_TOPIC
                ? readRtcTopologyWorkEntry(entry)
                : decodePersistedALMessage(entry.resource);
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
        await callback.onMessage(message, entry, attemptTelemetry);
    }
}
