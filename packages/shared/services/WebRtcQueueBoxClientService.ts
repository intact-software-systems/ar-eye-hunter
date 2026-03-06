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
import {QRtcPeerConnection} from "../webrtc/QRtcPeerConnection.ts";

export type WebRtcQueueBoxClientServiceInputDto = {
    readonly sessionId: string
    readonly token: string
    readonly iceCandidates: IceConfig
    readonly dataChannelName: string
    readonly rtcSignalingTopicId: string
}

type PeerId = string

type QRtcPeerDto = {
    peerId: PeerId
    connection: QRtcPeerConnection
    channel: QRtcDataChannel | undefined
}

export class WebRtcQueueBoxClientService {

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebRtcMessageCallback> = new Map<string, OnOutboxWebRtcMessageCallback>();
    private readonly onMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();

    private readonly connectedPeers: Map<PeerId, QRtcPeerDto> = new Map<string, QRtcPeerDto>();

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
        const rtcPeerDto =
            this.computePeerDataChannelIfNecessary(
                this.computeRtcPeerDtoIfAbsent(peerId)
            );

        if (!rtcPeerDto.channel) {
            throw new Error(`No data channel for peer ${peerId}`)
        }

        await rtcPeerDto.channel.connect(false)
        await rtcPeerDto.connection.handleSignal(message.signalType, message.payload as QRtcDataExchanged);

        return rtcPeerDto.channel;
    }

    async connectToPeer(peerId: string): Promise<QRtcDataChannel> {

        const rtcPeerDto =
            this.computePeerDataChannelIfNecessary(
                this.computeRtcPeerDtoIfAbsent(peerId)
            );

        if (!rtcPeerDto.channel) {
            throw new Error(`No data channel for peer ${peerId}`)
        }

        await rtcPeerDto.channel.connect(true)

        return rtcPeerDto.channel;
    }

    private computePeerDataChannelIfNecessary(rtcPeerDto: QRtcPeerDto): QRtcPeerDto {
        const peerId = rtcPeerDto.peerId;

        // Is there an existing channel?
        {
            const existingChannel: QRtcDataChannel | undefined = rtcPeerDto.channel;

            if (existingChannel && !existingChannel.isReadyToConnect()) {
                console.log(`Data channel to ${peerId} exists in valid state ${existingChannel.status.state}. Reuse existing channel`);

                return rtcPeerDto;
            }
            // If the data channel exists and is ready to connect (failed, closed or idle), then reset
            else if (existingChannel) {
                console.log(`Data channel to ${peerId} exists in state ${existingChannel.status.state}. Resetting data channel`);
                existingChannel.reset()

                return rtcPeerDto;
            }
        }

        rtcPeerDto.channel =
            new QRtcDataChannel(
                rtcPeerDto.connection,
                {
                    peerId: peerId,
                    dataChannelName: this.input.dataChannelName
                })
                .onRtcMessageDo(
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
                );

        console.log(`Data channel to ${peerId} created`);

        return rtcPeerDto;
    }

    private computeRtcPeerDtoIfAbsent(peerId: string): QRtcPeerDto {
        {
            const rtcPeer: QRtcPeerDto | undefined = this.connectedPeers.get(peerId);
            if (rtcPeer !== undefined) {
                return rtcPeer
            }
        }

        console.log(`Creating peer connection for ${peerId}`);

        const rtcPeerDto = {
            peerId: peerId,
            connection:
                new QRtcPeerConnection(
                    new WsRtcSignalingTransport(
                        this.socket,
                        this.input.rtcSignalingTopicId
                    ),
                    {
                        sessionId: this.input.sessionId,
                        token: this.input.token,
                        peerSessionId: peerId,
                        iceCandidates: this.input.iceCandidates,
                    }
                ),
            channel: undefined
        };

        this.connectedPeers.set(peerId, rtcPeerDto);

        return rtcPeerDto
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

                if (this.connectedPeers.size === 0) {
                    console.warn("No peers connected. Skipping callback")
                    return
                }

                // TODO: Use ALMRoute info to find channel to route to

                for (const callback of this.onOutboxMessageCallbacks.values()) {

                    for (const rtcPeer of this.connectedPeers.values()) {
                        if (!rtcPeer.channel) {
                            console.warn(`No data channel for peer ${rtcPeer.peerId}. Skipping callback`)
                            continue
                        }

                        try {
                            await callback.onMessage(entry, rtcPeer.channel)
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