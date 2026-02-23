import {DequeueController} from "../queuebox/DequeueController.ts";
import {DequeueResourceEntryController, ResilienceDto} from "../queuebox/DequeueResourceEntryController.ts";
import {QueueBoxResourceEntryRepository} from "../queuebox/QueueBoxTypes.ts";
import {EntityStatus, Key, ResourceEntry} from "../queuebox/ResourceEntry.ts";
import {JsonWebSocketClient} from "./JsonWebSocketClient.ts";
import {tryWith} from "../resilience/TryWith.ts";
import {OnMessageCallback, OnOutboxWebSocketMessageCallback} from "./inbox-outbox-contracts.ts";

export type WsQueueBoxClientServiceInputDto = {
    readonly inboxTypeId: string;
    readonly outboxTypeId: string;
}

export class WsQueueBoxClientService {
    private reconnectTask?: Promise<unknown> = undefined;

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebSocketMessageCallback> = new Map<string, OnOutboxWebSocketMessageCallback>();
    private readonly onMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();

    public readonly inboxTypesToDequeue: Set<string>;
    public readonly outboxTypesToDequeue: Set<string>;

    constructor(
        public readonly inbox: QueueBoxResourceEntryRepository,
        public readonly outbox: QueueBoxResourceEntryRepository,
        public readonly socket: JsonWebSocketClient,
        public readonly input: WsQueueBoxClientServiceInputDto
    ) {
        this.inboxTypesToDequeue = new Set([this.input.inboxTypeId]);
        this.outboxTypesToDequeue = new Set([this.input.outboxTypeId]);
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
                "WsQueueBoxClientService-" + this.input.inboxTypeId,
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
                this.input.outboxTypeId,
                {
                    onMessage: async (entry, socket) => {
                        console.log(`${this.input.outboxTypeId}: ${entry.resource}`);
                        socket.sendAsJsonString(entry.resource);
                    }
                }
            )

        this.socket
            .onWebSocketMessageDo(
                this.input.inboxTypeId,
                {
                    onMessage: async (data) => {
                        console.log(`${this.input.inboxTypeId}:  ${data}`);
                        await this.inbox.enqueue(this.toEntry(this.input.inboxTypeId, data));
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

    toEntry<T>(typeId: string, resource: T): ResourceEntry {
        return {
            key: {
                topicId: typeId,
                resourceId: crypto.randomUUID().toString(),
                contextId: "test"
            },
            resource: JSON.stringify(resource),
            typeId: typeId,
            audit: {
                date: Temporal.Now.plainTimeISO(),
                createdBy: "test",
                createdTs: Temporal.Now.plainDateTimeISO()
            },
            status: EntityStatus.NEW,
            dequeueAudit: {
                attempts: 0
            },
            db: undefined
        }
    }

    async dequeueOutbox(resilience: ResilienceDto) {
        if (resilience.isNotAllowedThroughToDequeue()) {
            console.warn("Dequeue blocked {}, circuit state {}", this.outboxTypesToDequeue, resilience.circuitBreaker.state.get());
            return;
        }

        await WsQueueBoxClientService.dequeue(
            this.outbox,
            this.outboxTypesToDequeue,
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

    async dequeueInbox(resilience: ResilienceDto) {
        if (resilience.isNotAllowedThroughToDequeue()) {
            console.warn("Dequeue blocked {}, circuit state {}", this.inboxTypesToDequeue, resilience.circuitBreaker.state.get());
            return;
        }

        await WsQueueBoxClientService.dequeue(
            this.inbox,
            this.inboxTypesToDequeue,
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

    private static async dequeue(
        qbox: QueueBoxResourceEntryRepository,
        typesToDequeue: Set<string>,
        resilience: ResilienceDto,
        onDequeuedDo: (entry: ResourceEntry) => Promise<void>
    ) {
        await DequeueResourceEntryController.toDequeuer<Key>(
                qbox,
                () => typesToDequeue,
                () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE,
                DequeueController.DEFAULT_MAX_RETRY,
                DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE,
                resilience
            )
            .onFailedEntries(
                _ => resilience.failure()
            )
            .onCompletedEntries(
                _ => resilience.success()
            )
            .dequeueForCompute(
                async (key, entry) => {
                    await onDequeuedDo(entry)
                    return key
                }
            )
    }

}