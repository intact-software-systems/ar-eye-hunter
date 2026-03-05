import {QueueBoxResourceEntryRepository} from "../queuebox/QueueBoxTypes.ts";
import {QRtcDataChannel, QRtcDataExchanged} from "../webrtc/QRtcDataChannel.ts";
import {OnMessageCallback, OnOutboxWebRtcMessageCallback} from "./InboxOutboxContracts.ts";
import {QueueBoxUtilities} from "./QueueBoxUtilities.ts";
import {ResilienceDto} from "../queuebox/DequeueResourceEntryController.ts";
import {WsRtcSignalingTransport} from "../webrtc/WsRtcSignalingTransport.ts";
import {IceConfig} from "../api/api-config.ts";
import {ALMessage} from "../al-contracts/al-contract.ts";
import {ResourceEntry} from "../queuebox/ResourceEntry.ts";
import {JsonWebSocketClient} from "../websocket/JsonWebSocketClient.ts";
import {QRtcSignalingMessage} from "../webrtc/QRtcSignalingContracts.ts";


export type WebRtcQueueBoxClientServiceInputDto = {
    readonly sessionId: string
    readonly token: string
    readonly iceCandidates: IceConfig
    readonly dataChannelName: string
    readonly rtcSignalingTopicId: string
}

type PeerId = string

export class WebRtcQueueBoxClientService {

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebRtcMessageCallback> = new Map<string, OnOutboxWebRtcMessageCallback>();
    private readonly onMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();

    private readonly connectedPeers: Map<PeerId, QRtcDataChannel> = new Map<string, QRtcDataChannel>();

    constructor(
        public readonly inbox: QueueBoxResourceEntryRepository,
        public readonly outbox: QueueBoxResourceEntryRepository,
        public readonly socket: JsonWebSocketClient,
        public readonly input: WebRtcQueueBoxClientServiceInputDto
    ) {
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

    async acceptPeerIfAbsent(peerId: string, message: QRtcSignalingMessage) {
        let channel = this.connectedPeers.get(peerId);

        if (channel && !channel.isReadyToConnect()) {
            console.log(`Peer ${peerId} in state ${channel.status.state}. Ignoring signal ${JSON.stringify(message)}`);
            return channel;
        } else if (channel) {
            console.log(`Peer ${peerId} in state ${channel.status.state}. Replacing signal ${JSON.stringify(message)}`);
            channel.initialStatus() // TODO: Reset to avoid memory leaks?
        } else {
            console.log(`Peer ${peerId} does not exist. Creating new channel`);
            channel = this.createPeerChannel(peerId);
            this.connectedPeers.set(peerId, channel);
        }

        await channel.connect()
        await channel.handleSignal(message.signalType, message.payload as QRtcDataExchanged);

        return channel;
    }

    async connectToPeer(peerId: string): Promise<WebRtcQueueBoxClientService> {
        const channel = this.createPeerChannel(peerId);
        this.connectedPeers.set(peerId, channel);

        await channel.connect()

        return this;
    }

    private createPeerChannel(peerId: string) {
        console.log(`Creating peer channel for ${peerId}`);

        const channel = new QRtcDataChannel(
            new WsRtcSignalingTransport(
                this.socket,
                this.input.rtcSignalingTopicId
            ),
            {
                sessionId: this.input.sessionId,
                token: this.input.token,
                peerId: peerId,
                iceCandidates: this.input.iceCandidates,
                dataChannelName: this.input.dataChannelName
            }
        );

        channel.onRtcMessageDo(
            this.input.sessionId + "-" + peerId + "-rtc-inbox",
            {
                onMessage: async (data) => {
                    console.log(`From ${peerId}:  ${data}`);

                    const msg = data as ALMessage

                    await this.inbox.enqueueIfAbsent(
                        QueueBoxUtilities.toResourceEntry(
                            msg.payload.typeId,
                            msg
                        )
                    )
                }
            }
        )
        return channel;
    }

    enableDefaultCallbacks(): WebRtcQueueBoxClientService {
        this.onOutboxMessageDo(
            this.input.sessionId + "-rtc-outbox",
            {
                onMessage: async (entry, channel) => {
                    console.log(`Sending ${this.input.sessionId}: ${entry.typeId} ${entry.resource}`);
                    await channel.sendAsJsonString(entry.resource);
                }
            }
        )
        return this
    }

    async enqueueOutboxIfAbsent(msg: ALMessage): Promise<ResourceEntry> {
        return await this.outbox.enqueueIfAbsent(QueueBoxUtilities.toResourceEntry(msg.payload.typeId, msg));
    }

    async dequeueOutbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.outbox,
            typesToDequeue,
            resilience,
            async (entry) => {

                // TODO: Use ALMRoute info to find channel to route to

                for (const callback of this.onOutboxMessageCallbacks.values()) {

                    for (const channel of this.connectedPeers.values()) {
                        try {
                            await callback.onMessage(entry, channel)
                        } catch (e) {
                            console.error("Error calling onMessage callback", e)
                        }
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