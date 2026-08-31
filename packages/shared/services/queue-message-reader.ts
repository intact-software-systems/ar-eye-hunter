import type { ALMessage } from '../al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../al-contracts/al-message-persistence-validation.ts';
import type { DequeueResourceEntryOptions, ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../queuebox/ResourceEntry.ts';

import type { OnMessageCallback } from './queue-message-callbacks.ts';
import { QueueBoxUtilities } from './QueueBoxUtilities.ts';

export namespace QueueMessageReader {
    export interface Config {
        readonly enqueueType: string;
        readonly dequeueOptions: DequeueResourceEntryOptions;
    }
}

export class QueueMessageReader {
    private readonly callbacks = new Map<string, OnMessageCallback>();
    private readonly repository: QueueBoxResourceEntryRepository;
    private readonly config: QueueMessageReader.Config;

    constructor(repository: QueueBoxResourceEntryRepository, config: QueueMessageReader.Config) {
        this.repository = repository;
        this.config = config;
    }

    onMessageDo(type: string, callback: OnMessageCallback): void {
        this.callbacks.set(type, callback);
    }

    removeMessageCallback(type: string): boolean {
        return this.callbacks.delete(type);
    }

    async enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return await this.repository.enqueueIfAbsent(
            QueueBoxUtilities.toResourceEntryFromMsg(message, this.config.enqueueType)
        );
    }

    async enqueueIf(
        message: ALMessage,
        enqueueIf: (entry: ResourceEntry) => boolean
    ): Promise<ResourceEntry | undefined> {
        return await this.repository.enqueueIf(
            QueueBoxUtilities.toResourceEntryFromMsg(message, this.config.enqueueType),
            enqueueIf
        );
    }

    async dequeue(typesToDequeue: Set<string>, resilience: ResilienceDto): Promise<void> {
        await QueueBoxUtilities.defaultDequeue(
            this.repository,
            typesToDequeue,
            resilience,
            (entry) => this.dispatchQueuedMessage(entry),
            this.config.dequeueOptions
        );
    }

    private async dispatchQueuedMessage(entry: ResourceEntry): Promise<void> {
        const message = decodePersistedALMessage(entry.resource);
        const callback = this.callbacks.get(message.payload.typeId);
        if (!callback) {
            throw new Error(`No ${this.config.enqueueType} callback registered for type ${message.payload.typeId}`);
        }
        await callback.onMessage(message, entry);
    }
}
