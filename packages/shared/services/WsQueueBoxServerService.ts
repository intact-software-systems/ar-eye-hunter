import type {QueueBoxResourceEntryRepository,} from "../queuebox/QueueBoxTypes.ts";
import {ConnectionContext, JsonWebSocketServer} from "../websocket/JsonWebSocketServer.ts";
import {ResourceEntry, toResourceEntry} from "../queuebox/ResourceEntry.ts";
import {ResilienceDto} from "../queuebox/DequeueResourceEntryController.ts";
import {OnInboxWebSocketMessageCallback} from "./InboxOutboxContracts.ts";
import {ALMessage} from "../al-contracts/al-contract.ts";
import {QueueBoxUtilities} from "./QueueBoxUtilities.ts";

export type WsQueueBoxInboxDto = {
    id: string,
    data: ALMessage
}

export class WsQueueBoxServerService {
    private static readonly ALL_IN: string = "*"

    private readonly onInboxWebSocketMessageCallbacks = new Map<string, OnInboxWebSocketMessageCallback<WsQueueBoxInboxDto>>();

    constructor(
        public readonly inbox: QueueBoxResourceEntryRepository,
        public readonly outbox: QueueBoxResourceEntryRepository,
        public readonly socket: JsonWebSocketServer,
        public readonly name: string
    ) {
        this.socket.onMessageDo(
            name,
            {
                onMessage: async (ctx: ConnectionContext, data: unknown, _) => {
                    const message = JSON.parse(data as string) as ALMessage;

                    await this.inbox.enqueue(
                        toResourceEntry<WsQueueBoxInboxDto>(
                            message.payload.typeId,
                            {
                                id: ctx.id,
                                data: message
                            },
                        )
                    )
                }
            }
        )
    }

    onAllInboxMessagesDo(callback: OnInboxWebSocketMessageCallback<WsQueueBoxInboxDto>): WsQueueBoxServerService {
        this.onInboxWebSocketMessageCallbacks.set(WsQueueBoxServerService.ALL_IN, callback);
        return this;
    }

    onInboxMessageDo(id: string, callback: OnInboxWebSocketMessageCallback<WsQueueBoxInboxDto>): WsQueueBoxServerService {
        this.onInboxWebSocketMessageCallbacks.set(id, callback);
        return this;
    }

    removeInboxMessageCallback(id: string): boolean {
        return this.onInboxWebSocketMessageCallbacks.delete(id);
    }

    async enqueueOutboxIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return await this.outbox.enqueueIfAbsent(toResourceEntry(message.payload.typeId, message))
    }

    async dequeueOutbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.outbox,
            typesToDequeue,
            resilience,
            (entry) => {
                console.warn(`WARNING! wsQueueBoxServer dequeue outbox has no handler for: ${entry.typeId}: ${entry.resource}`);
                return Promise.resolve();
            }
        )
    }

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.inbox,
            typesToDequeue,
            resilience,
            async (entry) => {

                const message = JSON.parse(entry.resource) as WsQueueBoxInboxDto;

                {
                    const callback = this.onInboxWebSocketMessageCallbacks.get(message.data.payload.typeId);
                    await this.onMessageIfPresent(callback, message, entry);
                }

                {
                    const wildcard = this.onInboxWebSocketMessageCallbacks.get(WsQueueBoxServerService.ALL_IN)
                    await this.onMessageIfPresent(wildcard, message, entry);
                }
            }
        )
    }

    private async onMessageIfPresent(
        callback: OnInboxWebSocketMessageCallback<WsQueueBoxInboxDto> | undefined,
        message: WsQueueBoxInboxDto,
        entry: ResourceEntry
    ) {

        try {
            await callback?.onMessage(message, entry, this.socket)
        } catch (e) {
            console.error("Error calling onMessage callback", e)
        }

        if (!callback) {
            console.warn("No callback for typeId {}", message.data.payload.typeId);
        }
    }
}
