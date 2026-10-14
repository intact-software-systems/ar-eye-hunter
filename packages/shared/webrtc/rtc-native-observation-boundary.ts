import type { QRtcDataChannel } from './qrtc-data-channel.ts';
import type { QRtcPeerConnection } from './qrtc-peer-connection.ts';
import type { RtcNativeObservationScope } from './rtc-native-observation-scope.ts';
import { readRtcNativeState, toRtcErrorReadout, toRtcUnavailable } from './rtc-native-observation-values.ts';
import type { RtcSignalingDiagnostics } from './rtc-signaling-diagnostics.ts';

export interface RtcNativeListener {
    readonly target: EventTarget;
    readonly event: string;
    readonly listener: EventListener;
}

export interface RtcNativeSnapshotInput {
    readonly binding: QRtcPeerConnection.NativeBinding | undefined;
    readonly unavailableReason: RtcSignalingDiagnostics.ErrorUnavailableReason;
    readonly identity: RtcSignalingDiagnostics.NativeIdentity;
    readonly capture: RtcSignalingDiagnostics.CaptureStatus;
    readonly nativeSequence: number;
    readonly readFailed: boolean;
}

export function attachRtcNativeListener(listener: RtcNativeListener): boolean {
    try {
        listener.target.addEventListener(listener.event, listener.listener);
        return true;
    }
    catch {
        return false;
    }
}

export function detachRtcNativeListeners(listeners: readonly RtcNativeListener[]): void {
    for (const listener of listeners) {
        try {
            listener.target.removeEventListener(listener.event, listener.listener);
        }
        catch { /* A failed observer detach cannot replace native cleanup. */ }
    }
}

export function createRtcNativeBinding(
    pc: RTCPeerConnection,
    admission: RtcNativeObservationScope.Admission
): QRtcPeerConnection.NativeBinding {
    return {
        pc,
        admission,
        identity: Object.freeze({ peerConnectionId: admission.id, channelId: toRtcUnavailable('not-applicable') }),
        detach: [],
        transportDetach: [],
        sctp: undefined,
        dtls: undefined,
        ice: undefined,
        transportOrdinal: 0,
        attachmentGap: false,
        listenerCoverage: 'attached',
        transportReason: 'absent',
        firstError: undefined,
        firstTypedError: undefined,
        typedReadUnavailableReason: undefined,
        lastState: '',
        retired: false,
        capturing: false,
        errorCapturing: false,
        errorWindowAttached: false
    };
}

export function readRtcNativeSnapshot(input: RtcNativeSnapshotInput): RtcSignalingDiagnostics.NativeSnapshot {
    const binding = input.binding;
    const coverage: RtcSignalingDiagnostics.ErrorCoverage = binding?.errorWindowAttached
        ? Object.freeze({
            kind: 'listener-window',
            window: binding.retired ? 'ended-at-retirement' : 'active',
            attachment: binding.listenerCoverage === 'attached' ? 'attached' : 'partial',
            attachmentGap: binding.attachmentGap
        })
        : Object.freeze({
            kind: 'unavailable',
            reason: binding ? 'read-failed' : input.unavailableReason
        });
    const firstError = binding?.errorCapturing && !binding.firstError
        ? Object.freeze({ status: 'unavailable', reason: 'read-failed', coverage })
        : toRtcErrorReadout(binding?.firstError, coverage);
    const typedReason = binding?.errorCapturing ? 'read-failed' : binding?.typedReadUnavailableReason;
    const firstTypedError = !binding?.firstTypedError && typedReason
        ? Object.freeze({ status: 'unavailable', reason: typedReason, coverage })
        : toRtcErrorReadout(binding?.firstTypedError, coverage);
    return Object.freeze({
        identity: input.identity,
        nativeSequence: input.nativeSequence,
        capture: input.capture,
        state: input.readFailed ? toRtcUnavailableNativeState('read-failed') : !binding
            ? toRtcUnavailableNativeState(input.unavailableReason)
            : readRtcNativeState({
                pc: binding?.pc,
                channel: undefined,
                sctp: binding?.sctp,
                dtls: binding?.dtls,
                ice: binding?.ice,
                transportObjectOrdinal: binding?.transportOrdinal
                    ? { status: 'observed', value: binding.transportOrdinal }
                    : toRtcUnavailable('absent'),
                transportUnavailableReason: binding?.transportReason,
                listenerCoverage: binding?.listenerCoverage ?? 'unavailable',
                attachmentGap: binding?.attachmentGap ?? false
            }),
        firstError,
        firstTypedError
    });
}

export function toRtcUnavailableNativeState(
    reason: RtcSignalingDiagnostics.ReadoutUnavailableReason
): RtcSignalingDiagnostics.NativeState {
    const unavailable = toRtcUnavailable(reason);
    return Object.freeze({
        connectionState: unavailable,
        iceConnectionState: unavailable,
        iceGatheringState: unavailable,
        signalingState: unavailable,
        iceTransportState: unavailable,
        dtlsState: unavailable,
        sctpState: unavailable,
        channelState: unavailable,
        transportObjectOrdinal: unavailable,
        transportBinding: 'unavailable',
        listenerCoverage: 'unavailable',
        attachmentGap: reason === 'read-failed'
    });
}

export function toRtcRetiredNativeSnapshot(
    native: RtcSignalingDiagnostics.NativeSnapshot
): RtcSignalingDiagnostics.NativeSnapshot {
    return Object.freeze({
        ...native,
        firstError: toRtcEndedErrorReadout(native.firstError),
        firstTypedError: toRtcEndedErrorReadout(native.firstTypedError)
    });
}

function toRtcEndedErrorReadout(error: RtcSignalingDiagnostics.ErrorReadout): RtcSignalingDiagnostics.ErrorReadout {
    return error.coverage.kind === 'listener-window'
        ? Object.freeze({ ...error, coverage: Object.freeze({ ...error.coverage, window: 'ended-at-retirement' }) })
        : error;
}

export interface RtcNativeChannelSnapshotInput {
    readonly observation: QRtcDataChannel.NativeObservation;
    readonly capture: RtcSignalingDiagnostics.CaptureStatus;
    readonly nativeSequence: number;
    readonly readFailed: boolean;
}

export function readRtcNativeChannelSnapshot(
    input: RtcNativeChannelSnapshotInput
): RtcSignalingDiagnostics.NativeSnapshot {
    const observation = input.observation;
    const parent = observation.binding.parent;
    const coverage: RtcSignalingDiagnostics.ErrorCoverage = Object.freeze({
        kind: 'listener-window',
        window: observation.retired ? 'ended-at-retirement' : 'active',
        attachment: 'attached',
        attachmentGap: false
    });
    const firstError = observation.errorCapturing && !observation.firstError
        ? Object.freeze({ status: 'unavailable' as const, reason: 'read-failed' as const, coverage })
        : toRtcErrorReadout(observation.firstError, coverage);
    const typedReason = observation.errorCapturing ? 'read-failed' : observation.typedReadUnavailableReason;
    const firstTypedError = !observation.firstTypedError && typedReason
        ? Object.freeze({ status: 'unavailable' as const, reason: typedReason, coverage })
        : !observation.firstTypedError && typeof RTCError === 'undefined'
        ? Object.freeze({ status: 'unavailable' as const, reason: 'unsupported' as const, coverage })
        : toRtcErrorReadout(observation.firstTypedError, coverage);
    const state = input.readFailed
        ? toRtcUnavailableNativeState('read-failed')
        : readRtcNativeState({
            pc: parent.pc,
            channel: observation.channel,
            sctp: parent.sctp,
            dtls: parent.dtls,
            ice: parent.ice,
            transportUnavailableReason: parent.transportReason,
            transportObjectOrdinal: parent.transportOrdinal
                ? { status: 'observed', value: parent.transportOrdinal }
                : toRtcUnavailable('absent'),
            listenerCoverage: 'attached',
            attachmentGap: parent.attachmentGap
        });
    return Object.freeze({
        identity: observation.binding.identity,
        state,
        firstError,
        firstTypedError,
        nativeSequence: input.nativeSequence,
        capture: input.capture
    });
}
