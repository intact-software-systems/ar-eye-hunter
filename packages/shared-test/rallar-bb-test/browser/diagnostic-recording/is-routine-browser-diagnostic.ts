import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { computeRallarBlackBoxDiagnosticSeverity } from '../../diagnostics.ts';
import { isClosedRecord, isIdentity, isNonnegativeNumber, isOneOf } from './routine-diagnostic-values.ts';
import { isRoutineFormationRoomDetail } from './routine-formation-diagnostics.ts';
import { isRoutineRtcLifecycle, isRoutineWsLifecycle } from './routine-transport-diagnostics.ts';

const SIGNAL_IDENTITY_KEYS = [
    'kind',
    'atEpochMs',
    'localSessionId',
    'peerSessionId',
    'signalType',
    'offerId',
    'disposition'
];

const ROUTINE_SERVICE_DISPOSITIONS = ['reuse-selected', 'allow-without-policy', 'policy-allow', 'reuse-returned'];

/** The closed encoded forms accepted at both the source and the recorder boundary. */
export function isRoutineBrowserDiagnostic(topic: string, detail: unknown): detail is object | undefined {
    if (detail !== undefined && (typeof detail !== 'object' || detail === null)) {
        return false;
    }
    if (computeRallarBlackBoxDiagnosticSeverity({ topic, detail }) !== 'info') {
        return false;
    }
    if (detail === undefined) {
        return true;
    }
    switch (topic) {
        case 'rallar.browser.formation.room-status':
            return isRoutineFormationRoomDetail(detail);
        case 'rallar.browser.rtc.lifecycle':
            return isRoutineRtcLifecycle(detail);
        case 'rallar.browser.ws.lifecycle':
            return isRoutineWsLifecycle(detail);
        case 'rallar.browser.rtc.signaling_diagnostics':
            return isRoutineSignalingDiagnostic(detail);
        default:
            return false;
    }
}

function isRoutineSignalingDiagnostic(detail: unknown): detail is RtcSignalingDiagnostics.Event {
    if (
        !isClosedRecord(detail, [
            ...SIGNAL_IDENTITY_KEYS,
            'result',
            'nativeIdentity',
            'capturedPeerConnection',
            'currentPeerConnection',
            'offerMatches',
            'signalingState'
        ]) ||
        !isIdentity(detail.localSessionId) || !isIdentity(detail.peerSessionId) ||
        detail.localSessionId === detail.peerSessionId || !isNonnegativeNumber(detail.atEpochMs)
    ) {
        return false;
    }
    if (
        detail.signalType === 'IceCandidate'
            ? detail.offerId !== undefined
            : !isOneOf(detail.signalType, ['Offer', 'Answer']) || !isIdentity(detail.offerId)
    ) {
        return false;
    }
    if (detail.kind === 'service-signal-route') {
        return isClosedRecord(detail, [...SIGNAL_IDENTITY_KEYS, 'result']) &&
            (detail.disposition === 'accepted-peer-result'
                ? isOneOf(detail.result, ['setup-started', 'setup-in-flight', 'setup-established'])
                : isOneOf(detail.disposition, ROUTINE_SERVICE_DISPOSITIONS) && detail.result === undefined);
    }
    if (
        detail.capturedPeerConnection !== true || detail.currentPeerConnection !== true ||
        !isRoutineNativeIdentity(detail.nativeIdentity)
    ) {
        return false;
    }
    if (detail.kind === 'signal-caller-release') {
        return isClosedRecord(detail, [
            ...SIGNAL_IDENTITY_KEYS,
            'nativeIdentity',
            'capturedPeerConnection',
            'currentPeerConnection'
        ]) &&
            detail.disposition === 'application-returned';
    }
    return detail.kind === 'native-signal-decision' && detail.result === undefined &&
        detail.offerMatches === undefined && detail.signalingState === undefined &&
        isOneOf(detail.disposition, [
            'application-started',
            'remote-description-returned',
            'rollback-and-remote-description-returned',
            'local-answer-description-returned',
            'ice-queued',
            'ice-added',
            'application-returned'
        ]);
}

function isRoutineNativeIdentity(detail: unknown): detail is RtcSignalingDiagnostics.NativeIdentity {
    return isClosedRecord(detail, ['peerConnectionId', 'channelId']) &&
        isRoutineIdentityReadout(detail.peerConnectionId) && isRoutineIdentityReadout(detail.channelId);
}

function isRoutineIdentityReadout(detail: unknown): detail is RtcSignalingDiagnostics.Readout<string> {
    if (!isClosedRecord(detail, ['status', 'value', 'reason'])) {
        return false;
    }
    if (detail.status === 'observed') {
        return detail.reason === undefined && isIdentity(detail.value);
    }
    return detail.status === 'unavailable' && detail.value === undefined &&
        isOneOf(detail.reason, ['disabled', 'no-native-object', 'not-applicable']);
}
