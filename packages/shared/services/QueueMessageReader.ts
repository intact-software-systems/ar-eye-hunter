import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { DequeueResourceEntryOptions } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

export type QueueMessageReader = Readonly<{
    onMessageDo(type: string, callback: OnMessageCallback): void;
    removeMessageCallback(type: string): boolean;
    enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry>;
    enqueueIf(
        message: ALMessage,
        enqueueIf: (entry: ResourceEntry) => boolean
    ): Promise<ResourceEntry | undefined>;
    dequeue(
        typesToDequeue: Set<string>,
        resilience: ResilienceDto
    ): Promise<void>;
}>;

export function createQueueMessageReader(
    options: Readonly<{
        repository: QueueBoxResourceEntryRepository;
        enqueueType: string;
        queueName: string;
        dequeueOptions?: DequeueResourceEntryOptions;
    }>
): QueueMessageReader {
    const callbacks = new Map<string, OnMessageCallback>();

    return {
        onMessageDo: (type, callback) => {
            callbacks.set(type, callback);
        },
        removeMessageCallback: (type) => callbacks.delete(type),
        enqueueIfAbsent: async (message) =>
            await options.repository.enqueueIfAbsent(
                QueueBoxUtilities.toResourceEntryFromMsg(
                    message,
                    options.enqueueType
                )
            ),
        enqueueIf: async (message, enqueueIf) =>
            await options.repository.enqueueIf(
                QueueBoxUtilities.toResourceEntryFromMsg(
                    message,
                    options.enqueueType
                ),
                enqueueIf
            ),
        dequeue: async (typesToDequeue, resilience) => {
            await QueueBoxUtilities.defaultDequeue(
                options.repository,
                typesToDequeue,
                resilience,
                async (entry) => {
                    const message = JSON.parse(entry.resource) as ALMessage;
                    const callback = callbacks.get(message.payload.typeId);
                    if (!callback) {
                        throw new Error(
                            `No ${options.queueName} callback registered for type ${message.payload.typeId}`
                        );
                    }

                    await callback.onMessage(message, entry);
                },
                options.dequeueOptions
            );
        }
    };
}
