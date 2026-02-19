import {DequeueController} from "../queuebox/DequeueController.ts";
import {DequeueResourceEntryController, ResilienceDto} from "../queuebox/DequeueResourceEntryController.ts";
import {QueueBoxResourceEntryRepository} from "../queuebox/QueueBoxTypes.ts";
import {EntityStatus, Key, ResourceEntry} from "../queuebox/ResourceEntry.ts";
import {JsonWebSocketClient} from "./JsonWebSocketClient.ts";
import {tryWith} from "../resilience/TryWith.ts";
import {OnOutboxWebSocketMessageCallback} from "./inbox-outbox-contracts.ts";

export type WsQueueBoxClientServiceInputDto = {
    readonly typeId: string;
}

export class WsQueueBoxClientService {
    private reconnectTask?: Promise<unknown> = undefined;

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebSocketMessageCallback> = new Map<string, OnOutboxWebSocketMessageCallback>();
    private readonly typesToDequeue: Set<string>;

    constructor(
        public readonly inbox: QueueBoxResourceEntryRepository,
        public readonly outbox: QueueBoxResourceEntryRepository,
        public readonly socket: JsonWebSocketClient,
        public readonly input: WsQueueBoxClientServiceInputDto
    ) {
        this.typesToDequeue = new Set([this.input.typeId]);
    }

    onOutboxMessageDo(id: string, callback: OnOutboxWebSocketMessageCallback): WsQueueBoxClientService {
        this.onOutboxMessageCallbacks.set(id, callback);
        return this;
    }

    removeOutboxMessageCallback(id: string): boolean {
        return this.onOutboxMessageCallbacks.delete(id);
    }

    enableReconnect(): WsQueueBoxClientService {
        this.socket
            .onWebsocketCallbacksDo(
                "WsQueueBoxClientService-" + this.input.typeId,
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

    toEntry<T>(resource: T): ResourceEntry {
        return {
            key: {
                topicId: this.input.typeId,
                resourceId: crypto.randomUUID().toString(),
                contextId: "test"
            },
            resource: JSON.stringify(resource),
            typeId: this.input.typeId,
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

    async dequeueOutboxToSend(resilience: ResilienceDto) {
        if (resilience.isNotAllowedThroughToDequeue()) {
            console.warn("Dequeue blocked {}, circuit state {}", this.typesToDequeue, resilience.circuitBreaker.state.get());
            return;
        }

        await DequeueResourceEntryController.toDequeuer<Key>(
                this.outbox,
                () => this.typesToDequeue,
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
                    for (const callback of this.onOutboxMessageCallbacks.values()) {
                        try {
                            await callback.onMessage(entry, this.socket)
                        } catch (e) {
                            console.error("Error calling onMessage callback", e)
                        }
                    }
                    return key
                }
            )
    }
}