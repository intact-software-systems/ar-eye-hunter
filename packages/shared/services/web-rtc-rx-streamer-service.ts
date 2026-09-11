import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    decodeALMessageValue,
    decodePersistedALMessage
} from '../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
import type { ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import type { ALInboundRuntimeStores } from '../alm/inbound/al-inbound-message-runtime.ts';
import { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '../alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createDefaultALInboundRuntimeResources } from '../alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundEnqueueResult } from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    EnqueuedType,
    type PeerId,
    type RttMeasurementInfo
} from '../api/api-config.ts';
import type { WebRtcOverlayMulticastManager } from '../multicast/web-rtc-overlay-multicast-manager.ts';
import { NonRetryableException } from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { toError } from '../resilience/to-error.ts';
import type { QRtcClientCallbacks } from '../webrtc/qrtc-client-callbacks.ts';
import type { QRtcMediaPolicy } from '../webrtc/qrtc-peer-connection.ts';
import type { InboxOutboxEngine } from './InboxOutboxEngine.ts';
import { QueueBoxUtilities } from './queue-box-utilities.ts';
import type { OnMessageCallback } from './queue-message-callbacks.ts';
import type { QRtcPeerDto } from './web-rtc-connection-service.ts';
import {
    defaultMaxMissedPings,
    defaultPingFrequencyMsecs,
    WebRtcHeartbeatService,
    type PingResult
} from './web-rtc-heartbeat-service.ts';

export interface RttMeasurementCallbacks {
    readonly onHeartbeat: (rtt: RttMeasurementInfo) => Promise<void>;
}

export namespace WebRtcRxStreamerService {
    export interface Status {
        localMediaStream: MediaStream | undefined;
        localAudioEnabled: boolean;
        localVideoEnabled: boolean;
        mediaPolicy: QRtcMediaPolicy | undefined;
    }

    export interface RoomAuthorityRefresh {
        afterInboundAdmission(
            message: ALMessage,
            acceptance: ALInboundMessageRuntime.Acceptance
        ): Promise<void>;
        dispose(): void;
    }

    export interface Input {
        readonly queueEngine?: InboxOutboxEngine;
        readonly multicast: WebRtcOverlayMulticastManager;
        readonly sessionId: string;
        readonly inboundStores?: ALInboundRuntimeStores;
        readonly nowEpochMs?: () => number;
        readonly heartbeat?: Pick<WebRtcHeartbeatService.InputDto, 'maxMissedPings' | 'pingFrequencyMsecs'>;
        readonly roomAuthorityRefresh?: RoomAuthorityRefresh;
        readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
    }

    export interface Dependencies {
        readonly multicast: WebRtcOverlayMulticastManager;
        readonly sessionId: string;
        readonly inboundRuntime: ALInboundMessageRuntime.Resources;
        readonly epochNow: () => number;
        readonly heartbeat: {
            readonly maxMissedPings: number;
            readonly pingFrequencyMsecs: number;
        };
        readonly roomAuthorityRefresh: RoomAuthorityRefresh | undefined;
        readonly inboundDiagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
    }
}

export class WebRtcRxStreamerService {
    private static readonly ALL_IN = '*';

    private readonly onInboxMessageCallbacks = new Map<string, OnMessageCallback>();
    private readonly onRttMeasurementCallbacks = new Map<string, RttMeasurementCallbacks>();

    private readonly onRemoteStreamCallbacks: Map<
        string,
        (peerId: string, stream: MediaStream, event: RTCTrackEvent) => Promise<void>
    > = new Map();

    private readonly status: WebRtcRxStreamerService.Status = {
        localMediaStream: undefined,
        localAudioEnabled: false,
        localVideoEnabled: false,
        mediaPolicy: undefined
    };

    private readonly heartbeatByPeerId = new Map<PeerId, WebRtcHeartbeatService>();
    private readonly rttVersionByPeerId = new Map<PeerId, number>();
    private readonly peerDtoByPeerId = new Map<PeerId, QRtcPeerDto>();
    private readonly inboundRuntime: ALInboundMessageRuntime;
    private disposed = false;
    private rttReportingPeerIds: ReadonlySet<PeerId> | undefined;

    public readonly multicast: WebRtcOverlayMulticastManager;
    public readonly sessionId: string;
    private readonly dependencies: WebRtcRxStreamerService.Dependencies;

    constructor(dependencies: WebRtcRxStreamerService.Dependencies) {
        this.dependencies = dependencies;
        this.multicast = dependencies.multicast;
        this.sessionId = dependencies.sessionId;
        this.inboundRuntime = new ALInboundMessageRuntime(
            {
                ...dependencies.inboundRuntime,
                planIncomingMessage: (msg, source, observations) => {
                    return this.multicast.planIncomingMessage(msg, source, observations);
                },
                canDispatchMessage: (message) => this.hasInboxConsumer(message),
                dispatchInboxEntry: async (entry, plan) => {
                    return await this.dispatchInboxEntry(entry, plan);
                },
                sendControlMessage: async (msg) => await this.handoffControlMessage(msg),
                onControlMessage: async (msg) => {
                    await this.multicast.acceptControlMessage(msg);
                },
                forwardMessage: async (msg, fromPeerId) => {
                    await this.multicast.forwardIfRequired(msg, fromPeerId);
                },
                diagnostics: dependencies.inboundDiagnostics
            }
        );
    }

    private async handoffControlMessage(msg: ALMessage): Promise<void> {
        const result = await this.multicast.enqueueIfAbsent(msg);
        switch (result.status) {
            case 'pending-admission':
            case 'enqueued':
            case 'accepted':
            case 'duplicate':
                return;
            case 'no-route':
            case 'rate-limited':
            case 'circuit-open':
            case 'failed':
                throw new Error(result.reason ?? `RTC control admission returned ${result.status}`);
            case 'skipped':
            case 'superseded':
            case 'expired':
                throw new NonRetryableException(
                    result.reason ?? `RTC control admission returned ${result.status}`
                );
        }
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
                    maxMessageBytes: AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
                    onMessage: async (value) => {
                        const message = decodeALMessageValue(value).right;
                        const acceptance = await this.inboundRuntime.admitIncomingMessage(value, {
                            kind: 'rtc-peer',
                            peerId: peerDto.peerId
                        });
                        if (acceptance.left) {
                            console.warn('Rejected RTC message', acceptance.left.code);
                            return;
                        }
                        if (acceptance.right && message) {
                            await this.dependencies.roomAuthorityRefresh?.afterInboundAdmission(
                                message,
                                acceptance.right
                            );
                        }
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

    dispose(): void {
        this.disposed = true;
        this.dependencies.roomAuthorityRefresh?.dispose();
        this.inboundRuntime.dispose();
        this.stopAllHeartbeats();
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
                sessionId: this.sessionId,
                peerSessionId: peerId,
                channel: dto.channel,
                maxMissedPings: this.dependencies.heartbeat.maxMissedPings,
                pingFrequencyMsecs: this.dependencies.heartbeat.pingFrequencyMsecs
            });
            this.heartbeatByPeerId.set(peerId, heartbeat);
        }
        heartbeat.startResponding();
        if (this.shouldReportRttForPeer(peerId)) {
            heartbeat.start(this.toRttMeasurementCallbacks(peerId));
        }
        return Promise.resolve();
    }

    private toRttMeasurementCallbacks(peerId: string): WebRtcHeartbeatService.Callbacks {
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
            sessionIdFrom: this.sessionId,
            sessionIdTo: peerId,
            rttMs: result.rttMsecs,
            createdAtEpochMs: this.dependencies.epochNow(),
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
        return this.sessionId + '-' + peerId + '-rtc-media-remote-stream';
    }

    private toRtcChannelSubscriptionId(peerId: PeerId) {
        return this.sessionId + '-' + peerId + '-rtc-inbox';
    }

    private toHeartbeatCallbackId(peerId: PeerId) {
        return this.sessionId + '-' + peerId + '-rtc-datachannel-lifecycle';
    }

    private hasInboxConsumer(message: ALMessage): boolean {
        return this.onInboxMessageCallbacks.has(message.payload.typeId) ||
            this.onInboxMessageCallbacks.has(WebRtcRxStreamerService.ALL_IN);
    }

    private async dispatchInboxEntry(
        entry: ResourceEntry,
        plan: ALMessageHandlingPlan
    ): Promise<void | 'retry'> {
        const message = decodePersistedALMessage(entry.resource);
        if (entry.audit.expiryTs.epochMilliseconds <= Date.now()) {
            throw new NonRetryableException('Inbound message expired before consumer delivery');
        }
        const selected = this.onInboxMessageCallbacks.get(message.payload.typeId) ??
            (plan.ownership.exclusive ? this.onInboxMessageCallbacks.get(WebRtcRxStreamerService.ALL_IN) : undefined);
        await selected?.onMessage(message, entry);
        if (this.disposed) {
            return 'retry';
        }
        const wildcard = plan.ownership.exclusive
            ? undefined
            : this.onInboxMessageCallbacks.get(WebRtcRxStreamerService.ALL_IN);
        if (wildcard !== undefined) {
            if (entry.audit.expiryTs.epochMilliseconds <= Date.now()) {
                throw new NonRetryableException('Inbound message expired before wildcard delivery');
            }
            await wildcard.onMessage(message, entry);
        }

        if (selected === undefined && wildcard === undefined) {
            return 'retry';
        }
    }

    onAllInboxMessagesDo(callback: OnMessageCallback, forceUpdate: boolean = false): WebRtcRxStreamerService {
        if (!forceUpdate && this.onInboxMessageCallbacks.has(WebRtcRxStreamerService.ALL_IN)) {
            throw new Error('Cannot set multiple Rtc inbox callbacks for ALL_IN');
        }

        this.onInboxMessageCallbacks.set(WebRtcRxStreamerService.ALL_IN, callback);
        this.dependencies.inboundRuntime.queueEngine.wake();
        return this;
    }

    onInboxMessageDo(id: string, callback: OnMessageCallback): WebRtcRxStreamerService {
        this.onInboxMessageCallbacks.set(id, callback);
        this.dependencies.inboundRuntime.queueEngine.wake();
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

export function createDefaultWebRtcRxStreamerService(input: WebRtcRxStreamerService.Input): WebRtcRxStreamerService {
    return new WebRtcRxStreamerService({
        multicast: input.multicast,
        sessionId: input.sessionId,
        inboundRuntime: createDefaultALInboundRuntimeResources({
            stores: input.inboundStores,
            queueEngine: input.queueEngine,
            selfPeerId: input.sessionId,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.RTC_INBOX)
        }),
        epochNow: input.nowEpochMs ?? Date.now,
        heartbeat: input.heartbeat ?? {
            maxMissedPings: defaultMaxMissedPings,
            pingFrequencyMsecs: defaultPingFrequencyMsecs
        },
        roomAuthorityRefresh: input.roomAuthorityRefresh,
        inboundDiagnostics: input.inboundDiagnostics
    });
}
