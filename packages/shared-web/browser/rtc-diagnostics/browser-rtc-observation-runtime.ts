import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
    RallarRtcLaneStatus,
    RallarRtcLifecycleKind,
    RallarRtcLifecycleListener,
    RallarRtcPeerConnectionStatus,
    RallarRtcPeerStatus,
    RallarRtcStatus,
    RallarRtcStatusListener,
    RallarRtcStatusOptions,
    RallarRtcStatusSubscriptionOptions
} from '@shared-web/browser/rallar-rtc-facade.ts';
import { notifyListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto } from '@shared/services/WebRtcConnectionService.ts';
import type { QRtcClientCallbacks } from '@shared/webrtc/QRtcClientCallbacks.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/QRtcDataChannel.ts';

const RALLAR_RTC_STATUS_CALLBACK_ID = 'rallar:rtc:status';

interface RallarRtcStatusSubscription {
    readonly listener: RallarRtcStatusListener;
    readonly options: RallarRtcStatusSubscriptionOptions;
}

interface RallarRtcLifecycleSubscription {
    readonly listener: RallarRtcLifecycleListener;
    readonly options: RallarRtcStatusSubscriptionOptions;
}

interface RallarRtcLifecycleEventInput {
    readonly peerId?: string;
    readonly laneId?: string;
}

interface BrowserRtcPeerStatusInput {
    readonly peerId: string;
    readonly peer: QRtcPeerDto | undefined;
    readonly activePeerIds: ReadonlySet<string>;
    readonly peerIdsWithNoReconnectableLanes: ReadonlySet<string>;
    readonly readyPeerIds: ReadonlySet<string>;
}

export namespace BrowserRtcObservationRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
        readSession(): AuthSession | undefined;
    }
}

/** Owns browser RTC status observation and lifecycle subscriptions. */
export class BrowserRtcObservationRuntime {
    private readonly rtcStatusListeners = new Set<RallarRtcStatusSubscription>();
    private readonly rtcLifecycleListeners = new Set<RallarRtcLifecycleSubscription>();
    private readonly input: BrowserRtcObservationRuntime.Input;

    constructor(input: BrowserRtcObservationRuntime.Input) {
        this.input = input;
    }

    status(options: RallarRtcStatusOptions = {}): RallarRtcStatus {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const ctx = this.input.readMiddleware();
        if (!ctx) {
            return {
                sessionId: this.input.readSession()?.sessionId,
                laneId,
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: []
            };
        }

        const service = ctx.middleware.webRtcConnectionService;
        const knownPeerIds = service.knownPeerIds();
        const activePeerIds = service.activePeerIds();
        const peerIdsWithNoReconnectableLanes = service
            .peerIdsWithNoReconnectableLanes();
        const readyPeerIds = service.readyPeerIdsForLane(laneId);
        const activePeerIdSet = new Set(activePeerIds);
        const peerIdsWithNoReconnectableLanesSet = new Set(
            peerIdsWithNoReconnectableLanes
        );
        const readyPeerIdSet = new Set(readyPeerIds);

        return {
            sessionId: ctx.session.sessionId,
            laneId,
            knownPeerIds,
            activePeerIds,
            peerIdsWithNoReconnectableLanes,
            readyPeerIds,
            peers: knownPeerIds.map((peerId) =>
                this.peerStatus({
                    peerId,
                    peer: service.readPeer(peerId),
                    activePeerIds: activePeerIdSet,
                    peerIdsWithNoReconnectableLanes: peerIdsWithNoReconnectableLanesSet,
                    readyPeerIds: readyPeerIdSet
                })
            )
        };
    }

    peer(peerId: string, options?: RallarRtcStatusOptions): RallarRtcPeerStatus | undefined {
        return this.status(options).peers.find((peer) => peer.peerId === peerId);
    }

    knownPeerIds(): readonly string[] {
        return this.input.readMiddleware()?.middleware.webRtcConnectionService
            .knownPeerIds() ?? [];
    }

    activePeerIds(): readonly string[] {
        return this.input.readMiddleware()?.middleware.webRtcConnectionService
            .activePeerIds() ?? [];
    }

    peerIdsWithNoReconnectableLanes(): readonly string[] {
        return this.input.readMiddleware()?.middleware.webRtcConnectionService
            .peerIdsWithNoReconnectableLanes() ?? [];
    }

    readyPeerIds(laneId?: string): readonly string[] {
        return this.input.readMiddleware()?.middleware.webRtcConnectionService
            .readyPeerIdsForLane(laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID) ?? [];
    }

    onStatus(
        listener: RallarRtcStatusListener,
        options: RallarRtcStatusSubscriptionOptions
    ): RallarUnsubscribe {
        const subscription = { listener, options };
        this.rtcStatusListeners.add(subscription);
        this.registerCallbacks();
        if (options.emitCurrent ?? true) {
            notifyListener(listener, this.status(options));
        }

        return () => {
            this.rtcStatusListeners.delete(subscription);
            this.unregisterCallbacksIfUnused();
        };
    }

    onLifecycle(
        listener: RallarRtcLifecycleListener,
        options: RallarRtcStatusSubscriptionOptions
    ): RallarUnsubscribe {
        const subscription = { listener, options };
        this.rtcLifecycleListeners.add(subscription);
        this.registerCallbacks();
        if (options.emitCurrent ?? true) {
            this.notifyLifecycleSubscription(subscription, 'snapshot');
        }

        return () => {
            this.rtcLifecycleListeners.delete(subscription);
            this.unregisterCallbacksIfUnused();
        };
    }

    attach(ctx = this.input.readMiddleware()): void {
        this.registerCallbacks(ctx);
    }

    connected(): void {
        this.emitLifecycle('connected');
    }

    detach(ctx = this.input.readMiddleware()): void {
        this.unregisterCallbacks(ctx);
    }

    disconnected(): void {
        this.emitLifecycle('disconnected');
    }

    private peerStatus(input: BrowserRtcPeerStatusInput): RallarRtcPeerStatus {
        const lanes = input.peer
            ? Array.from(input.peer.channels.entries()).map(([laneId, channel]) =>
                toRtcLaneStatus(input.peerId, laneId, channel.readHealth())
            )
            : [];

        return {
            peerId: input.peerId,
            connection: toRtcConnectionStatus(input.peer),
            lanes,
            isActive: input.activePeerIds.has(input.peerId),
            hasNoReconnectableLanes: input.peerIdsWithNoReconnectableLanes.has(input.peerId),
            isRoutable: input.readyPeerIds.has(input.peerId),
            readyLaneIds: lanes.filter((lane) => lane.isOpen).map((lane) => lane.laneId)
        };
    }

    private registerCallbacks(ctx = this.input.readMiddleware()): void {
        if (!ctx || !this.hasSubscriptions()) {
            return;
        }

        const service = ctx.middleware.webRtcConnectionService;
        service.onRtcPeerLifecycleDo(RALLAR_RTC_STATUS_CALLBACK_ID, {
            onCreated: (peer) => {
                this.registerPeerCallbacks(peer);
                this.emitLifecycle('peer-created', { peerId: peer.peerId });
            },
            onDeleted: (peer) => {
                this.unregisterPeerCallbacks(peer);
                queueMicrotask(() => this.emitLifecycle('peer-deleted', { peerId: peer.peerId }));
            },
            onConnectTimeout: (peer) => {
                this.emitLifecycle('peer-timeout', { peerId: peer.peerId });
            }
        });

        for (const peerId of service.knownPeerIds()) {
            const peer = service.readPeer(peerId);
            if (peer) {
                this.registerPeerCallbacks(peer);
            }
        }
    }

    private registerPeerCallbacks(peer: QRtcPeerDto): void {
        for (const [laneId, channel] of peer.channels.entries()) {
            channel.onRtcCallbacksDo(
                RALLAR_RTC_STATUS_CALLBACK_ID,
                this.laneLifecycleCallbacks(peer.peerId, laneId)
            );
        }
    }

    private laneLifecycleCallbacks(peerId: string, laneId: string): QRtcClientCallbacks {
        return {
            onOpen: async () => this.emitLifecycle('lane-open', { peerId, laneId }),
            onClose: async () => this.emitLifecycle('lane-close', { peerId, laneId }),
            onError: async () => this.emitLifecycle('lane-error', { peerId, laneId })
        };
    }

    private unregisterCallbacksIfUnused(): void {
        if (!this.hasSubscriptions()) {
            this.unregisterCallbacks();
        }
    }

    private unregisterCallbacks(ctx = this.input.readMiddleware()): void {
        if (!ctx) {
            return;
        }

        const service = ctx.middleware.webRtcConnectionService;
        service.removeRtcPeerLifecycleById(RALLAR_RTC_STATUS_CALLBACK_ID);
        for (const peerId of service.knownPeerIds()) {
            const peer = service.readPeer(peerId);
            if (peer) {
                this.unregisterPeerCallbacks(peer);
            }
        }
    }

    private unregisterPeerCallbacks(peer: QRtcPeerDto): void {
        for (const channel of peer.channels.values()) {
            channel.removeRtcCallbackById(RALLAR_RTC_STATUS_CALLBACK_ID);
        }
    }

    private hasSubscriptions(): boolean {
        return this.rtcStatusListeners.size > 0 || this.rtcLifecycleListeners.size > 0;
    }

    private emitLifecycle(
        kind: RallarRtcLifecycleKind,
        input: RallarRtcLifecycleEventInput = {}
    ): void {
        this.emitStatus();
        for (const subscription of this.rtcLifecycleListeners) {
            this.notifyLifecycleSubscription(subscription, kind, input);
        }
    }

    private emitStatus(): void {
        for (const subscription of this.rtcStatusListeners) {
            notifyListener(subscription.listener, this.status(subscription.options));
        }
    }

    private notifyLifecycleSubscription(
        subscription: RallarRtcLifecycleSubscription,
        kind: RallarRtcLifecycleKind,
        input: RallarRtcLifecycleEventInput = {}
    ): void {
        const status = this.status(subscription.options);
        const peer = input.peerId
            ? status.peers.find((candidate) => candidate.peerId === input.peerId)
            : undefined;
        const lane = input.laneId
            ? peer?.lanes.find((candidate) => candidate.laneId === input.laneId)
            : undefined;

        notifyListener(subscription.listener, {
            kind,
            atEpochMs: Date.now(),
            status,
            peerId: input.peerId,
            laneId: input.laneId,
            peer,
            lane
        });
    }
}

function toRtcConnectionStatus(
    peer: QRtcPeerDto | undefined
): RallarRtcPeerConnectionStatus {
    const status = peer?.connection.status;
    const pc = status?.pc;

    return {
        state: status?.state ? String(status.state) : undefined,
        connectionState: pc?.connectionState,
        iceConnectionState: pc?.iceConnectionState,
        iceGatheringState: pc?.iceGatheringState,
        signalingState: pc?.signalingState,
        hasLocalDescription: pc?.localDescription !== null && pc?.localDescription !== undefined,
        hasRemoteDescription: pc?.remoteDescription !== null && pc?.remoteDescription !== undefined,
        canTrickleIceCandidates: pc?.canTrickleIceCandidates,
        reconnectAttempts: status?.reconnectAttempts ?? 0,
        reconnecting: status?.reconnectTimer !== undefined,
        disconnectPending: status?.disconnectTimer !== undefined,
        makingOffer: status?.makingOffer ?? false,
        ignoreOffer: status?.ignoreOffer ?? false,
        iceCandidateQueueSize: status?.iceCandidateQueue.length ?? 0,
        localStreamId: status?.localStream?.id,
        remoteStreamIds: Array.from(status?.remoteStreams.keys() ?? [])
    };
}

function toRtcLaneStatus(
    peerId: string,
    laneId: string,
    channel: RtcDataChannelHealth | undefined
): RallarRtcLaneStatus {
    return {
        peerId,
        laneId,
        channel,
        isOpen: channel?.readyState === 'open' || channel?.state === 'Open',
        isReconnectable: channel?.state === 'Idle' ||
            channel?.state === 'Closed' ||
            channel?.state === 'Failed'
    };
}
