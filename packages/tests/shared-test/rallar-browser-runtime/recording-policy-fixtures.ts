import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcPeerStatus, RallarRtcStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarRoomFormationStatus } from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import { toRallarRoomFormationStatus } from '@shared-web/browser/rooms/formation/room-formation-observation.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/qrtc-data-channel.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { createAcceptedGroupSnapshotFixture, createAcceptedOverlayFixture } from '../../shared-web/authoritative-group-fixtures.ts';

export function createHealthyRecordingPeer(peerId = 'session-c'): RallarRtcPeerStatus {
    return {
        peerId,
        isActive: true,
        hasNoReconnectableLanes: true,
        isRoutable: true,
        readyLaneIds: ['realtime'],
        connection: {
            state: 'Open',
            connectionState: 'connected',
            iceConnectionState: 'connected',
            iceGatheringState: 'complete',
            signalingState: 'stable',
            hasLocalDescription: true,
            hasRemoteDescription: true,
            canTrickleIceCandidates: true,
            reconnectAttempts: 0,
            reconnecting: false,
            disconnectPending: false,
            makingOffer: false,
            ignoreOffer: false,
            iceCandidateQueueSize: 0,
            remoteStreamIds: [],
            signaling: {
                outboundOfferCount: 1,
                outboundAnswerCount: 0,
                outboundIceCandidateCount: 1,
                inboundOfferCount: 0,
                inboundAnswerCount: 1,
                inboundIceCandidateCount: 1,
                outboundSignalingErrorCount: 0,
                inboundSignalingErrorCount: 0
            }
        },
        lanes: [{
            peerId,
            laneId: 'realtime',
            isOpen: true,
            isReconnectable: false,
            channel: createHealthyRecordingChannel(peerId)
        }]
    };
}

export function createHealthyRecordingRtcStatus(peers = [createHealthyRecordingPeer()]): RallarRtcStatus {
    return {
        sessionId: 'session-a',
        laneId: 'realtime',
        peers,
        knownPeerIds: peers.map((peer) => peer.peerId),
        activePeerIds: peers.filter((peer) => peer.isActive).map((peer) => peer.peerId),
        readyPeerIds: peers.filter((peer) => peer.isRoutable).map((peer) => peer.peerId),
        peerIdsWithNoReconnectableLanes: peers.filter((peer) => peer.hasNoReconnectableLanes).map((peer) => peer.peerId)
    };
}

export function createHealthyRecordingWsStatus(): RallarWsStatus {
    return {
        sessionId: 'session-a',
        connectState: 'connected',
        readyState: 'open',
        readyStateCode: 1,
        isOpen: true,
        reconnecting: false,
        reconnectEnabled: true,
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,
        reconnectExhausted: false
    };
}

export function createRecordingFormationStatus(): RallarRoomFormationStatus {
    const snapshot = createAcceptedGroupSnapshotFixture(['session-a', 'session-c']);
    return toRallarRoomFormationStatus({ snapshot, accepted: createAcceptedOverlayFixture(snapshot, 1, ['session-c']), planned: undefined });
}

const observedNativeIdentity: RtcSignalingDiagnostics.NativeIdentity = {
    peerConnectionId: { status: 'observed', value: 'pc-c' },
    channelId: { status: 'observed', value: 'channel-c' }
};
const capture: RtcSignalingDiagnostics.CaptureStatus = {
    scopeId: { status: 'observed', value: 'capture-a' },
    scope: 'active',
    ordinaryRowsSuppressed: false,
    admissionLimited: false,
    payloadLimited: false
};
const noError: RtcSignalingDiagnostics.ErrorReadout = {
    status: 'none-observed',
    coverage: {
        kind: 'listener-window',
        window: 'active',
        attachment: 'attached',
        attachmentGap: false
    }
};
const nativeSnapshot: RtcSignalingDiagnostics.NativeSnapshot = {
    identity: observedNativeIdentity,
    nativeSequence: 1,
    firstError: noError,
    firstTypedError: noError,
    capture,
    state: {
        connectionState: { status: 'observed', value: 'connected' },
        iceConnectionState: { status: 'observed', value: 'connected' },
        iceGatheringState: { status: 'observed', value: 'complete' },
        signalingState: { status: 'observed', value: 'stable' },
        iceTransportState: { status: 'observed', value: 'connected' },
        dtlsState: { status: 'observed', value: 'connected' },
        sctpState: { status: 'observed', value: 'connected' },
        channelState: { status: 'observed', value: 'open' },
        transportObjectOrdinal: { status: 'observed', value: 1 },
        transportBinding: 'data-sctp-chain',
        listenerCoverage: 'attached',
        attachmentGap: false
    }
};
const nativeError: RtcSignalingDiagnostics.NativeError = {
    source: 'channel-error',
    nativeSequence: 2,
    identity: observedNativeIdentity,
    errorDetail: { status: 'unavailable', reason: 'absent' },
    sctpCauseCode: { status: 'unavailable', reason: 'absent' },
    receivedAlert: { status: 'unavailable', reason: 'absent' },
    sentAlert: { status: 'unavailable', reason: 'absent' },
    iceErrorCode: { status: 'unavailable', reason: 'absent' },
    exceptionName: { status: 'observed', value: 'OperationError' }
};

const nativeSignalIdentity: RtcSignalingDiagnostics.SignalIdentity & { atEpochMs: number; } = {
    localSessionId: 'session-a',
    peerSessionId: 'session-c',
    signalType: undefined,
    offerId: undefined,
    atEpochMs: 200
};

export function createNativeRecordingEvents(): readonly RtcSignalingDiagnostics.Event[] {
    return [
        { ...nativeSignalIdentity, kind: 'native-lifetime', action: 'created', native: nativeSnapshot },
        { ...nativeSignalIdentity, kind: 'native-state', trigger: 'connection', native: nativeSnapshot },
        { ...nativeSignalIdentity, kind: 'native-first-error', native: nativeSnapshot, error: nativeError, first: 'observed' },
        {
            ...nativeSignalIdentity,
            kind: 'native-candidate-application',
            candidate: {
                operationOrdinal: 1,
                applicationOrdinal: 1,
                source: 'direct',
                stage: 'returned',
                currentPeerConnection: true,
                identity: observedNativeIdentity,
                fragmentPresence: 'absent',
                dataIceFragmentComparison: 'unknown',
                comparisonReadout: { status: 'unavailable', reason: 'absent' },
                targetTransportAssociation: 'unknown',
                iceGenerationAssociation: 'unknown',
                error: { status: 'none-observed', coverage: { kind: 'native-operation', stage: 'settled' } },
                capture
            }
        },
        {
            ...nativeSignalIdentity,
            kind: 'service-peer-observation',
            service: {
                peerId: 'session-c',
                setupId: { status: 'observed', value: 'setup-c' },
                setup: { phase: 'established', peerId: 'session-c', startedAtEpochMs: 1, establishedAtEpochMs: 2 },
                native: nativeSnapshot,
                channels: [],
                channelCount: 0,
                channelsTruncated: false,
                capture,
                stage: 'setup-established',
                issuer: { status: 'unavailable', reason: 'not-applicable' },
                timeout: { status: 'unavailable', reason: 'not-applicable' }
            }
        },
        { ...nativeSignalIdentity, kind: 'native-observation-status', stage: 'initialized', availability: { status: 'observed', value: 'enabled' }, capture },
        { ...nativeSignalIdentity, kind: 'native-observation-limit', limit: 'ordinary-rows', identity: observedNativeIdentity, capture },
        {
            ...nativeSignalIdentity,
            kind: 'native-observation-unavailable',
            originalKind: 'native-state',
            reason: 'payload-bytes',
            identity: observedNativeIdentity,
            setupId: { status: 'unavailable', reason: 'not-applicable' },
            capture
        }
    ];
}

function createHealthyRecordingChannel(peerId: string): RtcDataChannelHealth {
    return {
        peerId,
        label: 'realtime',
        state: 'Open',
        role: 'Initiator',
        readyState: 'open',
        binaryType: 'arraybuffer',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        queuedItemCount: 0,
        rawCallbackCount: 1,
        messageCallbackCount: 1,
        lifecycleCallbackCount: 1,
        flowControl: { highWatermarkBytes: 65536, lowWatermarkBytes: 0, overflow: 'queue', maxQueueItems: 10 },
        counters: {
            sent: 1,
            queued: 0,
            dropped: 0,
            replaced: 0,
            closed: 0,
            cancelled: 0,
            expired: 0,
            flushed: 0,
            droppedOldest: 0,
            droppedStale: 0,
            receivedRaw: 1,
            receivedString: 1,
            receivedBinary: 0
        }
    };
}
