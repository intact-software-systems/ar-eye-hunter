import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { createQueueMessageReader, type QueueMessageReader } from '@shared/services/QueueMessageReader.ts';

export class OutboxQueueReader {
    public static readonly OUTBOX_ENQUEUE_TYPE = EnqueuedType.APP_OUTBOX;
    public static readonly OUTBOX_DEQUEUE_TYPES = new Set<string>([
        this.OUTBOX_ENQUEUE_TYPE
    ]);

    private readonly reader: QueueMessageReader;

    public readonly outbox: QueueBoxResourceEntryRepository;

    constructor(outbox: QueueBoxResourceEntryRepository) {
        this.outbox = outbox;
        this.reader = createQueueMessageReader({
            repository: outbox,
            enqueueType: OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
            queueName: 'APP_OUTBOX'
        });
    }

    onOutboxMessageDo(type: string, callback: OnMessageCallback): this {
        this.reader.onMessageDo(type, callback);
        return this;
    }

    removeOutboxMessageCallback(type: string): boolean {
        return this.reader.removeMessageCallback(type);
    }

    async enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return await this.reader.enqueueIfAbsent(message);
    }

    async enqueueIf(
        message: ALMessage,
        enqueueIf: (entry: ResourceEntry) => boolean
    ): Promise<ResourceEntry | undefined> {
        return await this.reader.enqueueIf(message, enqueueIf);
    }

    async dequeueOutbox(
        typesToDequeue: Set<string>,
        resilience: ResilienceDto
    ): Promise<void> {
        await this.reader.dequeue(typesToDequeue, resilience);
    }
}
