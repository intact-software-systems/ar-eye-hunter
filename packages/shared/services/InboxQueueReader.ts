import { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { ResilienceDto, type DequeueResourceEntryOptions } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { createQueueMessageReader, type QueueMessageReader } from '@shared/services/QueueMessageReader.ts';

export class InboxQueueReader {
    public static readonly INBOX_ENQUEUE_TYPE = EnqueuedType.APP_INBOX;
    public static readonly INBOX_DEQUEUE_TYPES = new Set<string>([
        this.INBOX_ENQUEUE_TYPE
    ]);

    private readonly reader: QueueMessageReader;

    public readonly inbox: QueueBoxResourceEntryRepository;

    constructor(
        inbox: QueueBoxResourceEntryRepository,
        dequeueOptions: DequeueResourceEntryOptions = {}
    ) {
        this.inbox = inbox;
        this.reader = createQueueMessageReader({
            repository: inbox,
            enqueueType: InboxQueueReader.INBOX_ENQUEUE_TYPE,
            queueName: 'APP_INBOX',
            dequeueOptions
        });
    }

    onInboxMessageDo(type: string, callback: OnMessageCallback): this {
        this.reader.onMessageDo(type, callback);
        return this;
    }

    removeInboxMessageCallback(type: string): boolean {
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

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await this.reader.dequeue(typesToDequeue, resilience);
    }
}
