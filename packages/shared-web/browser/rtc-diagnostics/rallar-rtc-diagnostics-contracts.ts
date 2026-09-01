import type { RallarOverlayAdoptionDiagnostics } from '@shared/repository/overlays-repository.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import type { WebRtcGroupManagerDiagnostics } from '@shared/services/web-rtc-group-manager.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/qrtc-data-channel.ts';
import type { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

export interface RallarRtcPeerConnectionStatus {
    readonly state?: string;
    readonly connectionState?: string;
    readonly iceConnectionState?: string;
    readonly iceGatheringState?: string;
    readonly signalingState?: string;
    readonly hasLocalDescription: boolean;
    readonly hasRemoteDescription: boolean;
    readonly canTrickleIceCandidates?: boolean | null;
    readonly reconnectAttempts: number;
    readonly reconnecting: boolean;
    readonly disconnectPending: boolean;
    readonly makingOffer: boolean;
    readonly ignoreOffer: boolean;
    readonly iceCandidateQueueSize: number;
    readonly localStreamId?: string;
    readonly remoteStreamIds: readonly string[];
}

export interface RallarRtcLaneStatus {
    readonly peerId: string;
    readonly laneId: string;
    readonly channel?: RtcDataChannelHealth;
    readonly isOpen: boolean;
    readonly isReconnectable: boolean;
}

export interface RallarRtcPeerStatus {
    readonly peerId: string;
    readonly connection: RallarRtcPeerConnectionStatus;
    readonly lanes: readonly RallarRtcLaneStatus[];
    readonly isActive: boolean;
    readonly hasNoReconnectableLanes: boolean;
    readonly isRoutable: boolean;
    readonly readyLaneIds: readonly string[];
}

export interface RallarRtcStatus {
    readonly sessionId?: string;
    readonly laneId: string;
    readonly knownPeerIds: readonly string[];
    readonly activePeerIds: readonly string[];
    readonly peerIdsWithNoReconnectableLanes: readonly string[];
    readonly readyPeerIds: readonly string[];
    readonly peers: readonly RallarRtcPeerStatus[];
}

export interface RallarRtcDiagnosticsOptions {
    readonly peerIds?: readonly string[];
    readonly laneIds?: readonly string[];
}

export interface RallarRtcCandidateDiagnostics {
    readonly id?: string;
    readonly candidateType?: string;
    readonly protocol?: string;
    readonly address?: string;
    readonly ip?: string;
    readonly port?: number;
    readonly relayProtocol?: string;
    readonly networkType?: string;
    readonly url?: string;
}

export interface RallarRtcCandidatePairDiagnostics {
    readonly id?: string;
    readonly state?: string;
    readonly nominated?: boolean;
    readonly selected?: boolean;
    readonly currentRoundTripTime?: number;
    readonly availableOutgoingBitrate?: number;
    readonly bytesSent?: number;
    readonly bytesReceived?: number;
    readonly local?: RallarRtcCandidateDiagnostics;
    readonly remote?: RallarRtcCandidateDiagnostics;
    readonly usesRelay: boolean;
}

export interface RallarRtcPeerDiagnostics {
    readonly peerId: string;
    readonly connection: RallarRtcPeerConnectionStatus;
    readonly connectionDiagnostics?: QRtcPeerConnection.Diagnostics;
    readonly lanes: readonly RallarRtcLaneStatus[];
    readonly selectedCandidatePair?: RallarRtcCandidatePairDiagnostics;
    readonly usesRelay: boolean;
    readonly statsAvailable: boolean;
    readonly statsError?: string;
}

export interface RallarRtcDiagnostics {
    readonly sessionId?: string;
    readonly generatedAtEpochMs: number;
    readonly peerCount: number;
    readonly connectedPeerCount: number;
    readonly relayPeerCount: number;
    readonly peers: readonly RallarRtcPeerDiagnostics[];
    readonly groupManager?: WebRtcGroupManagerDiagnostics;
    readonly overlayAdoption?: RallarOverlayAdoptionDiagnostics;
    readonly connectionAttemptBudget?: WebRtcConnectionService.PeerConnectionAttemptBudgetDiagnostics;
}
