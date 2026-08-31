import type { RallarOverlayAdoptionDiagnostics } from '@shared/repository/overlays-repository.ts';
import type { WebRtcGroupManagerDiagnostics } from '@shared/services/web-rtc-group-manager.ts';
import type { WebRtcPeerConnectionAttemptBudgetDiagnostics } from '@shared/services/WebRtcConnectionService.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/QRtcDataChannel.ts';
import type { QRtcPeerConnectionDiagnostics } from '@shared/webrtc/QRtcPeerConnection.ts';

export type RallarRtcPeerConnectionStatus = Readonly<{
    state?: string;
    connectionState?: string;
    iceConnectionState?: string;
    iceGatheringState?: string;
    signalingState?: string;
    hasLocalDescription: boolean;
    hasRemoteDescription: boolean;
    canTrickleIceCandidates?: boolean | null;
    reconnectAttempts: number;
    reconnecting: boolean;
    disconnectPending: boolean;
    makingOffer: boolean;
    ignoreOffer: boolean;
    iceCandidateQueueSize: number;
    localStreamId?: string;
    remoteStreamIds: readonly string[];
}>;

export type RallarRtcLaneStatus = Readonly<{
    peerId: string;
    laneId: string;
    channel?: RtcDataChannelHealth;
    isOpen: boolean;
    isReconnectable: boolean;
}>;

export type RallarRtcPeerStatus = Readonly<{
    peerId: string;
    connection: RallarRtcPeerConnectionStatus;
    lanes: readonly RallarRtcLaneStatus[];
    isActive: boolean;
    hasNoReconnectableLanes: boolean;
    isRoutable: boolean;
    readyLaneIds: readonly string[];
}>;

export type RallarRtcStatus = Readonly<{
    sessionId?: string;
    laneId: string;
    knownPeerIds: readonly string[];
    activePeerIds: readonly string[];
    peerIdsWithNoReconnectableLanes: readonly string[];
    readyPeerIds: readonly string[];
    peers: readonly RallarRtcPeerStatus[];
}>;

export type RallarRtcDiagnosticsOptions = Readonly<{
    peerIds?: readonly string[];
    laneIds?: readonly string[];
}>;

export type RallarRtcCandidateDiagnostics = Readonly<{
    id?: string;
    candidateType?: string;
    protocol?: string;
    address?: string;
    ip?: string;
    port?: number;
    relayProtocol?: string;
    networkType?: string;
    url?: string;
}>;

export type RallarRtcCandidatePairDiagnostics = Readonly<{
    id?: string;
    state?: string;
    nominated?: boolean;
    selected?: boolean;
    currentRoundTripTime?: number;
    availableOutgoingBitrate?: number;
    bytesSent?: number;
    bytesReceived?: number;
    local?: RallarRtcCandidateDiagnostics;
    remote?: RallarRtcCandidateDiagnostics;
    usesRelay: boolean;
}>;

export type RallarRtcPeerDiagnostics = Readonly<{
    peerId: string;
    connection: RallarRtcPeerConnectionStatus;
    connectionDiagnostics?: QRtcPeerConnectionDiagnostics;
    lanes: readonly RallarRtcLaneStatus[];
    selectedCandidatePair?: RallarRtcCandidatePairDiagnostics;
    usesRelay: boolean;
    statsAvailable: boolean;
    statsError?: string;
}>;

export type RallarRtcDiagnostics = Readonly<{
    sessionId?: string;
    generatedAtEpochMs: number;
    peerCount: number;
    connectedPeerCount: number;
    relayPeerCount: number;
    peers: readonly RallarRtcPeerDiagnostics[];
    groupManager?: WebRtcGroupManagerDiagnostics;
    overlayAdoption?: RallarOverlayAdoptionDiagnostics;
    connectionAttemptBudget?: WebRtcPeerConnectionAttemptBudgetDiagnostics;
}>;
