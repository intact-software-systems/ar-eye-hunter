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
import {QRtcMediaPolicy, QRtcPeerConnection} from "../webrtc/QRtcPeerConnection.ts";
import {QRtcMediaChannel} from "../webrtc/QRtcMediaChannel.ts";

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
    media: QRtcMediaChannel | undefined
}

type WebRtcQueueBoxClientServiceStatus = {
    localMediaStream: MediaStream | undefined
    localAudioEnabled: boolean
    localVideoEnabled: boolean
    mediaPolicy: QRtcMediaPolicy | undefined
}

export class WebRtcQueueBoxClientService {

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebRtcMessageCallback> = new Map<string, OnOutboxWebRtcMessageCallback>();
    private readonly onMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();
    private readonly onRemoteStreamCallbacks: Map<string, (peerId: string, stream: MediaStream, event: RTCTrackEvent) => Promise<void>> = new Map();

    private status: WebRtcQueueBoxClientServiceStatus;

    private readonly connectedPeers: Map<PeerId, QRtcPeerDto> = new Map<string, QRtcPeerDto>();

    constructor(
        public readonly inbox: QueueBoxResourceEntryRepository,
        public readonly outbox: QueueBoxResourceEntryRepository,
        public readonly socket: JsonWebSocketClient,
        public readonly input: WebRtcQueueBoxClientServiceInputDto
    ) {
        this.status = {
            localMediaStream: undefined,
            localAudioEnabled: false,
            localVideoEnabled: false,
            mediaPolicy: undefined
        }
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

    // --- Media/remote stream callback registry and local media controls ---
    onRemoteStreamDo(id: string, cb: (peerId: string, stream: MediaStream, event: RTCTrackEvent) => Promise<void>): WebRtcQueueBoxClientService {
        this.onRemoteStreamCallbacks.set(id, cb);
        return this;
    }

    removeOnRemoteStreamCallbackById(id: string): boolean {
        return this.onRemoteStreamCallbacks.delete(id);
    }

    async setLocalMediaStream(stream: MediaStream): Promise<void> {
        this.status.localMediaStream = stream;

        for (const peer of this.connectedPeers.values()) {
            const dto = this.computePeerMediaChannelIfNecessary(peer);

            if (dto.media) {
                await dto.media.setLocalMediaStream(stream);

                dto.media.setLocalAudioEnabled(this.status.localAudioEnabled);
                dto.media.setLocalVideoEnabled(this.status.localVideoEnabled);
            }
        }
    }

    setLocalAudioEnabled(enabled: boolean): void {
        this.status.localAudioEnabled = enabled;

        for (const peer of this.connectedPeers.values()) {
            peer.media?.setLocalAudioEnabled(enabled);
        }
    }

    setLocalVideoEnabled(enabled: boolean): void {
        this.status.localVideoEnabled = enabled;

        for (const peer of this.connectedPeers.values()) {
            peer.media?.setLocalVideoEnabled(enabled);
        }
    }

    stopLocalMedia(kind: 'audio' | 'video' | 'all'): void {
        for (const peer of this.connectedPeers.values()) {
            peer.media?.stopLocalMedia(kind);
        }
    }

    setMediaPolicy(policy: QRtcMediaPolicy): void {
        this.status.mediaPolicy = policy;

        for (const peer of this.connectedPeers.values()) {
            peer.connection.applyMediaPolicy(policy);
        }
    }

    removePeerIfPresent(peerId: string): boolean {
        const rtcPeer: QRtcPeerDto | undefined = this.connectedPeers.get(peerId);
        if (rtcPeer === undefined) {
            return false
        }

        rtcPeer.media?.reset();
        rtcPeer?.channel?.reset();
        rtcPeer.connection.reset();

        return this.connectedPeers.delete(peerId);
    }

    async acceptPeerIfAbsent(peerId: string, message: QRtcSignalingMessage) {
        const rtcPeerDto =
            this.computePeerMediaChannelIfNecessary(
                this.computePeerDataChannelIfNecessary(
                    this.computeRtcPeerDtoIfAbsent(peerId)
                )
            );

        if (!rtcPeerDto.channel) {
            throw new Error(`No data channel for peer ${peerId}`)
        }
        if (!rtcPeerDto.media) {
            throw new Error(`No media channel for peer ${peerId}`)
        }

        await rtcPeerDto.channel.connect(false)

        await rtcPeerDto.media.connect();

        if (this.status.localMediaStream) {
            await rtcPeerDto.media.setLocalMediaStream(this.status.localMediaStream);
            rtcPeerDto.media.setLocalAudioEnabled(this.status.localAudioEnabled);
            rtcPeerDto.media.setLocalVideoEnabled(this.status.localVideoEnabled);
        }

        await rtcPeerDto.connection.handleSignal(message.signalType, message.payload as QRtcDataExchanged);

        return rtcPeerDto.channel;
    }

    async connectToPeer(peerId: string): Promise<QRtcDataChannel> {
        const rtcPeerDto =
            this.computePeerMediaChannelIfNecessary(
                this.computePeerDataChannelIfNecessary(
                    this.computeRtcPeerDtoIfAbsent(peerId)
                )
            );

        if (!rtcPeerDto.channel) {
            throw new Error(`No data channel for peer ${peerId}`)
        }
        if (!rtcPeerDto.media) {
            throw new Error(`No media channel for peer ${peerId}`)
        }

        await rtcPeerDto.channel.connect(true)

        await rtcPeerDto.media.connect();

        if (this.status.localMediaStream) {
            await rtcPeerDto.media.setLocalMediaStream(this.status.localMediaStream);
            rtcPeerDto.media.setLocalAudioEnabled(this.status.localAudioEnabled);
            rtcPeerDto.media.setLocalVideoEnabled(this.status.localVideoEnabled);
        }

        return rtcPeerDto.channel;
    }

    private computePeerMediaChannelIfNecessary(rtcPeerDto: QRtcPeerDto): QRtcPeerDto {
        const peerId = rtcPeerDto.peerId;

        // is there an existing media channel?
        {
            const existing: QRtcMediaChannel | undefined = rtcPeerDto.media;
            if (existing) {
                console.log(`Media channel to ${peerId} exists in state ${existing.status.state}. Reuse existing channel`);
                return rtcPeerDto;
            }
        }

        rtcPeerDto.media =
            new QRtcMediaChannel(
                rtcPeerDto.connection,
                {
                    peerId: peerId
                })
                // Forward remote streams to service-level callbacks
                .onRemoteStreamDo(
                    this.input.sessionId + '-' + peerId + '-rtc-media-remote-stream',
                    async (stream, event) => {
                        for (const cb of this.onRemoteStreamCallbacks.values()) {
                            try {
                                await cb(peerId, stream, event);
                            } catch (e) {
                                console.error('Error calling onRemoteStream callback', e);
                            }
                        }
                    }
                );

        return rtcPeerDto;
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

        const rtcPeerDto: QRtcPeerDto = {
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
            channel: undefined,
            media: undefined
        };

        if (this.status.mediaPolicy) {
            rtcPeerDto.connection.applyMediaPolicy(this.status.mediaPolicy);
        }

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