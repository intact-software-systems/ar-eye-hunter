import type { RallarWsLifecycleEvent, RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRtcLaneStatus,
    RallarRtcLifecycleEvent,
    RallarRtcPeerConnectionStatus,
    RallarRtcPeerSignalingCounts,
    RallarRtcPeerStatus,
    RallarRtcStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';

import type { RtcDataChannelCounters, RtcDataChannelHealth } from '@shared/webrtc/qrtc-data-channel.ts';

import {
    isClosedRecord,
    isIdentity,
    isIdentityList,
    isNonnegativeInteger,
    isNonnegativeNumber,
    isOneOf,
    isSameIdentitySet
} from './routine-diagnostic-values.ts';

export function isRoutineWsLifecycle(detail: unknown): detail is RallarWsLifecycleEvent {
    if (
        !isClosedRecord(detail, [
            'kind',
            'atEpochMs',
            'status',
            'eventType',
            'code',
            'reason',
            'wasClean',
            'intentional'
        ]) ||
        !isNonnegativeNumber(detail.atEpochMs) || detail.code !== undefined || detail.reason !== undefined ||
        detail.wasClean !== undefined || detail.intentional !== undefined
    ) {
        return false;
    }
    return (detail.kind === 'open' || detail.kind === 'connected' || detail.kind === 'snapshot') &&
        (detail.eventType === undefined || detail.eventType === 'open') &&
        isRoutineWsStatus(detail.status, detail.kind === 'open');
}

export function isRoutineWsStatus(detail: unknown, opening: boolean): detail is RallarWsStatus {
    return isClosedRecord(detail, [
        'sessionId',
        'url',
        'connectState',
        'readyState',
        'readyStateCode',
        'isOpen',
        'reconnecting',
        'reconnectEnabled',
        'reconnectAttempts',
        'maxReconnectAttempts',
        'reconnectExhausted'
    ]) &&
        (detail.sessionId === undefined || isIdentity(detail.sessionId)) &&
        (detail.url === undefined || isIdentity(detail.url)) &&
        (detail.connectState === 'connected' || opening && detail.connectState === 'connecting') &&
        detail.readyState === 'open' && (detail.readyStateCode === undefined || detail.readyStateCode === 1) &&
        detail.isOpen === true && detail.reconnecting === false && typeof detail.reconnectEnabled === 'boolean' &&
        detail.reconnectAttempts === 0 && isNonnegativeInteger(detail.maxReconnectAttempts) &&
        detail.reconnectExhausted === false;
}

export function isRoutineRtcLifecycle(detail: unknown): detail is RallarRtcLifecycleEvent {
    if (
        !isClosedRecord(detail, ['kind', 'atEpochMs', 'status', 'peerId', 'laneId', 'peer', 'lane', 'signaling']) ||
        !isNonnegativeNumber(detail.atEpochMs) || detail.signaling !== undefined ||
        !isOneOf(detail.kind, ['peer-created', 'peer-established', 'lane-open', 'snapshot', 'connected']) ||
        !isRoutineRtcStatus(detail.status)
    ) {
        return false;
    }
    if (detail.kind === 'snapshot' || detail.kind === 'connected') {
        return detail.peerId === undefined && detail.peer === undefined && detail.laneId === undefined &&
            detail.lane === undefined;
    }
    const observedPeer = detail.peer;
    if (
        !isRoutineRtcPeer(observedPeer) || detail.peerId !== observedPeer.peerId ||
        !detail.status.peers.some((peer) =>
            peer.peerId === detail.peerId &&
            peer.connection.state === observedPeer.connection.state &&
            peer.connection.connectionState === observedPeer.connection.connectionState &&
            isSameIdentitySet(peer.readyLaneIds, observedPeer.readyLaneIds)
        )
    ) {
        return false;
    }
    if (detail.kind === 'peer-established' && observedPeer.connection.connectionState !== 'connected') {
        return false;
    }
    if (detail.kind === 'lane-open') {
        return isRoutineRtcLane(detail.lane) && detail.lane.isOpen === true && detail.lane.peerId === detail.peerId &&
            detail.lane.laneId === detail.laneId && observedPeer.readyLaneIds.includes(detail.lane.laneId);
    }
    return detail.laneId === undefined && detail.lane === undefined;
}

function isRoutineRtcStatus(detail: unknown): detail is RallarRtcStatus {
    if (
        !isClosedRecord(detail, [
            'sessionId',
            'laneId',
            'knownPeerIds',
            'activePeerIds',
            'peerIdsWithNoReconnectableLanes',
            'readyPeerIds',
            'peers'
        ]) ||
        !isIdentity(detail.sessionId) || !isIdentity(detail.laneId) || !Array.isArray(detail.peers) ||
        detail.peers.length === 0 || !detail.peers.every(isRoutineRtcPeer) || !isIdentityList(detail.knownPeerIds) ||
        !isIdentityList(detail.activePeerIds) || !isIdentityList(detail.readyPeerIds) ||
        !isIdentityList(detail.peerIdsWithNoReconnectableLanes)
    ) {
        return false;
    }
    const peers: RallarRtcPeerStatus[] = detail.peers;
    return peers.every((peer) => peer.isRoutable === peer.readyLaneIds.includes(detail.laneId as string)) &&
        isSameIdentitySet(detail.knownPeerIds, peers.map((peer) => peer.peerId)) &&
        isSameIdentitySet(
            detail.peerIdsWithNoReconnectableLanes,
            peers.filter((peer) => peer.hasNoReconnectableLanes).map((peer) => peer.peerId)
        ) &&
        isSameIdentitySet(detail.activePeerIds, peers.filter((peer) => peer.isActive).map((peer) => peer.peerId)) &&
        isSameIdentitySet(
            detail.readyPeerIds,
            peers.filter((peer) => peer.readyLaneIds.includes(detail.laneId as string)).map((peer) => peer.peerId)
        );
}

/** Full peer validation also protects formation before its smaller room projection drops these facts. */
export function isRoutineRtcPeer(detail: unknown): detail is RallarRtcPeerStatus {
    if (
        !isClosedRecord(detail, [
            'peerId',
            'connection',
            'lanes',
            'isActive',
            'hasNoReconnectableLanes',
            'isRoutable',
            'readyLaneIds'
        ]) ||
        !isIdentity(detail.peerId) || !isRoutineRtcConnection(detail.connection) || !Array.isArray(detail.lanes) ||
        !detail.lanes.every(isRoutineRtcLane) || !isIdentityList(detail.readyLaneIds) ||
        detail.isActive !== true || typeof detail.hasNoReconnectableLanes !== 'boolean' ||
        typeof detail.isRoutable !== 'boolean'
    ) {
        return false;
    }
    return detail.lanes.every((lane) => lane.peerId === detail.peerId) &&
        new Set(detail.lanes.map((lane) => lane.laneId)).size === detail.lanes.length &&
        isSameIdentitySet(detail.readyLaneIds, detail.lanes.filter((lane) => lane.isOpen).map((lane) => lane.laneId)) &&
        detail.hasNoReconnectableLanes === !detail.lanes.some((lane) => lane.isReconnectable) &&
        (!detail.isRoutable || detail.isActive && detail.readyLaneIds.length > 0);
}

function isRoutineRtcConnection(detail: unknown): detail is RallarRtcPeerConnectionStatus {
    if (
        !isClosedRecord(detail, [
            'state',
            'connectionState',
            'iceConnectionState',
            'iceGatheringState',
            'signalingState',
            'hasLocalDescription',
            'hasRemoteDescription',
            'canTrickleIceCandidates',
            'reconnectAttempts',
            'reconnecting',
            'disconnectPending',
            'makingOffer',
            'ignoreOffer',
            'iceCandidateQueueSize',
            'localStreamId',
            'remoteStreamIds',
            'signaling'
        ])
    ) {
        return false;
    }
    return isOneOf(detail.state, ['Idle', 'Connecting', 'Open']) &&
        isOneOf(detail.connectionState, ['new', 'connecting', 'connected']) &&
        isOneOf(detail.iceConnectionState, ['new', 'checking', 'connected', 'completed']) &&
        isOneOf(detail.iceGatheringState, ['new', 'gathering', 'complete']) &&
        isOneOf(detail.signalingState, [
            'stable',
            'have-local-offer',
            'have-local-pranswer',
            'have-remote-offer',
            'have-remote-pranswer'
        ]) &&
        typeof detail.hasLocalDescription === 'boolean' && typeof detail.hasRemoteDescription === 'boolean' &&
        (detail.canTrickleIceCandidates === undefined || detail.canTrickleIceCandidates === null ||
            typeof detail.canTrickleIceCandidates === 'boolean') &&
        detail.reconnectAttempts === 0 && detail.reconnecting === false && detail.disconnectPending === false &&
        typeof detail.makingOffer === 'boolean' && detail.ignoreOffer === false &&
        isNonnegativeInteger(detail.iceCandidateQueueSize) &&
        (detail.localStreamId === undefined || isIdentity(detail.localStreamId)) &&
        isIdentityList(detail.remoteStreamIds) &&
        isRoutineSignalingCounts(detail.signaling) &&
        (detail.connectionState !== 'connected' || detail.state === 'Open' &&
                detail.hasLocalDescription === true && detail.hasRemoteDescription === true &&
                isOneOf(detail.iceConnectionState, ['connected', 'completed']));
}

function isRoutineSignalingCounts(detail: unknown): detail is RallarRtcPeerSignalingCounts {
    const counts = [
        'outboundOfferCount',
        'outboundAnswerCount',
        'outboundIceCandidateCount',
        'inboundOfferCount',
        'inboundAnswerCount',
        'inboundIceCandidateCount',
        'outboundSignalingErrorCount',
        'inboundSignalingErrorCount'
    ];
    return isClosedRecord(detail, counts) && counts.every((key) => isNonnegativeInteger(detail[key])) &&
        detail.outboundSignalingErrorCount === 0 && detail.inboundSignalingErrorCount === 0;
}

function isRoutineRtcLane(detail: unknown): detail is RallarRtcLaneStatus {
    if (
        !isClosedRecord(detail, ['peerId', 'laneId', 'channel', 'isOpen', 'isReconnectable']) ||
        !isIdentity(detail.peerId) || !isIdentity(detail.laneId) || !isRoutineRtcChannel(detail.channel)
    ) {
        return false;
    }
    return detail.channel.peerId === detail.peerId && detail.channel.label === detail.laneId &&
        detail.isOpen === (detail.channel.state === 'Open') &&
        detail.isReconnectable === (detail.channel.state === 'Idle');
}

function isRoutineRtcChannel(detail: unknown): detail is RtcDataChannelHealth {
    if (
        !isClosedRecord(detail, [
            'peerId',
            'label',
            'state',
            'role',
            'readyState',
            'binaryType',
            'bufferedAmount',
            'bufferedAmountLowThreshold',
            'queuedItemCount',
            'rawCallbackCount',
            'messageCallbackCount',
            'lifecycleCallbackCount',
            'flowControl',
            'counters'
        ])
    ) {
        return false;
    }
    const counts = [
        'bufferedAmount',
        'bufferedAmountLowThreshold',
        'queuedItemCount',
        'rawCallbackCount',
        'messageCallbackCount',
        'lifecycleCallbackCount'
    ];
    return isIdentity(detail.peerId) && isIdentity(detail.label) &&
        isOneOf(detail.state, ['Idle', 'Connecting', 'Open']) &&
        isOneOf(detail.role, ['None', 'Initiator', 'Receiver']) &&
        (detail.state === 'Open' ? detail.readyState === 'open' : detail.readyState === 'connecting') &&
        (detail.binaryType === undefined || detail.binaryType === 'arraybuffer' || detail.binaryType === 'blob') &&
        counts.every((key) => isNonnegativeInteger(detail[key])) && isRoutineChannelCounters(detail.counters) &&
        isClosedRecord(detail.flowControl, ['highWatermarkBytes', 'lowWatermarkBytes', 'overflow', 'maxQueueItems']) &&
        isNonnegativeInteger(detail.flowControl.highWatermarkBytes) &&
        isNonnegativeInteger(detail.flowControl.lowWatermarkBytes) &&
        isNonnegativeInteger(detail.flowControl.maxQueueItems) &&
        isOneOf(detail.flowControl.overflow, ['drop-new', 'drop-old', 'replace-by-key', 'queue']);
}

function isRoutineChannelCounters(detail: unknown): detail is RtcDataChannelCounters {
    const loss = ['dropped', 'closed', 'cancelled', 'expired', 'droppedOldest', 'droppedStale'];
    const counts = [
        ...loss,
        'sent',
        'queued',
        'replaced',
        'flushed',
        'receivedRaw',
        'receivedString',
        'receivedBinary'
    ];
    return isClosedRecord(detail, counts) && counts.every((key) => isNonnegativeInteger(detail[key])) &&
        loss.every((key) => detail[key] === 0);
}
