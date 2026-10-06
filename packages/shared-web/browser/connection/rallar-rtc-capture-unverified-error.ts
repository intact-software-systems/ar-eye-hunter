import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export namespace RallarRtcCaptureUnverifiedError {
    export type Reason =
        | 'session-not-current'
        | 'middleware-not-current'
        | 'receipt-unavailable'
        | 'configuration-version-unverified'
        | 'connection-identity-unverified'
        | 'mode-mismatch'
        | 'application-unavailable';

    export interface Input {
        readonly requestedConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
        readonly rtcCapture: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>;
        readonly reason: Reason;
    }
}

/** Required observation could not certify admission; the connection keeps its own business outcome. */
export class RallarRtcCaptureUnverifiedError extends Error {
    public readonly code = 'RALLAR_RTC_CAPTURE_UNVERIFIED';
    public readonly requestedConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
    public readonly rtcCapture: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>;
    public readonly reason: RallarRtcCaptureUnverifiedError.Reason;

    public constructor(input: RallarRtcCaptureUnverifiedError.Input) {
        super('Required RTC capture could not be verified for message admission.');
        this.name = 'RallarRtcCaptureUnverifiedError';
        this.requestedConfiguration = Object.freeze({ ...input.requestedConfiguration });
        this.rtcCapture = input.rtcCapture;
        this.reason = input.reason;
    }
}
