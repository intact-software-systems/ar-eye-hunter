import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import type { QueueBoxUtilities } from './queue-box-utilities.ts';
import { QueueMessageReader } from './queue-message-reader.ts';

export class OutboxQueueReader {
    public static readonly OUTBOX_ENQUEUE_TYPE = EnqueuedType.APP_OUTBOX;
    public static readonly OUTBOX_DEQUEUE_TYPES = new Set<string>([
        this.OUTBOX_ENQUEUE_TYPE
    ]);

    private readonly reader: QueueMessageReader;

    public readonly outbox: QueueBoxResourceEntryRepository;

    constructor(
        outbox: QueueBoxResourceEntryRepository,
        creationNow: QueueBoxUtilities.CreationClock = Temporal.Now.instant
    ) {
        this.outbox = outbox;
        this.reader = new QueueMessageReader(outbox, {
            enqueueType: OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
            creationNow,
            dequeueOptions: {}
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

    /** Resolves with the number of entries this invocation claimed. */
    async dequeueOutbox(
        typesToDequeue: Set<string>,
        resilience: ResourceInboxResilience
    ): Promise<number> {
        return await this.reader.dequeue(typesToDequeue, resilience);
    }
}
