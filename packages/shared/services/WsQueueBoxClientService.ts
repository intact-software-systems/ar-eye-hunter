import { ResilienceDto } from "../queuebox/DequeueResourceEntryController.ts";
import { QueueBoxResourceEntryRepository } from "../queuebox/QueueBoxTypes.ts";
import { tryWith } from "../resilience/TryWith.ts";
import { OnMessageCallback, OnOutboxWebSocketMessageCallback } from "./InboxOutboxContracts.ts";
import { JsonWebSocketClient } from "../websocket/JsonWebSocketClient.ts";
import { QueueBoxUtilities } from "./QueueBoxUtilities.ts";
import { ALMessage } from "../al-contracts/al-contract.ts";
import { ResourceEntry, toResourceEntry } from "../queuebox/ResourceEntry.ts";

export type WsQueueBoxClientServiceInputDto = {
    readonly sessionId: string;
}

export class WsQueueBoxClientService {
    private reconnectTask?: Promise<unknown> = undefined;

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebSocketMessageCallback> = new Map<string, OnOutboxWebSocketMessageCallback>();
    private readonly onMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();

    constructor(
        public readonly inbox: QueueBoxResourceEntryRepository,
        public readonly outbox: QueueBoxResourceEntryRepository,
        public readonly socket: JsonWebSocketClient,
        public readonly input: WsQueueBoxClientServiceInputDto
    ) {
    }

    onOutboxMessageDo(id: string, callback: OnOutboxWebSocketMessageCallback): WsQueueBoxClientService {
        this.onOutboxMessageCallbacks.set(id, callback);
        return this;
    }

    removeOutboxMessageCallback(id: string): boolean {
        return this.onOutboxMessageCallbacks.delete(id);
    }

    onInboxMessageDo(id: string, callback: OnMessageCallback): WsQueueBoxClientService {
        this.onMessageCallbacks.set(id, callback);
        return this;
    }

    removeInboxMessageCallback(id: string): boolean {
        return this.onMessageCallbacks.delete(id);
    }

    enableReconnect(): WsQueueBoxClientService {
        this.socket
            .onWebsocketCallbacksDo(
                this.input.sessionId,
                {
                    onOpen: () => {
                        // TODO: Anything to do?
                    },
                    onClose: () => this.reconnect(),
                    onError: () => this.reconnect()
                }
            )
        return this
    }

    enableDefaultCallbacks(): WsQueueBoxClientService {
        this
            .onOutboxMessageDo(
                this.input.sessionId + "-outbox",
                {
                    onMessage: (entry, socket) => {
                        console.log(`${this.input.sessionId} outbox: ${entry.resource}`);
                        socket.sendAsJsonString(entry.resource);

                        return Promise.resolve();
                    }
                }
            )

        this.socket
            .onWebSocketMessageDo(
                this.input.sessionId + "-inbox",
                {
                    onMessage: async data => {
                        console.log(`${this.input.sessionId} inbox:  ${JSON.stringify(data)}`);

                        const message: ALMessage = data as ALMessage;

                        await this.inbox.enqueueIfAbsent(
                            QueueBoxUtilities.toResourceEntryFromMsg(message)
                        );
                    }
                }
            )

        return this
    }

    private reconnect() {
        if (this.reconnectTask) {
            return;
        }

        this.reconnectTask =
            tryWith<unknown>(
                async () => {
                    try {
                        await this.socket.connect()
                    } finally {
                        this.reconnectTask = undefined;
                    }
                }
            )
    }

    async enqueueOutboxIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return await this.outbox.enqueueIfAbsent(toResourceEntry(message.payload.typeId, message))
    }

    async dequeueOutbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.outbox,
            typesToDequeue,
            resilience,
            async (entry) => {
                for (const callback of this.onOutboxMessageCallbacks.values()) {
                    try {
                        await callback.onMessage(entry, this.socket)
                    } catch (e) {
                        console.error("Error calling onMessage callback", e)
                    }
                }
            }
        )
    }

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.inbox,
            typesToDequeue,
            resilience,
            async (entry) => {
                for (const callback of this.onMessageCallbacks.values()) {
                    try {
                        await callback.onMessage(entry)
                    } catch (e) {
                        console.error("Error calling onMessage callback", e)
                    }
                }
            }
        )
    }
}