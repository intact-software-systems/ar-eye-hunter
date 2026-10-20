import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnQueuedMessageCallback } from '@shared/services/queue-message-callbacks.ts';

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

    /** A handler may answer a typed outcome, such as a retryable conflict with its own retry delay. */
    onOutboxMessageDo(type: string, callback: OnQueuedMessageCallback): this {
        this.reader.onMessageDo(type, callback);
        return this;
    }

    removeOutboxMessageCallback(type: string): boolean {
        return this.reader.removeMessageCallback(type);
    }

    async enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return await this.reader.enqueueIfAbsent(message);
    }

    onDequeuePassDo(observer: QueueMessageReader.DequeuePassObserver): void {
        this.reader.onDequeuePassDo(observer);
    }

    /** One storage read naming the lanes the next pass may claim from; the engine's work probe for this queue. */
    async readWorkAdvertisement(
        typesToDequeue: Set<string>,
        resilience: ResourceInboxResilience
    ): Promise<DequeueController.WorkAdvertisement> {
        return await this.reader.readWorkAdvertisement(typesToDequeue, resilience);
    }

    /** Resolves with the number of entries this invocation claimed; a preceding probe limits the lanes it offers. */
    async dequeueOutbox(
        typesToDequeue: Set<string>,
        resilience: ResourceInboxResilience,
        workAdvertisement?: DequeueController.WorkAdvertisement
    ): Promise<number> {
        return await this.reader.dequeue({
            typesToDequeue,
            resilience,
            newLaneClaimOrder: 'queue',
            readLaneBudgets: undefined,
            workAdvertisement,
            standingFlight: undefined
        });
    }
}
