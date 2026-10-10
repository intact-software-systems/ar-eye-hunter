import type { WebRtcConnectionService } from '../services/web-rtc-connection-service.ts';
import type { QRtcSignalingType } from './qrtc-signaling-contracts.ts';
import { RtcNativeObservationScope } from './rtc-native-observation-scope.ts';

export const RTC_SERVICE_SIGNAL_DISPOSITIONS = [
    'wrong-session',
    'decode-rejected',
    'wrong-target',
    'self',
    'reuse-selected',
    'missing-peer-answer',
    'peer-cap',
    'allow-without-policy',
    'policy-allow',
    'policy-deny',
    'policy-retry',
    'policy-threw',
    'reuse-returned',
    'reuse-threw',
    'accepted-peer-result'
] as const;

export const RTC_NATIVE_SIGNAL_DISPOSITIONS = [
    'no-native-peer',
    'retired-before-application',
    'application-started',
    'answer-ineligible',
    'impolite-offer-ignored',
    'rollback-and-remote-description-returned',
    'remote-description-returned',
    'local-answer-description-returned',
    'ice-ignored',
    'ice-queued',
    'ice-added',
    'retired-after-remote-description',
    'retired-after-ice-flush',
    'retired-after-local-description',
    'application-returned',
    'application-threw'
] as const;

export const RTC_SIGNAL_CALLER_RELEASES = ['application-returned', 'application-threw', 'lifetime-retired'] as const;

export namespace RtcSignalingDiagnostics {
    export type CaptureMode = 'off' | 'signaling' | 'native';
    export type CaptureOrigin = 'run' | 'step' | 'recipe' | 'host' | 'product-default';
    export type ReadoutUnavailableReason =
        | 'disabled'
        | 'no-native-object'
        | 'absent'
        | 'unsupported'
        | 'unrecognized'
        | 'read-failed'
        | 'identity-source-absent'
        | 'identity-source-failed'
        | 'identity-invalid'
        | 'initialization-failed'
        | 'admission-limit'
        | 'scope-disposed'
        | 'payload-bytes'
        | 'not-applicable';

    export interface CaptureConfiguration {
        readonly mode: CaptureMode;
        readonly origin: CaptureOrigin;
    }

    export interface ObservedReadout<T> {
        readonly status: 'observed';
        readonly value: T;
    }

    export interface UnavailableReadout {
        readonly status: 'unavailable';
        readonly reason: ReadoutUnavailableReason;
    }

    export type Readout<T> = ObservedReadout<T> | UnavailableReadout;

    export interface CaptureApplied {
        readonly status: 'applied';
        readonly mode: CaptureMode;
    }

    export interface CaptureUnavailable {
        readonly status: 'unavailable';
        readonly reason: 'sink-unavailable' | 'unsupported' | 'initialization-failed';
    }

    export type CaptureApplication = CaptureApplied | CaptureUnavailable;

    export interface CaptureReceipt {
        readonly configuration: CaptureConfiguration;
        readonly application: CaptureApplication;
        readonly connectionId: Readout<string>;
        readonly nativeScopeId: Readout<string>;
        readonly configurationVersion: 1;
        readonly nativeAvailability: Readout<'enabled'>;
        readonly nativeCoverage: 'attached' | 'partial' | 'unavailable' | 'not-applicable';
    }

    export type ErrorUnavailableReason =
        | 'disabled'
        | 'no-native-object'
        | 'initialization-failed'
        | 'admission-limit'
        | 'unsupported'
        | 'read-failed'
        | 'payload-bytes'
        | 'scope-disposed';
    export interface ListenerErrorCoverage {
        readonly kind: 'listener-window';
        readonly window: 'active' | 'ended-at-retirement';
        readonly attachment: 'attached' | 'partial';
        readonly attachmentGap: boolean;
    }
    export interface OperationErrorCoverage {
        readonly kind: 'native-operation';
        readonly stage: 'pending' | 'settled';
    }
    export interface UnavailableErrorCoverage {
        readonly kind: 'unavailable';
        readonly reason: ErrorUnavailableReason;
    }
    export type ErrorCoverage = ListenerErrorCoverage | OperationErrorCoverage | UnavailableErrorCoverage;
    export interface ObservedErrorReadout {
        readonly status: 'observed';
        readonly value: NativeError;
        readonly coverage: ErrorCoverage;
    }
    export interface NoneObservedErrorReadout {
        readonly status: 'none-observed';
        readonly coverage: ErrorCoverage;
    }
    export interface UnavailableErrorReadout {
        readonly status: 'unavailable';
        readonly reason: ErrorUnavailableReason | 'not-applicable';
        readonly coverage: ErrorCoverage;
    }
    export type ErrorReadout = ObservedErrorReadout | NoneObservedErrorReadout | UnavailableErrorReadout;
    export interface NativeIdentity {
        readonly peerConnectionId: Readout<string>;
        readonly channelId: Readout<string>;
    }
    export interface NativeState {
        readonly connectionState: Readout<RTCPeerConnectionState>;
        readonly iceConnectionState: Readout<RTCIceConnectionState>;
        readonly iceGatheringState: Readout<RTCIceGatheringState>;
        readonly signalingState: Readout<RTCSignalingState>;
        readonly iceTransportState: Readout<RTCIceTransportState>;
        readonly dtlsState: Readout<RTCDtlsTransportState>;
        readonly sctpState: Readout<RTCSctpTransportState>;
        readonly channelState: Readout<RTCDataChannelState>;
        readonly transportObjectOrdinal: Readout<number>;
        readonly transportBinding: 'data-sctp-chain' | 'unavailable';
        readonly listenerCoverage: 'attached' | 'partial' | 'unavailable';
        readonly attachmentGap: boolean;
    }
    export type ExceptionName =
        | 'OperationError'
        | 'InvalidStateError'
        | 'TypeError'
        | 'NotSupportedError'
        | 'AbortError'
        | 'UnknownError';
    export interface NativeErrorFacts {
        readonly errorDetail: Readout<RTCErrorDetailType>;
        readonly sctpCauseCode: Readout<number>;
        readonly receivedAlert: Readout<number>;
        readonly sentAlert: Readout<number>;
        readonly iceErrorCode: Readout<number>;
        readonly exceptionName: Readout<ExceptionName>;
    }
    export interface NativeError extends NativeErrorFacts {
        readonly source:
            | 'ice-candidate-error'
            | 'dtls-error'
            | 'channel-error'
            | 'candidate-rejection'
            | 'description-rejection';
        readonly nativeSequence: number;
        readonly identity: NativeIdentity;
    }
    export interface CaptureStatus {
        readonly scopeId: Readout<string>;
        readonly scope: 'active' | 'disposed' | 'unavailable';
        readonly ordinaryRowsSuppressed: boolean;
        readonly admissionLimited: boolean;
        readonly payloadLimited: boolean;
    }
    export interface NativeSnapshot {
        readonly identity: NativeIdentity;
        readonly state: NativeState;
        readonly firstError: ErrorReadout;
        readonly firstTypedError: ErrorReadout;
        readonly nativeSequence: number;
        readonly capture: CaptureStatus;
    }
    export interface CandidateApplication {
        readonly operationOrdinal: number;
        readonly applicationOrdinal: number;
        readonly source: 'direct' | 'queue-drain';
        readonly stage: 'submitted' | 'returned' | 'rejected';
        readonly currentPeerConnection: boolean;
        readonly identity: NativeIdentity;
        readonly fragmentPresence: 'present' | 'absent' | 'unavailable';
        readonly dataIceFragmentComparison: 'equal' | 'different' | 'unknown';
        readonly comparisonReadout: Readout<'available'>;
        readonly targetTransportAssociation: 'unknown';
        readonly iceGenerationAssociation: 'unknown';
        readonly error: ErrorReadout;
        readonly capture: CaptureStatus;
    }
    export type TerminationIssuer =
        | 'explicit-remove'
        | 'disconnect-peer'
        | 'native-closed'
        | 'lane-wait-cleanup'
        | 'unusable-peer-replacement'
        | 'establishment-timeout'
        | 'native-start-failure';
    export interface CompactChannel {
        readonly identity: NativeIdentity;
        readonly channelState: Readout<RTCDataChannelState>;
    }
    export interface ServicePeerSnapshot {
        readonly peerId: string;
        readonly setupId: Readout<string>;
        readonly setup: WebRtcConnectionService.PeerSetup;
        readonly native: NativeSnapshot;
        readonly channels: readonly CompactChannel[];
        readonly channelCount: number;
        readonly channelsTruncated: boolean;
        readonly capture: CaptureStatus;
    }
    export interface ServiceSetupObservation extends ServicePeerSnapshot {
        readonly stage: 'setup-started' | 'setup-established';
        readonly issuer: UnavailableReadout;
        readonly timeout: UnavailableReadout;
    }
    export interface ServiceTimeoutObservation extends ServicePeerSnapshot {
        readonly stage: 'establishment-timeout';
        readonly issuer: ObservedReadout<'establishment-timeout'>;
        readonly timeout: ObservedReadout<WebRtcConnectionService.PeerEstablishmentTimeoutEvent>;
        readonly watchStartedAtEpochMs: number;
        readonly watchTimedOutAtEpochMs: number;
        readonly removalDisposition: 'original-removed' | 'original-no-longer-current';
    }
    export interface ServiceTerminationObservation extends ServicePeerSnapshot {
        readonly stage: 'terminating';
        readonly issuer: ObservedReadout<TerminationIssuer>;
        readonly timeout: UnavailableReadout;
    }
    export type ServicePeerObservation =
        | ServiceSetupObservation
        | ServiceTimeoutObservation
        | ServiceTerminationObservation;
    export type Retirement = 'reset' | 'replacement' | 'channel-close' | 'channel-error' | 'unknown';
    export type NativeTrigger =
        | 'connection'
        | 'ice-connection'
        | 'ice-gathering'
        | 'signaling'
        | 'ice-transport'
        | 'dtls'
        | 'sctp'
        | 'channel-open'
        | 'channel-close'
        | 'transport-attached';
    export type NativeObservation =
        & SignalIdentity
        & (
            | { readonly kind: 'native-lifetime'; readonly action: 'created'; readonly native: NativeSnapshot; }
            | {
                readonly kind: 'native-lifetime';
                readonly action: 'retiring';
                readonly retirement: Retirement;
                readonly native: NativeSnapshot;
            }
            | { readonly kind: 'native-state'; readonly native: NativeSnapshot; readonly trigger: NativeTrigger; }
            | {
                readonly kind: 'native-first-error';
                readonly native: NativeSnapshot;
                readonly error: NativeError;
                readonly first: 'observed' | 'typed' | 'both';
            }
            | { readonly kind: 'native-candidate-application'; readonly candidate: CandidateApplication; }
            | { readonly kind: 'service-peer-observation'; readonly service: ServicePeerObservation; }
            | {
                readonly kind: 'native-observation-status';
                readonly stage: 'initialized' | 'disposed';
                readonly availability: Readout<'enabled'>;
                readonly capture: CaptureStatus;
            }
            | {
                readonly kind: 'native-observation-limit';
                readonly limit: 'admission' | 'ordinary-rows' | 'payload-bytes';
                readonly identity: NativeIdentity;
                readonly capture: CaptureStatus;
            }
            | {
                readonly kind: 'native-observation-unavailable';
                readonly originalKind:
                    | 'native-lifetime'
                    | 'native-state'
                    | 'native-first-error'
                    | 'native-candidate-application'
                    | 'service-peer-observation'
                    | 'native-observation-status';
                readonly reason: 'payload-bytes';
                readonly identity: NativeIdentity;
                readonly setupId: Readout<string>;
                readonly capture: CaptureStatus;
            }
        );

    export type ServiceDisposition = typeof RTC_SERVICE_SIGNAL_DISPOSITIONS[number];
    export type NativeDisposition = typeof RTC_NATIVE_SIGNAL_DISPOSITIONS[number];
    export type CallerRelease = typeof RTC_SIGNAL_CALLER_RELEASES[number];

    export interface SignalIdentity {
        readonly localSessionId: string;
        readonly peerSessionId: string | undefined;
        readonly signalType: QRtcSignalingType | undefined;
        readonly offerId: string | undefined;
    }

    export type Observation =
        | NativeObservation
        | SignalIdentity
            & (
                | {
                    readonly kind: 'service-signal-route';
                    readonly disposition: ServiceDisposition;
                    readonly result:
                        | WebRtcConnectionService.PeerConnectionLeft['kind']
                        | WebRtcConnectionService.PeerConnectionEnsureOutcome
                        | undefined;
                }
                | {
                    readonly kind: 'native-signal-decision';
                    readonly nativeIdentity: NativeIdentity;
                    readonly disposition: NativeDisposition;
                    readonly capturedPeerConnection: boolean;
                    readonly currentPeerConnection: boolean | undefined;
                    readonly offerMatches: boolean | undefined;
                    readonly signalingState: RTCSignalingState | undefined;
                }
                | {
                    readonly kind: 'signal-caller-release';
                    readonly nativeIdentity: NativeIdentity;
                    readonly disposition: CallerRelease;
                    readonly capturedPeerConnection: boolean;
                    readonly currentPeerConnection: boolean | undefined;
                }
            );

    export type Event = Observation & { readonly atEpochMs: number; };
}

export interface RtcSignalingDiagnostics {
    readonly nativeObservation?: RtcNativeObservationScope.Capability;
    readonly nowEpochMs: () => number;
    readonly record: (event: RtcSignalingDiagnostics.Event) => void;
}

export function recordRtcSignalingObservation(
    diagnostics: RtcSignalingDiagnostics | undefined,
    observation: RtcSignalingDiagnostics.Observation
): void {
    if (!diagnostics) {
        return;
    }
    try {
        const atEpochMs = diagnostics.nowEpochMs();
        if (Number.isFinite(atEpochMs) && atEpochMs >= 0) {
            diagnostics.record(Object.freeze({ ...observation, atEpochMs }));
        }
    }
    catch {
        // Supplemental observations cannot replace signaling outcomes.
    }
}

/** Publishes an already reserved immutable row; overflow replacement spends the same slot. */
export function recordRtcNativeObservation(
    diagnostics: RtcSignalingDiagnostics | undefined,
    observation: RtcSignalingDiagnostics.NativeObservation
): void {
    const capability = diagnostics?.nativeObservation;
    if (!diagnostics || capability?.status !== 'available') {
        return;
    }
    const scope = capability.scope;
    try {
        const atEpochMs = diagnostics.nowEpochMs();
        if (
            !Number.isFinite(atEpochMs) || atEpochMs < 0 ||
            (!scope.getActive() &&
                !(observation.kind === 'native-observation-status' && observation.stage === 'disposed'))
        ) {
            return;
        }
        if (
            !recordBoundedNativeEvent(diagnostics, observation, atEpochMs) &&
            observation.kind !== 'native-observation-limit' && observation.kind !== 'native-observation-unavailable'
        ) {
            scope.markPayloadLimited();
            recordBoundedNativeEvent(
                diagnostics,
                toNativeOverflowObservation(observation, scope.getCaptureStatus()),
                atEpochMs
            );
        }
        const limit = scope.consumeLimitNotice();
        if (limit) {
            recordBoundedNativeEvent(diagnostics, {
                kind: 'native-observation-limit',
                limit,
                localSessionId: observation.localSessionId,
                peerSessionId: observation.peerSessionId,
                signalType: undefined,
                offerId: undefined,
                identity: toNativeObservationIdentity(observation),
                capture: scope.getCaptureStatus()
            }, atEpochMs);
        }
    }
    catch { /* A failing diagnostic boundary has no fallback or retry. */ }
}

function recordBoundedNativeEvent(
    diagnostics: RtcSignalingDiagnostics,
    observation: RtcSignalingDiagnostics.NativeObservation,
    atEpochMs: number
): boolean {
    const event = Object.freeze({ ...observation, atEpochMs });
    if (new TextEncoder().encode(JSON.stringify(event)).byteLength > RtcNativeObservationScope.SOURCE_BYTES) {
        return false;
    }
    diagnostics.record(event);
    return true;
}

function toNativeOverflowObservation(
    observation: Exclude<
        RtcSignalingDiagnostics.NativeObservation,
        { kind: 'native-observation-limit' | 'native-observation-unavailable'; }
    >,
    capture: RtcSignalingDiagnostics.CaptureStatus
): RtcSignalingDiagnostics.NativeObservation {
    return {
        kind: 'native-observation-unavailable',
        originalKind: observation.kind,
        reason: 'payload-bytes',
        localSessionId: observation.localSessionId,
        peerSessionId: observation.peerSessionId,
        signalType: observation.signalType,
        offerId: observation.offerId,
        identity: toNativeObservationIdentity(observation),
        setupId: 'service' in observation
            ? observation.service.setupId
            : { status: 'unavailable', reason: 'not-applicable' },
        capture
    };
}

function toNativeObservationIdentity(
    observation: RtcSignalingDiagnostics.NativeObservation
): RtcSignalingDiagnostics.NativeIdentity {
    return 'native' in observation
        ? observation.native.identity
        : 'candidate' in observation
        ? observation.candidate.identity
        : 'service' in observation
        ? observation.service.native.identity
        : {
            peerConnectionId: { status: 'unavailable', reason: 'not-applicable' },
            channelId: { status: 'unavailable', reason: 'not-applicable' }
        };
}

export function disposeRtcNativeObservationScope(
    diagnostics: RtcSignalingDiagnostics | undefined,
    localSessionId: string
): void {
    const capability = diagnostics?.nativeObservation;
    if (capability?.status !== 'available') {
        return;
    }
    const capture = capability.scope.dispose();
    if (capture && capability.scope.consumeStatus('disposed')) {
        recordRtcNativeObservation(diagnostics, {
            localSessionId,
            peerSessionId: undefined,
            signalType: undefined,
            offerId: undefined,
            kind: 'native-observation-status',
            stage: 'disposed',
            availability: Object.freeze({ status: 'observed', value: 'enabled' }),
            capture
        });
    }
}
