import { ALMessage } from '../al-contracts/al-contract.ts';
import { isALControlTypeId, newALNackControlMessage } from '../al-contracts/al-control.ts';
import {
    decodePersistedALMessage,
    decodePersistedALMessageValue
} from '../al-contracts/al-message-persistence-validation.ts';
import { ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import type { ALInboundRuntimeStores } from '../alm/ALInboundMessageRuntime.ts';
import { ALInboundMessageRuntime } from '../alm/ALInboundMessageRuntime.ts';
import type { ALOutboundEnqueueResult } from '../alm/ALOutboundMessageRuntime.ts';
import { EnqueuedType, PeerId, RttMeasurementInfo } from '../api/api-config.ts';
import { isSameGroupRef } from '../api/api-type-utils.ts';
import { WebRtcOverlayMulticastManager } from '../multicast/WebRtcOverlayMulticastManager.ts';
import { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { toError } from '../resilience/to-error.ts';
import { QRtcClientCallbacks } from '../webrtc/QRtcClientCallbacks.ts';
import { QRtcMediaPolicy } from '../webrtc/QRtcPeerConnection.ts';
import { OnMessageCallback } from './InboxOutboxContracts.ts';
import { QueueBoxUtilities } from './QueueBoxUtilities.ts';
import { QRtcPeerDto } from './WebRtcConnectionService.ts';
import {
    PingResult,
    WebRtcHeartbeatCallbacks,
    WebRtcHeartbeatService,
    WebRtcHeartbeatServiceInputDto
} from './WebRtcHeartbeatService.ts';

interface WebRtcRxStreamerServiceStatus {
    localMediaStream: MediaStream | undefined;
    localAudioEnabled: boolean;
    localVideoEnabled: boolean;
    mediaPolicy: QRtcMediaPolicy | undefined;
}

export interface RttMeasurementCallbacks {
    readonly onHeartbeat: (rtt: RttMeasurementInfo) => Promise<void>;
}

export namespace WebRtcRxStreamerService {
    export interface Input {
        readonly inbox: QueueBoxResourceEntryRepository;
        readonly multicast: WebRtcOverlayMulticastManager;
        readonly sessionId: string;
        readonly inboundStores: ALInboundRuntimeStores;
        readonly nowEpochMs: () => number;
        readonly heartbeat: Pick<WebRtcHeartbeatServiceInputDto, 'maxMissedPings' | 'pingFrequencyMsecs'>;
    }
}

export class WebRtcRxStreamerService {
    private static readonly ALL_IN = '*';

    public static readonly ENQUEUE_TYPE = EnqueuedType.RTC_INBOX;
    public static readonly INBOX_DEQUEUE_TYPES = new Set<string>([this.ENQUEUE_TYPE]);

    private readonly onInboxMessageCallbacks = new Map<string, OnMessageCallback>();
    private readonly onRttMeasurementCallbacks = new Map<string, RttMeasurementCallbacks>();

    private readonly onRemoteStreamCallbacks: Map<
        string,
        (peerId: string, stream: MediaStream, event: RTCTrackEvent) => Promise<void>
    > = new Map();

    private readonly status: WebRtcRxStreamerServiceStatus = {
        localMediaStream: undefined,
        localAudioEnabled: false,
        localVideoEnabled: false,
        mediaPolicy: undefined
    };

    private readonly heartbeatByPeerId = new Map<PeerId, WebRtcHeartbeatService>();
    private readonly rttVersionByPeerId = new Map<PeerId, number>();
    private readonly peerDtoByPeerId = new Map<PeerId, QRtcPeerDto>();
    private readonly inboundRuntime: ALInboundMessageRuntime;
    private rttReportingPeerIds: ReadonlySet<PeerId> | undefined;

    public readonly inbox: QueueBoxResourceEntryRepository;
    public readonly multicast: WebRtcOverlayMulticastManager;
    private readonly runtime: WebRtcRxStreamerService.Input;

    constructor(
        runtime: WebRtcRxStreamerService.Input
    ) {
        this.inbox = runtime.inbox;
        this.multicast = runtime.multicast;
        this.runtime = runtime;
        this.inboundRuntime = new ALInboundMessageRuntime(
            {
                stores: runtime.inboundStores,
                selfPeerId: runtime.sessionId,
                inbox: this.inbox,
                planIncomingMessage: (msg, fromPeerId, runtime) => {
                    return this.multicast.planIncomingMessage(msg, fromPeerId, runtime);
                },
                readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
                toInboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WebRtcRxStreamerService.ENQUEUE_TYPE
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
                }
            }
        );
    }

    addPeer(peerDto: QRtcPeerDto): void {
        if (this.peerDtoByPeerId.has(peerDto.peerId)) {
            console.warn(`Peer ${peerDto.peerId} already exists. Ignoring ...`);
            return;
        }

        this.peerDtoByPeerId.set(peerDto.peerId, peerDto);
        this.registerPeerMessages(peerDto);
        this.registerPeerMedia(peerDto);
    }

    private registerPeerMessages(peerDto: QRtcPeerDto): void {
        peerDto.channel
            .onRtcCallbacksDo(
                this.toHeartbeatCallbackId(peerDto.peerId),
                this.toHeartbeatCallbacks(peerDto.peerId)
            )
            .onRtcMessageDo(
                this.toRtcChannelSubscriptionId(peerDto.peerId),
                {
                    onMessage: async (value) => {
                        const message = decodePersistedALMessageValue(value);
                        await this.receivePeerMessage(peerDto.peerId, message);
                    }
                }
            );
    }

    private registerPeerMedia(peerDto: QRtcPeerDto): void {
        if (this.status.mediaPolicy) {
            peerDto.connection.applyMediaPolicy(this.status.mediaPolicy);
        }

        peerDto.media
            .onRemoteStreamDo(
                this.toRtcMediaSubscriptionId(peerDto.peerId),
                (stream, event) => this.publishRemoteStream(peerDto.peerId, stream, event)
            );

        if (this.status.localMediaStream) {
            peerDto.media.setParameters(
                this.status.localMediaStream,
                this.status.localAudioEnabled,
                this.status.localVideoEnabled
            )
                .catch((error) => console.error('Error setting local media parameters', toError(error)));
        }
    }

    private async receivePeerMessage(peerId: PeerId, message: ALMessage): Promise<void> {
        if (!isALControlTypeId(message.payload.typeId) && this.isBelowSnapshotFloor(message)) {
            await this.multicast.enqueueIfAbsent(
                newALNackControlMessage(this.runtime.sessionId, peerId, message.id.msgId, 'not-yet-in-sync')
            );
            return;
        }
        await this.inboundRuntime.handleIncomingMessage(message, peerId);
    }

    private isBelowSnapshotFloor(message: ALMessage): boolean {
        const targets = message.targets;
        if (
            !targets || targets.mode === 'unicast' || targets.minSnapshotVersion === undefined ||
            (targets.mode === 'broadcast' && (targets.scope !== 'room' || !targets.groupRef))
        ) {
            return false;
        }

        const groupRef = targets.groupRef;
        if (!groupRef) {
            return false;
        }
        const snapshot = this.multicast.groupCache.readAllValues()
            .find((candidate) => isSameGroupRef(candidate.group, groupRef));
        return snapshot === undefined || snapshot.group.snapshotVersion < targets.minSnapshotVersion;
    }

    private async publishRemoteStream(peerId: PeerId, stream: MediaStream, event: RTCTrackEvent): Promise<void> {
        for (const callback of this.onRemoteStreamCallbacks.values()) {
            try {
                await callback(peerId, stream, event);
            }
            catch (error) {
                console.error('Error calling onRemoteStream callback', toError(error));
            }
        }
    }

    removePeer(peerDto: QRtcPeerDto): void {
        this.peerDtoByPeerId.delete(peerDto.peerId);

        peerDto.media.removeOnRemoteStreamCallbackById(this.toRtcMediaSubscriptionId(peerDto.peerId));
        peerDto.channel.removeOnRtcMessageCallbackById(this.toRtcChannelSubscriptionId(peerDto.peerId));
        peerDto.channel.removeRtcCallbackById(this.toHeartbeatCallbackId(peerDto.peerId));

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

    setRttReportingPeerIds(peerIds: readonly PeerId[]): void {
        this.rttReportingPeerIds = new Set(peerIds);
        for (const [peerId, heartbeat] of this.heartbeatByPeerId.entries()) {
            if (!this.shouldReportRttForPeer(peerId)) {
                heartbeat.stopReporting();
            }
        }

        for (const peerId of peerIds) {
            const dto = this.peerDtoByPeerId.get(peerId);
            if (dto?.channel.isOpen()) {
                this.startRtcHeartbeats(peerId).catch((error) =>
                    console.error(`Failed to start RTT heartbeat for ${peerId}`, toError(error))
                );
            }
        }
    }

    private toHeartbeatCallbacks(peerId: string): QRtcClientCallbacks {
        return {
            onClose: () => {
                const heartbeat = this.heartbeatByPeerId.get(peerId);
                if (heartbeat) {
                    heartbeat.stop();
                }

                this.heartbeatByPeerId.delete(peerId);

                return Promise.resolve();
            },
            onOpen: () => {
                return this.startRtcHeartbeats(peerId);
            }
        };
    }

    private startRtcHeartbeats(peerId: string): Promise<void> {
        const dto = this.peerDtoByPeerId.get(peerId);
        if (!dto) {
            return Promise.resolve();
        }

        let heartbeat = this.heartbeatByPeerId.get(peerId);
        if (!heartbeat) {
            heartbeat = new WebRtcHeartbeatService({
                sessionId: this.runtime.sessionId,
                peerSessionId: peerId,
                channel: dto.channel,
                maxMissedPings: this.runtime.heartbeat.maxMissedPings,
                pingFrequencyMsecs: this.runtime.heartbeat.pingFrequencyMsecs
            });
            this.heartbeatByPeerId.set(peerId, heartbeat);
        }
        heartbeat.startResponding();
        if (this.shouldReportRttForPeer(peerId)) {
            heartbeat.start(this.toRttMeasurementCallbacks(peerId));
        }
        return Promise.resolve();
    }

    private toRttMeasurementCallbacks(peerId: string): WebRtcHeartbeatCallbacks {
        return {
            onMissedHeartbeat: (peerId: string) => {
                console.log(`Missed heartbeat from ${peerId}.`);
                return Promise.resolve();
            },
            onHeartbeat: (result) => {
                this.publishRttMeasurement(peerId, result);
                return Promise.resolve();
            }
        };
    }

    private publishRttMeasurement(peerId: PeerId, result: PingResult): void {
        const previousVersion = this.rttVersionByPeerId.get(peerId) ?? 0;
        const version = Math.max(previousVersion + 1, result.version);
        this.rttVersionByPeerId.set(peerId, version);
        const rtt: RttMeasurementInfo = {
            sessionIdFrom: this.runtime.sessionId,
            sessionIdTo: peerId,
            rttMs: result.rttMsecs,
            createdAtEpochMs: this.runtime.nowEpochMs(),
            version
        };
        for (const callback of this.onRttMeasurementCallbacks.values()) {
            callback.onHeartbeat(rtt).catch((error) =>
                console.error('Error calling onRttMeasurementCallback', toError(error))
            );
        }
    }

    private shouldReportRttForPeer(peerId: PeerId): boolean {
        return this.rttReportingPeerIds === undefined ||
            this.rttReportingPeerIds.has(peerId);
    }

    private toRtcMediaSubscriptionId(peerId: PeerId) {
        return this.runtime.sessionId + '-' + peerId + '-rtc-media-remote-stream';
    }

    private toRtcChannelSubscriptionId(peerId: PeerId) {
        return this.runtime.sessionId + '-' + peerId + '-rtc-inbox';
    }

    private toHeartbeatCallbackId(peerId: PeerId) {
        return this.runtime.sessionId + '-' + peerId + '-rtc-datachannel-lifecycle';
    }

    private async dispatchInboxEntry(
        entry: ResourceEntry,
        plan: ALMessageHandlingPlan | undefined
    ): Promise<void> {
        const message = decodePersistedALMessage(entry.resource);

        let selectedCallback = this.onInboxMessageCallbacks.get(message.payload.typeId);
        let wildcard: OnMessageCallback | undefined;

        if (plan?.ownership.exclusive) {
            selectedCallback ??= this.onInboxMessageCallbacks.get(WebRtcRxStreamerService.ALL_IN);
            await this.onMessageIfPresent(selectedCallback, message, entry);
        }
        else {
            await this.onMessageIfPresent(selectedCallback, message, entry);

            wildcard = this.onInboxMessageCallbacks.get(WebRtcRxStreamerService.ALL_IN);
            await this.onMessageIfPresent(wildcard, message, entry);
        }

        if (selectedCallback === undefined && wildcard === undefined) {
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
        }
        catch (error) {
            console.error('Error calling onMessage callback', toError(error));
        }
    }

    onAllInboxMessagesDo(callback: OnMessageCallback, forceUpdate: boolean = false): WebRtcRxStreamerService {
        if (!forceUpdate && this.onInboxMessageCallbacks.has(WebRtcRxStreamerService.ALL_IN)) {
            throw new Error('Cannot set multiple Rtc inbox callbacks for ALL_IN');
        }

        this.onInboxMessageCallbacks.set(WebRtcRxStreamerService.ALL_IN, callback);
        return this;
    }

    onInboxMessageDo(id: string, callback: OnMessageCallback): WebRtcRxStreamerService {
        this.onInboxMessageCallbacks.set(id, callback);
        return this;
    }

    removeInboxMessageCallback(id: string): boolean {
        return this.onInboxMessageCallbacks.delete(id);
    }

    onRemoteStreamDo(
        id: string,
        cb: (peerId: string, stream: MediaStream, event: RTCTrackEvent) => Promise<void>
    ): WebRtcRxStreamerService {
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

    async enqueueOutboxIfAbsent(msg: ALMessage): Promise<ALOutboundEnqueueResult> {
        return await this.multicast.enqueueIfAbsent(msg);
    }

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.inbox,
            typesToDequeue,
            resilience,
            QueueBoxUtilities.withRetryDisposition(
                async (entry) => await this.inboundRuntime.dispatchStoredEntry(entry)
            )
        );
    }

    async setLocalMediaStream(stream: MediaStream): Promise<void> {
        this.status.localMediaStream = stream;

        for (const peer of this.peerDtoByPeerId.values()) {
            await peer.media.setLocalMediaStream(stream);
            peer.media.setLocalAudioEnabled(this.status.localAudioEnabled);
            peer.media.setLocalVideoEnabled(this.status.localVideoEnabled);
        }
    }

    setLocalAudioEnabled(enabled: boolean): void {
        this.status.localAudioEnabled = enabled;

        for (const peer of this.peerDtoByPeerId.values()) {
            peer.media.setLocalAudioEnabled(enabled);
        }
    }

    setLocalVideoEnabled(enabled: boolean): void {
        this.status.localVideoEnabled = enabled;

        for (const peer of this.peerDtoByPeerId.values()) {
            peer.media.setLocalVideoEnabled(enabled);
        }
    }

    stopLocalMedia(kind: 'audio' | 'video' | 'all'): void {
        for (const peer of this.peerDtoByPeerId.values()) {
            peer.media.stopLocalMedia(kind);
        }
    }

    setMediaPolicy(policy: QRtcMediaPolicy): void {
        this.status.mediaPolicy = policy;

        for (const peer of this.peerDtoByPeerId.values()) {
            peer.connection.applyMediaPolicy(policy);
        }
    }
}
