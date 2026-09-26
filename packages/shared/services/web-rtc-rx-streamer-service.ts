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
import { toALRtcPeerSource } from '../alm/inbound/al-inbound-source-validation.ts';
import { createDefaultALInboundRuntimeResources } from '../alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundCancelOutcome } from '../alm/outbound/al-outbound-message-runtime.ts';
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
import type { WebRtcConnectionService } from './web-rtc-connection-service.ts';
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
        /** True permits one admission re-entry after authority refresh, subject to normal admission checks. */
        afterInboundAdmission(
            message: ALMessage,
            acceptance: ALInboundMessageRuntime.Acceptance
        ): Promise<boolean>;
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
    private readonly peersByPeerId = new Map<PeerId, WebRtcConnectionService.Peer>();
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
                carrier: 'rtc',
                planIncomingMessage: (msg, source, observations) => {
                    return this.multicast.planIncomingMessage(msg, source, observations);
                },
                canDispatchMessage: (message) => this.hasInboxConsumer(message),
                dispatchInboxEntry: async (entry, plan) => {
                    return await this.dispatchInboxEntry(entry, plan);
                },
                sendControlMessages: async (msgs) => {
                    await this.handoffControlMessages(msgs);
                },
                onControlMessage: async (msg) => {
                    await this.multicast.acceptControlMessage(msg);
                },
                forwardMessage: async (msg, fromPeerId) => {
                    await this.multicast.forwardIfRequired(msg, fromPeerId);
                },
                forwardRetriedCopy: async (copy) => {
                    await this.multicast.forwardRetriedCopy(copy);
                },
                isRoomPeerPresent: (msg, peerId) => this.multicast.isRoomPeerPresent(msg, peerId),
                diagnostics: dependencies.inboundDiagnostics
            }
        );
    }

    private async handoffControlMessages(msgs: readonly ALMessage[]): Promise<void> {
        const results = await this.multicast.enqueueAllIfAbsent(msgs);
        for (const result of results) {
            this.validateControlHandoff(result);
        }
    }

    private validateControlHandoff(result: ALOutboundEnqueueResult): void {
        switch (result.verdict.kind) {
            case 'pending':
            case 'admitted':
            case 'duplicate':
                return;
            case 'deferred':
            case 'unroutable':
            case 'failed':
                throw new Error(result.reason ?? `RTC control admission returned ${result.verdict.kind}`);
            case 'refused':
            case 'skipped':
            case 'superseded':
            case 'expired':
                throw new NonRetryableException(
                    result.reason ?? `RTC control admission returned ${result.verdict.kind}`
                );
        }
    }

    addPeer(peer: WebRtcConnectionService.Peer): void {
        if (this.peersByPeerId.has(peer.peerId)) {
            console.warn(`Peer ${peer.peerId} already exists. Ignoring ...`);
            return;
        }

        this.peersByPeerId.set(peer.peerId, peer);
        this.registerPeerMessages(peer);
        this.registerPeerMedia(peer);
    }

    private registerPeerMessages(peer: WebRtcConnectionService.Peer): void {
        peer.channel
            .onRtcCallbacksDo(
                this.toHeartbeatCallbackId(peer.peerId),
                this.toHeartbeatCallbacks(peer.peerId)
            )
            .onRtcMessageDo(
                this.toRtcChannelSubscriptionId(peer.peerId),
                {
                    maxMessageBytes: AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
                    onMessage: async (value) => await this.admitPeerMessage(peer, value)
                }
            );
    }

    private async admitPeerMessage(peer: WebRtcConnectionService.Peer, value: unknown): Promise<void> {
        if (this.disposed || this.peersByPeerId.get(peer.peerId) !== peer) {
            return;
        }
        const message = decodeALMessageValue(value).right;
        const source = toALRtcPeerSource(peer.peerId, message);
        const acceptance = await this.inboundRuntime.admitIncomingMessage(value, source);
        if (acceptance.left) {
            console.warn('Rejected RTC message', acceptance.left.code);
            return;
        }
        if (!acceptance.right || !message) {
            return;
        }
        const refreshed = await this.dependencies.roomAuthorityRefresh?.afterInboundAdmission(
            message,
            acceptance.right
        );
        if (!refreshed || this.disposed || this.peersByPeerId.get(peer.peerId) !== peer) {
            return;
        }
        const retry = await this.inboundRuntime.admitIncomingMessage(message, source);
        if (retry.left) {
            console.warn('Rejected RTC message after authority refresh', retry.left.code);
        }
    }

    private registerPeerMedia(peer: WebRtcConnectionService.Peer): void {
        if (this.status.mediaPolicy) {
            peer.connection.applyMediaPolicy(this.status.mediaPolicy);
        }

        peer.media
            .onRemoteStreamDo(
                this.toRtcMediaSubscriptionId(peer.peerId),
                (stream, event) => this.publishRemoteStream(peer.peerId, stream, event)
            );

        if (this.status.localMediaStream) {
            peer.media.setParameters(
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

    removePeer(peer: WebRtcConnectionService.Peer): void {
        this.peersByPeerId.delete(peer.peerId);

        peer.media.removeOnRemoteStreamCallbackById(this.toRtcMediaSubscriptionId(peer.peerId));
        peer.channel.removeOnRtcMessageCallbackById(this.toRtcChannelSubscriptionId(peer.peerId));
        peer.channel.removeRtcCallbackById(this.toHeartbeatCallbackId(peer.peerId));

        const heartbeat = this.heartbeatByPeerId.get(peer.peerId);

        heartbeat?.stop();

        this.heartbeatByPeerId.delete(peer.peerId);
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
            const peer = this.peersByPeerId.get(peerId);
            if (peer?.channel.isOpen()) {
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
        const peer = this.peersByPeerId.get(peerId);
        if (!peer) {
            return Promise.resolve();
        }

        let heartbeat = this.heartbeatByPeerId.get(peerId);
        if (!heartbeat) {
            heartbeat = new WebRtcHeartbeatService({
                sessionId: this.sessionId,
                peerSessionId: peerId,
                channel: peer.channel,
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
        if (entry.audit.expiryTs.epochMilliseconds <= this.dependencies.epochNow()) {
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
            if (entry.audit.expiryTs.epochMilliseconds <= this.dependencies.epochNow()) {
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
        callback: (peerId: string, stream: MediaStream, event: RTCTrackEvent) => Promise<void>
    ): WebRtcRxStreamerService {
        this.onRemoteStreamCallbacks.set(id, callback);
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

    cancelOutbox(msgId: string): ALOutboundCancelOutcome {
        return this.multicast.cancel(msgId);
    }

    async enqueueOutboxIfAbsent(msg: ALMessage): Promise<ALOutboundEnqueueResult> {
        return await this.multicast.enqueueIfAbsent(msg);
    }

    async setLocalMediaStream(stream: MediaStream): Promise<void> {
        this.status.localMediaStream = stream;

        for (const peer of this.peersByPeerId.values()) {
            await peer.media.setLocalMediaStream(stream);
            peer.media.setLocalAudioEnabled(this.status.localAudioEnabled);
            peer.media.setLocalVideoEnabled(this.status.localVideoEnabled);
        }
    }

    setLocalAudioEnabled(enabled: boolean): void {
        this.status.localAudioEnabled = enabled;

        for (const peer of this.peersByPeerId.values()) {
            peer.media.setLocalAudioEnabled(enabled);
        }
    }

    setLocalVideoEnabled(enabled: boolean): void {
        this.status.localVideoEnabled = enabled;

        for (const peer of this.peersByPeerId.values()) {
            peer.media.setLocalVideoEnabled(enabled);
        }
    }

    stopLocalMedia(kind: 'audio' | 'video' | 'all'): void {
        for (const peer of this.peersByPeerId.values()) {
            peer.media.stopLocalMedia(kind);
        }
    }

    setMediaPolicy(policy: QRtcMediaPolicy): void {
        this.status.mediaPolicy = policy;

        for (const peer of this.peersByPeerId.values()) {
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
