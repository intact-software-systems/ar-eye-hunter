import { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';

export class InboxQueueReader {
    public static readonly INBOX_ENQUEUE_TYPE = EnqueuedType.APP_INBOX;
    public static readonly INBOX_DEQUEUE_TYPES = new Set<string>([
        this.INBOX_ENQUEUE_TYPE,
    ]);

    private readonly onInboxMessageCallbacks = new Map<string, OnMessageCallback>();

    constructor(public readonly inbox: QueueBoxResourceEntryRepository) {}

    onInboxMessageDo(type: string, callback: OnMessageCallback): this {
        this.onInboxMessageCallbacks.set(type, callback);
        return this;
    }

    removeInboxMessageCallback(type: string): boolean {
        return this.onInboxMessageCallbacks.delete(type);
    }

    async enqueueIfAbsent(message: ALMessage) {
        await this.inbox.enqueueIfAbsent(
            QueueBoxUtilities.toResourceEntryFromMsg(
                message,
                InboxQueueReader.INBOX_ENQUEUE_TYPE,
            )
        );
    }

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.inbox,
            typesToDequeue,
            resilience,
            async (entry) => {
                const msg = JSON.parse(entry.resource) as ALMessage;
                const callback = this.onInboxMessageCallbacks.get(msg.payload.typeId);
                if (!callback) {
                    throw new Error(
                        `No APP_INBOX callback registered for type ${msg.payload.typeId}`,
                    );
                }

                await callback.onMessage(msg, entry);
            },
        );
    }
}
