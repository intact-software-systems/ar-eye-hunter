import type { RtcSignalingDiagnostics } from './rtc-signaling-diagnostics.ts';

export interface RtcNativeStateInput {
    readonly pc: RTCPeerConnection | undefined;
    readonly channel: RTCDataChannel | undefined;
    readonly sctp: RTCSctpTransport | undefined;
    readonly dtls: RTCDtlsTransport | undefined;
    readonly ice: RTCIceTransport | undefined;
    readonly transportObjectOrdinal: RtcSignalingDiagnostics.Readout<number>;
    readonly listenerCoverage: RtcSignalingDiagnostics.NativeState['listenerCoverage'];
    readonly attachmentGap: boolean;
    readonly transportUnavailableReason?: RtcSignalingDiagnostics.ReadoutUnavailableReason;
}

export interface RtcNativeTransportChain {
    readonly sctp: RTCSctpTransport | undefined;
    readonly dtls: RTCDtlsTransport | undefined;
    readonly ice: RTCIceTransport | undefined;
    readonly reason: RtcSignalingDiagnostics.ReadoutUnavailableReason;
}

export function toRtcUnavailable(
    reason: RtcSignalingDiagnostics.ReadoutUnavailableReason
): RtcSignalingDiagnostics.UnavailableReadout {
    return Object.freeze({ status: 'unavailable', reason });
}

export function toRtcObserved<T>(value: T): RtcSignalingDiagnostics.ObservedReadout<T> {
    return Object.freeze({ status: 'observed', value });
}

export function readRtcFiniteValue<T extends string>(
    read: () => unknown,
    values: readonly T[]
): RtcSignalingDiagnostics.Readout<T> {
    try {
        const value = read();
        if (value === undefined || value === null) {
            return toRtcUnavailable('absent');
        }
        return typeof value === 'string' && values.some((allowed) => allowed === value)
            ? toRtcObserved(value as T)
            : toRtcUnavailable('unrecognized');
    }
    catch {
        return toRtcUnavailable('read-failed');
    }
}

function readRtcInteger(read: () => unknown, maximum: number): RtcSignalingDiagnostics.Readout<number> {
    try {
        const value = read();
        if (value === null || value === undefined) {
            return toRtcUnavailable('absent');
        }
        return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum
            ? toRtcObserved(value)
            : toRtcUnavailable('unrecognized');
    }
    catch {
        return toRtcUnavailable('read-failed');
    }
}

/** Caught exceptions and native event payloads enter as unknown and leave as finite facts only. */
export function readRtcNativeErrorFacts(value: unknown): RtcSignalingDiagnostics.NativeErrorFacts {
    const object = typeof value === 'object' && value !== null ? value : undefined;
    return Object.freeze({
        errorDetail: readRtcFiniteValue(() => object && 'errorDetail' in object ? object.errorDetail : undefined, [
            'data-channel-failure',
            'dtls-failure',
            'fingerprint-failure',
            'hardware-encoder-error',
            'hardware-encoder-not-available',
            'sctp-failure',
            'sdp-syntax-error'
        ]),
        sctpCauseCode: readRtcInteger(
            () => object && 'sctpCauseCode' in object ? object.sctpCauseCode : undefined,
            65_535
        ),
        receivedAlert: readRtcInteger(
            () => object && 'receivedAlert' in object ? object.receivedAlert : undefined,
            255
        ),
        sentAlert: readRtcInteger(() => object && 'sentAlert' in object ? object.sentAlert : undefined, 255),
        iceErrorCode: readRtcInteger(() => object && 'errorCode' in object ? object.errorCode : undefined, 701),
        exceptionName: readRtcFiniteValue(() => object && 'name' in object ? object.name : undefined, [
            'OperationError',
            'InvalidStateError',
            'TypeError',
            'NotSupportedError',
            'AbortError',
            'UnknownError'
        ])
    });
}

export function toRtcUnavailableErrorFacts(): RtcSignalingDiagnostics.NativeErrorFacts {
    const unavailable = toRtcUnavailable('read-failed');
    return Object.freeze({
        errorDetail: unavailable,
        sctpCauseCode: unavailable,
        receivedAlert: unavailable,
        sentAlert: unavailable,
        iceErrorCode: unavailable,
        exceptionName: unavailable
    });
}

export function readRtcNativeEventError(event: Event): RtcSignalingDiagnostics.NativeErrorFacts {
    try {
        return readRtcNativeErrorFacts('error' in event ? event.error : event);
    }
    catch {
        return toRtcUnavailableErrorFacts();
    }
}

export function readRtcTransportChain(pc: RTCPeerConnection): RtcNativeTransportChain {
    try {
        if (!('sctp' in pc)) {
            return { sctp: undefined, dtls: undefined, ice: undefined, reason: 'unsupported' };
        }
        const sctp = pc.sctp ?? undefined;
        const dtls = sctp?.transport;
        const ice = dtls?.iceTransport;
        return { sctp, dtls, ice, reason: 'absent' };
    }
    catch {
        return { sctp: undefined, dtls: undefined, ice: undefined, reason: 'read-failed' };
    }
}

function readRtcPeerConnectionState(
    pc: RTCPeerConnection | undefined
): Pick<
    RtcSignalingDiagnostics.NativeState,
    'connectionState' | 'iceConnectionState' | 'iceGatheringState' | 'signalingState'
> {
    const missing = toRtcUnavailable('no-native-object');
    return {
        connectionState: pc
            ? readRtcFiniteValue(() => pc?.connectionState, [
                'new',
                'connecting',
                'connected',
                'disconnected',
                'failed',
                'closed'
            ])
            : missing,
        iceConnectionState: pc
            ? readRtcFiniteValue(() => pc?.iceConnectionState, [
                'new',
                'checking',
                'connected',
                'completed',
                'disconnected',
                'failed',
                'closed'
            ])
            : missing,
        iceGatheringState: pc
            ? readRtcFiniteValue(() => pc?.iceGatheringState, ['new', 'gathering', 'complete'])
            : missing,
        signalingState: pc
            ? readRtcFiniteValue(() => pc?.signalingState, [
                'stable',
                'have-local-offer',
                'have-local-pranswer',
                'have-remote-offer',
                'have-remote-pranswer',
                'closed'
            ])
            : missing
    };
}

export function readRtcNativeState(input: RtcNativeStateInput): RtcSignalingDiagnostics.NativeState {
    const missing = toRtcUnavailable(input.pc ? input.transportUnavailableReason ?? 'absent' : 'no-native-object');
    return Object.freeze({
        ...readRtcPeerConnectionState(input.pc),
        iceTransportState: input.ice
            ? readRtcFiniteValue(() => input.ice?.state, [
                'new',
                'checking',
                'connected',
                'completed',
                'disconnected',
                'failed',
                'closed'
            ])
            : missing,
        dtlsState: input.dtls
            ? readRtcFiniteValue(() => input.dtls?.state, ['new', 'connecting', 'connected', 'closed', 'failed'])
            : missing,
        sctpState: input.sctp
            ? readRtcFiniteValue(() => input.sctp?.state, ['connecting', 'connected', 'closed'])
            : missing,
        channelState: input.channel
            ? readRtcFiniteValue(() => input.channel?.readyState, ['connecting', 'open', 'closing', 'closed'])
            : toRtcUnavailable('not-applicable'),
        transportObjectOrdinal: input.transportObjectOrdinal,
        transportBinding: input.ice ? 'data-sctp-chain' : 'unavailable',
        listenerCoverage: input.listenerCoverage,
        attachmentGap: input.attachmentGap
    });
}

export function toRtcErrorReadout(
    error: RtcSignalingDiagnostics.NativeError | undefined,
    coverage: RtcSignalingDiagnostics.ErrorCoverage
): RtcSignalingDiagnostics.ErrorReadout {
    if (error) {
        const observedCoverage: RtcSignalingDiagnostics.ErrorCoverage =
            error.source === 'description-rejection' || error.source === 'candidate-rejection'
                ? Object.freeze({ kind: 'native-operation', stage: 'settled' })
                : coverage;
        return Object.freeze({ status: 'observed', value: error, coverage: observedCoverage });
    }
    if (coverage.kind === 'unavailable') {
        return Object.freeze({ status: 'unavailable', reason: coverage.reason, coverage });
    }
    return Object.freeze({ status: 'none-observed', coverage });
}

export function toRtcNativeErrorIsTyped(error: RtcSignalingDiagnostics.NativeErrorFacts): boolean {
    return error.errorDetail.status === 'observed' || error.sctpCauseCode.status === 'observed' ||
        error.receivedAlert.status === 'observed' || error.sentAlert.status === 'observed' ||
        error.iceErrorCode.status === 'observed';
}

export function readRtcTypedErrorUnavailableReason(
    error: RtcSignalingDiagnostics.NativeErrorFacts,
    previous: 'read-failed' | 'unsupported' | undefined
): 'read-failed' | 'unsupported' | undefined {
    const typedFields = [
        error.errorDetail,
        error.sctpCauseCode,
        error.receivedAlert,
        error.sentAlert,
        error.iceErrorCode
    ];
    if (
        previous === 'read-failed' ||
        typedFields.some((field) => field.status === 'unavailable' && field.reason === 'read-failed')
    ) {
        return 'read-failed';
    }
    return !toRtcNativeErrorIsTyped(error) && typeof RTCError === 'undefined' ? 'unsupported' : previous;
}

export interface RtcCandidateFragmentObservation {
    readonly fragmentPresence: RtcSignalingDiagnostics.CandidateApplication['fragmentPresence'];
    readonly dataIceFragmentComparison: RtcSignalingDiagnostics.CandidateApplication['dataIceFragmentComparison'];
    readonly comparisonReadout: RtcSignalingDiagnostics.Readout<'available'>;
}

export function readRtcCandidateFragments(
    candidate: RTCIceCandidateInit,
    chain: Pick<RtcNativeTransportChain, 'ice' | 'reason'>
): RtcCandidateFragmentObservation {
    let fragment: unknown;
    try {
        fragment = candidate.usernameFragment;
    }
    catch {
        return {
            fragmentPresence: 'unavailable',
            dataIceFragmentComparison: 'unknown',
            comparisonReadout: toRtcUnavailable('read-failed')
        };
    }
    if (fragment === undefined || fragment === null || fragment === '') {
        return {
            fragmentPresence: 'absent',
            dataIceFragmentComparison: 'unknown',
            comparisonReadout: toRtcUnavailable('absent')
        };
    }
    if (typeof fragment !== 'string' || fragment.length > 256) {
        return {
            fragmentPresence: 'unavailable',
            dataIceFragmentComparison: 'unknown',
            comparisonReadout: toRtcUnavailable('unrecognized')
        };
    }
    return readRtcDataIceFragmentComparison(fragment, chain);
}

function readRtcDataIceFragmentComparison(
    fragment: string,
    chain: Pick<RtcNativeTransportChain, 'ice' | 'reason'>
): RtcCandidateFragmentObservation {
    const unavailable = (
        reason: RtcSignalingDiagnostics.ReadoutUnavailableReason
    ): RtcCandidateFragmentObservation => ({
        fragmentPresence: 'present',
        dataIceFragmentComparison: 'unknown',
        comparisonReadout: toRtcUnavailable(reason)
    });
    if (!chain.ice) {
        return unavailable(chain.reason);
    }
    try {
        if (!('getRemoteParameters' in chain.ice) || typeof chain.ice.getRemoteParameters !== 'function') {
            return unavailable('unsupported');
        }
        const parameters: unknown = chain.ice.getRemoteParameters();
        if (parameters === null || parameters === undefined) {
            return unavailable('absent');
        }
        if (typeof parameters !== 'object') {
            return unavailable('unrecognized');
        }
        const remote: unknown = 'usernameFragment' in parameters ? parameters.usernameFragment : undefined;
        if (remote === undefined || remote === null || remote === '') {
            return unavailable('absent');
        }
        if (typeof remote !== 'string' || remote.length > 256) {
            return unavailable('unrecognized');
        }
        return {
            fragmentPresence: 'present',
            dataIceFragmentComparison: fragment === remote ? 'equal' : 'different',
            comparisonReadout: toRtcObserved('available')
        };
    }
    catch {
        return unavailable('read-failed');
    }
}

export function readRtcTransportAttachmentGap(chain: RtcNativeTransportChain): boolean {
    const sctp = chain.sctp ? readRtcFiniteValue(() => chain.sctp?.state, ['connecting']) : undefined;
    const dtls = chain.dtls ? readRtcFiniteValue(() => chain.dtls?.state, ['new']) : undefined;
    const ice = chain.ice ? readRtcFiniteValue(() => chain.ice?.state, ['new']) : undefined;
    return [sctp, dtls, ice].some((state) => state?.status === 'unavailable');
}
