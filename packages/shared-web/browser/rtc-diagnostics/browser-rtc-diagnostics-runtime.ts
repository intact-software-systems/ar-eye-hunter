import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRtcDiagnostics,
    RallarRtcDiagnosticsOptions,
    RallarRtcPeerDiagnostics,
    RallarRtcPeerStatus,
    RallarRtcStatus,
    RallarRtcStatusOptions
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { readOverlayAdoptionDiagnostics } from '@shared/repository/overlays-repository.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
    type WebRtcConnectionService
} from '@shared/services/web-rtc-connection-service.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { readSelectedCandidatePairDiagnostics } from './read-selected-candidate-pair-diagnostics.ts';

export namespace BrowserRtcDiagnosticsRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
        readSession(): AuthSession | undefined;
        readStatus(options: RallarRtcStatusOptions): RallarRtcStatus;
    }

    export interface PeerInput {
        readonly middleware: ApiMiddleware;
        readonly service: WebRtcConnectionService;
        readonly pc: RTCPeerConnection | undefined;
        readonly captureIdentity: RtcSignalingDiagnostics.NativeIdentity;
        readonly status: RallarRtcPeerStatus;
        readonly peer: WebRtcConnectionService.Peer | undefined;
        readonly options: RallarRtcDiagnosticsOptions;
    }
}

/** Owns browser RTC diagnostic collection and candidate-pair failure reporting. */
export class BrowserRtcDiagnosticsRuntime {
    private readonly input: BrowserRtcDiagnosticsRuntime.Input;

    constructor(input: BrowserRtcDiagnosticsRuntime.Input) {
        this.input = input;
    }

    async read(options: RallarRtcDiagnosticsOptions = {}): Promise<RallarRtcDiagnostics> {
        const middlewareContext = this.input.readMiddleware();
        const sessionId = middlewareContext?.session.sessionId ?? this.input.readSession()?.sessionId;
        if (!middlewareContext) {
            return {
                sessionId,
                generatedAtEpochMs: Date.now(),
                peerCount: 0,
                connectedPeerCount: 0,
                relayPeerCount: 0,
                peers: []
            };
        }

        const service = middlewareContext.middleware.webRtcConnectionService;
        const status = this.input.readStatus({
            ...options,
            laneId: options.laneIds?.[0] ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID
        });
        const peerIds = options.peerIds ?? status.knownPeerIds;
        const peers = await Promise.all(
            [...new Set(peerIds)].map(async (peerId) => {
                const peerStatus = status.peers.find((peer) => peer.peerId === peerId) ??
                    toMissingRtcPeerStatus(peerId);
                const peer = service.readPeer(peerId);
                return await this.readPeer({
                    middleware: middlewareContext,
                    service,
                    pc: peer?.connection.status.pc,
                    captureIdentity: peer?.connection.getNativeIdentity() ??
                        Object.freeze({
                            peerConnectionId: Object.freeze({ status: 'unavailable', reason: 'no-native-object' }),
                            channelId: Object.freeze({ status: 'unavailable', reason: 'not-applicable' })
                        }),
                    status: peerStatus,
                    peer,
                    options
                });
            })
        );

        return {
            sessionId,
            generatedAtEpochMs: Date.now(),
            peerCount: peers.length,
            connectedPeerCount: peers.filter(
                (peer) => peer.connection.connectionState === 'connected'
            ).length,
            relayPeerCount: peers.filter((peer) => peer.usesRelay).length,
            peers,
            groupManager: middlewareContext.middleware.webRtcGroupManager.readDiagnostics?.(),
            overlayAdoption: readOverlayAdoptionDiagnostics(),
            connectionAttemptBudget: service.readPeerConnectionAttemptBudgetDiagnostics?.()
        };
    }

    private async readPeer(input: BrowserRtcDiagnosticsRuntime.PeerInput): Promise<RallarRtcPeerDiagnostics> {
        const laneIds = input.options.laneIds ? new Set(input.options.laneIds) : undefined;
        const lanes = laneIds
            ? input.status.lanes.filter((lane) => laneIds.has(lane.laneId))
            : input.status.lanes;
        const connectionDiagnostics = input.peer?.connection.readDiagnostics?.();

        const diagnostics = {
            peerId: input.status.peerId,
            captureIdentity: input.captureIdentity,
            connection: input.status.connection,
            lanes,
            ...(connectionDiagnostics === undefined ? {} : { connectionDiagnostics })
        };
        try {
            const supported = input.pc !== undefined && typeof input.pc.getStats === 'function';
            const selectedCandidatePair = await readSelectedCandidatePairDiagnostics(input.pc);
            if (!this.isCurrentStatsCapture(input)) {
                return {
                    ...diagnostics,
                    statsObservation: 'retired-during-read',
                    usesRelay: false,
                    statsAvailable: false
                };
            }
            return {
                ...diagnostics,
                selectedCandidatePair,
                usesRelay: selectedCandidatePair?.usesRelay ?? false,
                statsAvailable: selectedCandidatePair !== undefined,
                statsObservation: !input.pc
                    ? 'no-native-peer'
                    : !supported
                    ? 'unsupported'
                    : selectedCandidatePair
                    ? 'current-at-completion'
                    : 'no-selected-pair'
            };
        }
        catch (error) {
            return this.isCurrentStatsCapture(input)
                ? {
                    ...diagnostics,
                    statsObservation: 'read-failed',
                    usesRelay: false,
                    statsAvailable: false,
                    statsError: toError(error).message
                }
                : { ...diagnostics, statsObservation: 'retired-during-read', usesRelay: false, statsAvailable: false };
        }
    }

    private isCurrentStatsCapture(capture: BrowserRtcDiagnosticsRuntime.PeerInput): boolean {
        const middleware = this.input.readMiddleware();
        return middleware === capture.middleware && middleware.middleware.webRtcConnectionService === capture.service &&
            capture.service.readPeer(capture.status.peerId) === capture.peer &&
            capture.peer?.connection.status.pc === capture.pc;
    }
}

function toMissingRtcPeerStatus(peerId: string): RallarRtcPeerStatus {
    return {
        peerId,
        connection: {
            hasLocalDescription: false,
            hasRemoteDescription: false,
            reconnectAttempts: 0,
            reconnecting: false,
            disconnectPending: false,
            makingOffer: false,
            ignoreOffer: false,
            iceCandidateQueueSize: 0,
            remoteStreamIds: [],
            signaling: {
                outboundOfferCount: 0,
                outboundAnswerCount: 0,
                outboundIceCandidateCount: 0,
                inboundOfferCount: 0,
                inboundAnswerCount: 0,
                inboundIceCandidateCount: 0,
                outboundSignalingErrorCount: 0,
                inboundSignalingErrorCount: 0
            }
        },
        lanes: [],
        isActive: false,
        hasNoReconnectableLanes: false,
        isRoutable: false,
        readyLaneIds: []
    };
}
