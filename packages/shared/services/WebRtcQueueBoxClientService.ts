import {QueueBoxResourceEntryRepository} from "../queuebox/QueueBoxTypes.ts";
import {MyWebRtcChannel} from "../webrtc/MyWebRtcChannel.ts";
import {OnMessageCallback, OnOutboxWebRtcMessageCallback} from "./InboxOutboxContracts.ts";
import {QueueBoxUtilities} from "./QueueBoxUtilities.ts";
import {ResilienceDto} from "../queuebox/DequeueResourceEntryController.ts";


export type WebRtcQueueBoxClientServiceInputDto = {
    readonly inboxTypeId: string;
    readonly outboxTypeId: string;
}


// 1: WebSocket signaling to exchange SDP information
// 2. Set up WebRTC connection

export type SendToPeerDto = {
    peerId: string,
    data: unknown
}

export class WebRtcQueueBoxClientService {

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebRtcMessageCallback> = new Map<string, OnOutboxWebRtcMessageCallback>();
    private readonly onMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();

    public readonly inboxTypesToDequeue: Set<string>;
    public readonly outboxTypesToDequeue: Set<string>;

    // peerId -> JsonWebRtcClient
    readonly connectedPeers: Map<string, MyWebRtcChannel> = new Map<string, MyWebRtcChannel>();

    constructor(
        private readonly inbox: QueueBoxResourceEntryRepository,
        private readonly outbox: QueueBoxResourceEntryRepository,
        private readonly webrtc: MyWebRtcChannel,
        public readonly input: WebRtcQueueBoxClientServiceInputDto
    ) {
        this.inboxTypesToDequeue = new Set([this.input.inboxTypeId]);
        this.outboxTypesToDequeue = new Set([this.input.outboxTypeId]);
    }

    onOutboxMessageDo(id: string, callback: OnOutboxWebRtcMessageCallback): WebRtcQueueBoxClientService {
        this.onOutboxMessageCallbacks.set(id, callback);
        return this;
    }

    removeOutboxMessageCallback(id: string): boolean {
        return this.onOutboxMessageCallbacks.delete(id);
    }

    onInboxMessageDo(id: string, callback: OnMessageCallback): WebRtcQueueBoxClientService {
        this.onMessageCallbacks.set(id, callback);
        return this;
    }

    removeInboxMessageCallback(id: string): boolean {
        return this.onMessageCallbacks.delete(id);
    }

    acceptFromPeer(peerId: string, client: MyWebRtcChannel) {
        this.connectedPeers.set(peerId, client)
    }

    // aka. call-peer
    connectToPeer(peerId: string): MyWebRtcChannel {
        // TODO: implement
        return new MyWebRtcChannel()
    }

    enableDefaultCallbacks(): WebRtcQueueBoxClientService {
        this.onOutboxMessageDo(
            this.input.outboxTypeId,
            {
                onMessage: async (entry, channel) => {
                    console.log(`${this.input.outboxTypeId}: ${entry.resource}`);
                    // TODO: channel.sendAsJsonString(entry.resource);
                }
            }
        )

        for (const [peerId, channel] of this.connectedPeers.entries()) {

            // channel.onMessageDo(
            //     this.input.inboxTypeId,
            //     {
            //         onMessage: async (data) => {
            //             console.log(`${this.input.inboxTypeId}:  ${data}`);
            //             await this.inbox.enqueue(QueueBoxUtilities.toResourceEntry(this.input.inboxTypeId, data));
            //         }
            //     }
            // )
        }

        return this
    }

    async sendToPeer(data: SendToPeerDto) {
        return await this.outbox.enqueue(QueueBoxUtilities.toResourceEntry(this.input.outboxTypeId, data));
    }

    async dequeueOutbox(resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.outbox,
            this.outboxTypesToDequeue,
            resilience,
            async (entry) => {

                // TODO: Entry resource with routing info

                for (const callback of this.onOutboxMessageCallbacks.values()) {
                    try {
                        // await callback.onMessage(entry, this.socket)
                    } catch (e) {
                        console.error("Error calling onMessage callback", e)
                    }
                }
            }
        )
    }

    async dequeueInbox(resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
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


}