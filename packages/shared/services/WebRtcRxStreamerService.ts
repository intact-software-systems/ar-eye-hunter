import { OnMessageCallback, OnOutboxWebRtcMessageCallback } from './InboxOutboxContracts.ts';
import { OnQRtcMessageCallback, QRtcClientCallbacks } from '../webrtc/QRtcClientCallbacks.ts';
import {
    defaultMaxMissedPings,
    defaultPingFrequencyMsecs,
    PingResult,
    WebRtcHeartbeatCallbacks,
    WebRtcHeartbeatService
} from './WebRtcHeartbeatService.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/QueueBoxTypes.ts';
import { ALMessage } from '../al-contracts/al-contract.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from './QueueBoxUtilities.ts';
import { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import { QRtcPeerDto } from './WebRtcConnectionService.ts';
import { QRtcMediaPolicy } from '../webrtc/QRtcPeerConnection.ts';
import { EnqueuedType, PeerId, RttMeasurementInfo } from '../api/api-config.ts';
import { WebRtcOverlayMulticastManager } from '../multicast/WebRtcOverlayMulticastManager.ts';
import type { ALInboundRuntimeStores } from '../alm/ALInboundMessageRuntime.ts';
import { ALInboundMessageRuntime } from '../alm/ALInboundMessageRuntime.ts';
import { ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import type { ALOutboundEnqueueResult } from '../alm/ALOutboundMessageRuntime.ts';

export type WebRtcRxStreamerServiceInputDto = {
    sessionId: string
}

type WebRtcRxStreamerServiceStatus = {
    localMediaStream: MediaStream | undefined
    localAudioEnabled: boolean
    localVideoEnabled: boolean
    mediaPolicy: QRtcMediaPolicy | undefined
}

export type RttMeasurementCallbacks = {
    onHeartbeat: (rtt: RttMeasurementInfo) => Promise<void>,
}

export type WebRtcRxStreamerServiceOptions = Readonly<{
    inboundStores?: ALInboundRuntimeStores;
}>;

export class WebRtcRxStreamerService {
    private static readonly ALL_IN = '*';

    public static readonly ENQUEUE_TYPE = EnqueuedType.RTC_INBOX;
    public static readonly INBOX_DEQUEUE_TYPES = new Set<string>([this.ENQUEUE_TYPE]);

    private readonly onOutboxMessageCallbacks = new Map<string, OnOutboxWebRtcMessageCallback>();
    private readonly onInboxMessageCallbacks = new Map<string, OnMessageCallback>();
    private readonly onRtcMessageCallbacks = new Map<string, OnQRtcMessageCallback>();
    private readonly onRttMeasurementCallbacks = new Map<string, RttMeasurementCallbacks>();

    private readonly onRemoteStreamCallbacks: Map<string, (peerId: string, stream: MediaStream, event: RTCTrackEvent) => Promise<void>> = new Map();

    private status: WebRtcRxStreamerServiceStatus = {
        localMediaStream: undefined,
        localAudioEnabled: false,
        localVideoEnabled: false,
        mediaPolicy: undefined
    };

    private readonly heartbeatByPeerId = new Map<PeerId, WebRtcHeartbeatService>();
    private readonly peerDtoByPeerId = new Map<PeerId, QRtcPeerDto>();
    private readonly inboundRuntime: ALInboundMessageRuntime;

    constructor(
        public readonly inbox: QueueBoxResourceEntryRepository,
        public readonly multicast: WebRtcOverlayMulticastManager,
        public readonly input: WebRtcRxStreamerServiceInputDto,
        options: WebRtcRxStreamerServiceOptions = {},
    ) {
        this.inboundRuntime = new ALInboundMessageRuntime(
            {
                stores: options.inboundStores,
                selfPeerId: this.input.sessionId,
                inbox: this.inbox,
                planIncomingMessage: (msg, fromPeerId, runtime) => {
                    return this.multicast.planIncomingMessage(msg, fromPeerId, runtime);
                },
                readStoredEntry: (entry) =>
                    JSON.parse(entry.resource) as ALMessage,
                toInboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WebRtcRxStreamerService.ENQUEUE_TYPE,
                    ),
                dispatchInboxEntry: async (entry, plan) => {
                    await this.dispatchInboxEntry(entry, plan);
                },
                sendControlMessage: async (msg) => {
                    await this.multicast.enqueueIfAbsent(msg);
                },
                onControlMessage: async (msg) => {
                    await this.multicast.acceptControlMessage(msg);
                },
                forwardMessage: async (msg, fromPeerId) => {
                    await this.multicast.forwardIfRequired(msg, fromPeerId);
                },
            },
        );
    }

    // callback from WebRtcConnectionService whenever a new connection
    addPeer(peerDto: QRtcPeerDto): void {
        if (this.peerDtoByPeerId.has(peerDto.peerId)) {
            console.warn(`Peer ${peerDto.peerId} already exists. Ignoring ...`);
            return;
        }

        this.peerDtoByPeerId.set(peerDto.peerId, peerDto);

        peerDto.channel
            .onRtcCallbacksDo(
                this.toHeartbeatCallbackId(peerDto.peerId),
                this.toHeartbeatCallbacks(peerDto.peerId)
            )
            .onRtcMessageDo(
                this.toRtcChannelSubscriptionId(peerDto.peerId),
                {
                    onMessage: async (data) => {
                        console.log(`From ${(peerDto.peerId)}: ${JSON.stringify(data)}`);

                        const msg = data as ALMessage;

                        if (msg.id.senderId !== peerDto.peerId) {
                            console.warn(`Message from ${msg.id.senderId} does not match peerId ${(peerDto.peerId)}. `);
                        }

                        await this.inboundRuntime.handleIncomingMessage(msg, peerDto.peerId);
                    }
                }
            );

        for (const [id, cb] of this.onRtcMessageCallbacks.entries()) {
            peerDto.channel.onRtcMessageDo(id, cb);
        }

        if (this.status.mediaPolicy) {
            peerDto.connection.applyMediaPolicy(this.status.mediaPolicy);
        }

        peerDto.media
            .onRemoteStreamDo(
                this.toRtcMediaSubscriptionId(peerDto.peerId),
                async (stream, event) => {
                    for (const cb of this.onRemoteStreamCallbacks.values()) {
                        try {
                            await cb(peerDto.peerId, stream, event);
                        } catch (e) {
                            console.error('Error calling onRemoteStream callback', e);
                        }
                    }
                }
            );

        if (this.status.localMediaStream) {
            peerDto.media.setParameters(
                    this.status.localMediaStream,
                    this.status.localAudioEnabled,
                    this.status.localVideoEnabled
                )
                .catch(e => console.error('Error setting local media parameters', e));
        }
    }

    removePeer(peerDto: QRtcPeerDto): void {
        this.peerDtoByPeerId.delete(peerDto.peerId);

        peerDto.media.removeOnRemoteStreamCallbackById(this.toRtcMediaSubscriptionId(peerDto.peerId));
        peerDto.channel.removeOnRtcMessageCallbackById(this.toRtcChannelSubscriptionId(peerDto.peerId));
        peerDto.channel.removeOnRtcMessageCallbackById(this.toHeartbeatCallbackId(peerDto.peerId));

        const heartbeat = this.heartbeatByPeerId.get(peerDto.peerId);

        heartbeat?.stop();

        this.heartbeatByPeerId.delete(peerDto.peerId);
    }

    stopAllHeartbeats(): void {
        for (const heartbeat of this.heartbeatByPeerId.values()) {
            heartbeat.stop();
        }
        this.heartbeatByPeerId.clear();
    }

    enableDefaultCallbacks(): WebRtcRxStreamerService {
        this.onOutboxMessageDo(
            this.input.sessionId + '-rtc-outbox',
            {
                onMessage: async (entry, channel) => {
                    console.log(`Sending ${this.input.sessionId}: ${entry.typeId} ${entry.resource}`);
                    await channel.sendAsJsonString(entry.resource);
                }
            }
        );
        return this;
    }

    private toHeartbeatCallbacks(peerId: string): QRtcClientCallbacks {
        return {
            onClose: () => {
                console.log(`Data channel to ${peerId} closed. Stopping heartbeat`);
                const heartbeat = this.heartbeatByPeerId.get(peerId);
                if (heartbeat) {
                    heartbeat.stop();
                }

                this.heartbeatByPeerId.delete(peerId);

                return Promise.resolve();
            },
            onError: () => {
                console.log(`Data channel to ${peerId} error.`);
                return Promise.resolve();
            },
            onOpen: () => {
                return this.startRtcHeartbeats(peerId);
            },
        };
    }

    private startRtcHeartbeats(peerId: string): Promise<void> {
        console.log(`Data channel to ${peerId} opened. Starting heartbeat`);

        {
            const heartbeat = this.heartbeatByPeerId.get(peerId);
            if (heartbeat) {
                heartbeat.stop();
            }
        }

        const dto = this.peerDtoByPeerId.get(peerId);
        if (!dto?.channel) {
            console.warn(`No channel for peer ${peerId}. Ignoring heartbeat ...`);
            return Promise.resolve();
        }

        const heartbeat = new WebRtcHeartbeatService(
            {
                sessionId: this.input.sessionId,
                peerSessionId: peerId,
                channel: dto.channel,
                maxMissedPings: defaultMaxMissedPings,
                pingFrequencyMsecs: defaultPingFrequencyMsecs
            }
        );

        const callbacks: WebRtcHeartbeatCallbacks = {
            onMissedHeartbeat: (peerId: string) => {
                console.log(`Missed heartbeat from ${peerId}.`);
                return Promise.resolve();
            },
            onHeartbeat: (result: PingResult) => {
                for (const [_, cb] of this.onRttMeasurementCallbacks.entries()) {
                    cb.onHeartbeat(
                            {
                                sessionIdFrom: this.input.sessionId,
                                sessionIdTo: peerId,
                                rttMs: result.rttMsecs,
                                createdAtEpochMs: Date.now(),
                                version: result.version
                            }
                        )
                        .catch(
                            e => console.error('Error calling onRttMeasurementCallback', e)
                        );
                }

                return Promise.resolve();
            },
        };

        heartbeat.start(callbacks);

        this.heartbeatByPeerId.set(peerId, heartbeat);

        return Promise.resolve();
    }

    private toRtcMediaSubscriptionId(peerId: PeerId) {
        return this.input.sessionId + '-' + peerId + '-rtc-media-remote-stream';
    }

    private toRtcChannelSubscriptionId(peerId: PeerId) {
        return this.input.sessionId + '-' + peerId + '-rtc-inbox';
    }

    private toHeartbeatCallbackId(peerId: PeerId) {
        return this.input.sessionId + '-' + peerId + '-rtc-datachannel-lifecycle';
    }

    private async dispatchInboxEntry(
        entry: ResourceEntry,
        plan?: ALMessageHandlingPlan
    ): Promise<void> {
        const message = JSON.parse(entry.resource) as ALMessage;

        let exclusiveCallback;
        let wildcard = undefined;

        if (plan?.ownership.exclusive) {
            exclusiveCallback =
                this.onInboxMessageCallbacks.get(message.payload.typeId)
                ?? this.onInboxMessageCallbacks.get(WebRtcRxStreamerService.ALL_IN);

            await this.onMessageIfPresent(exclusiveCallback, message, entry);
        } else {
            exclusiveCallback = this.onInboxMessageCallbacks.get(message.payload.typeId);
            await this.onMessageIfPresent(exclusiveCallback, message, entry);

            wildcard = this.onInboxMessageCallbacks.get(WebRtcRxStreamerService.ALL_IN);
            await this.onMessageIfPresent(wildcard, message, entry);
        }

        if (exclusiveCallback === undefined && wildcard === undefined) {
            console.warn('No callback for typeId ', message.payload.typeId);
        }
    }

    private async onMessageIfPresent(
        callback: OnMessageCallback | undefined,
        message: ALMessage,
        entry: ResourceEntry
    ) {
        try {
            await callback?.onMessage(message, entry);
        } catch (e) {
            console.error('Error calling onMessage callback', e);
        }
    }

    // --------------------------------------------------
    // Callbacks
    // --------------------------------------------------

    onAllInboxMessagesDo(callback: OnMessageCallback, forceUpdate: boolean = false): WebRtcRxStreamerService {
        if (!forceUpdate && this.onInboxMessageCallbacks.has(WebRtcRxStreamerService.ALL_IN)) {
            throw new Error('Cannot set multiple Rtc inbox callbacks for ALL_IN');
        }

        this.onInboxMessageCallbacks.set(WebRtcRxStreamerService.ALL_IN, callback);
        return this;
    }

    onOutboxMessageDo(id: string, callback: OnOutboxWebRtcMessageCallback): WebRtcRxStreamerService {
        this.onOutboxMessageCallbacks.set(id, callback);
        return this;
    }

    removeOutboxMessageCallback(id: string): boolean {
        return this.onOutboxMessageCallbacks.delete(id);
    }

    onInboxMessageDo(id: string, callback: OnMessageCallback): WebRtcRxStreamerService {
        this.onInboxMessageCallbacks.set(id, callback);
        return this;
    }

    removeInboxMessageCallback(id: string): boolean {
        return this.onInboxMessageCallbacks.delete(id);
    }

    onRtcMessageDo(id: string, callback: OnQRtcMessageCallback): WebRtcRxStreamerService {
        this.onRtcMessageCallbacks.set(id, callback);
        return this;
    }

    removeRtcMessageCallback(id: string): boolean {
        return this.onRtcMessageCallbacks.delete(id);
    }

    onRemoteStreamDo(id: string, cb: (peerId: string, stream: MediaStream, event: RTCTrackEvent) => Promise<void>): WebRtcRxStreamerService {
        this.onRemoteStreamCallbacks.set(id, cb);
        return this;
    }

    removeOnRemoteStreamCallbackById(id: string): boolean {
        return this.onRemoteStreamCallbacks.delete(id);
    }

    onRttMeasurementDo(id: string, callback: RttMeasurementCallbacks) {
        this.onRttMeasurementCallbacks.set(id, callback);
    }

    removeRttMeasurementCallback(id: string): boolean {
        return this.onRttMeasurementCallbacks.delete(id);
    }

    // --------------------------------------------------
    // Queue management
    // --------------------------------------------------

    async enqueueOutboxIfAbsent(msg: ALMessage): Promise<ALOutboundEnqueueResult> {
        return await this.multicast.enqueueIfAbsent(msg);
    }

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.inbox,
            typesToDequeue,
            resilience,
            QueueBoxUtilities.withRetryDisposition(
                async (entry) => await this.inboundRuntime.dispatchStoredEntry(entry),
            ),
        );
    }

    // ---------------------------------------------------------------
    // Media/remote stream callback registry and local media controls
    // ---------------------------------------------------------------

    async setLocalMediaStream(stream: MediaStream): Promise<void> {
        this.status.localMediaStream = stream;

        for (const peer of this.peerDtoByPeerId.values()) {

            if (peer?.media) {
                await peer.media.setLocalMediaStream(stream);

                peer.media.setLocalAudioEnabled(this.status.localAudioEnabled);
                peer.media.setLocalVideoEnabled(this.status.localVideoEnabled);
            }
        }
    }

    setLocalAudioEnabled(enabled: boolean): void {
        this.status.localAudioEnabled = enabled;

        for (const peer of this.peerDtoByPeerId.values()) {
            peer.media?.setLocalAudioEnabled(enabled);
        }
    }

    setLocalVideoEnabled(enabled: boolean): void {
        this.status.localVideoEnabled = enabled;

        for (const peer of this.peerDtoByPeerId.values()) {
            peer.media?.setLocalVideoEnabled(enabled);
        }
    }

    stopLocalMedia(kind: 'audio' | 'video' | 'all'): void {
        for (const peer of this.peerDtoByPeerId.values()) {
            peer.media?.stopLocalMedia(kind);
        }
    }

    setMediaPolicy(policy: QRtcMediaPolicy): void {
        this.status.mediaPolicy = policy;

        for (const peer of this.peerDtoByPeerId.values()) {
            peer.connection.applyMediaPolicy(policy);
        }
    }
}
