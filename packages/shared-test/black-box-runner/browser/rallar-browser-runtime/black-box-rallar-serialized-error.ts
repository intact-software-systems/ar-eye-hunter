import { RallarRtcCaptureConnectionRequiredError } from '@shared-web/browser/connection/rallar-rtc-capture-connection-required-error.ts';
import { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export type BlackBoxRallarSerializedError =
    | BlackBoxRallarErrorDetails
    | BlackBoxRallarCaptureRefusal
    | BlackBoxRallarCaptureIncompatibility;

interface BlackBoxRallarErrorDetails {
    readonly name: string;
    readonly message: string;
    readonly stack: string | undefined;
}

interface BlackBoxRallarCaptureRefusal extends BlackBoxRallarErrorDetails, RallarRtcCaptureUnverifiedError.Input {
    readonly code: 'RALLAR_RTC_CAPTURE_UNVERIFIED';
}

interface BlackBoxRallarCaptureIncompatibility extends BlackBoxRallarErrorDetails {
    readonly code: 'new-connection-required';
    readonly requestedConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
    readonly currentConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
    readonly currentReceipt: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>;
}

export function toBlackBoxRallarSerializedError(error: Error): BlackBoxRallarSerializedError {
    const details = { name: error.name, message: error.message, stack: error.stack };
    if (error instanceof RallarRtcCaptureUnverifiedError) {
        return {
            ...details,
            code: error.code,
            requestedConfiguration: error.requestedConfiguration,
            rtcCapture: error.rtcCapture,
            reason: error.reason
        };
    }
    if (error instanceof RallarRtcCaptureConnectionRequiredError) {
        return {
            ...details,
            code: error.code,
            requestedConfiguration: error.requestedConfiguration,
            currentConfiguration: error.currentConfiguration,
            currentReceipt: error.currentReceipt
        };
    }
    return details;
}
