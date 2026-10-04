import type { WebRtcConnectionService } from '../services/web-rtc-connection-service.ts';
import type { QRtcSignalingType } from './qrtc-signaling-contracts.ts';

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
        & SignalIdentity
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
                readonly disposition: NativeDisposition;
                readonly capturedPeerConnection: boolean;
                readonly currentPeerConnection: boolean | undefined;
                readonly offerMatches: boolean | undefined;
                readonly signalingState: RTCSignalingState | undefined;
            }
            | {
                readonly kind: 'signal-caller-release';
                readonly disposition: CallerRelease;
                readonly capturedPeerConnection: boolean;
                readonly currentPeerConnection: boolean | undefined;
            }
        );

    export type Event = Observation & { readonly atEpochMs: number; };
}

export interface RtcSignalingDiagnostics {
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
