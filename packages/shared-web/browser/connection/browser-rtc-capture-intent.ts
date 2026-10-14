import type { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';
import { toRallarOperationOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { resolveRtcCaptureConfiguration } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export type BrowserRtcCaptureIntent =
    | Readonly<{
        options: Pick<RallarOperationOptions, 'rtcCaptureMode' | 'rtcCaptureContext'>;
        connectionIntent: 'acquire';
        requestedConfiguration: undefined;
    }>
    | Readonly<{
        options: Pick<RallarOperationOptions, 'rtcCaptureMode' | 'rtcCaptureContext'>;
        connectionIntent: 'explicit';
        requestedConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
    }>;

export function toBrowserRtcCaptureIntent(
    input: Pick<RallarOperationOptions, 'rtcCaptureMode' | 'rtcCaptureContext'>
): BrowserRtcCaptureIntent {
    const options = Object.freeze(
        toRallarOperationOptions({ rtcCaptureMode: input.rtcCaptureMode, rtcCaptureContext: input.rtcCaptureContext })
    );
    const explicit = options.rtcCaptureMode !== undefined || options.rtcCaptureContext?.run !== undefined ||
        options.rtcCaptureContext?.recipe !== undefined;
    if (!explicit) {
        return { options, connectionIntent: 'acquire', requestedConfiguration: undefined };
    }
    return {
        options,
        connectionIntent: 'explicit',
        // With an explicit source the canonical resolver never consults the sink-dependent default.
        requestedConfiguration: resolveRtcCaptureConfiguration({
            run: options.rtcCaptureContext?.run,
            step: options.rtcCaptureMode,
            recipe: options.rtcCaptureContext?.recipe,
            sinkAvailable: false
        })
    };
}

export function resolveRequiredRtcCaptureFailure(
    requested: RtcSignalingDiagnostics.CaptureConfiguration,
    rtcCapture: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>
): RallarRtcCaptureUnverifiedError.Reason | undefined {
    if (rtcCapture.status !== 'observed') {
        return 'receipt-unavailable';
    }
    const receipt = rtcCapture.value;
    if (receipt.configurationVersion !== 1) {
        return 'configuration-version-unverified';
    }
    if (receipt.connectionId.status !== 'observed' || receipt.connectionId.value.length === 0) {
        return 'connection-identity-unverified';
    }
    if (receipt.application.status !== 'applied') {
        return 'application-unavailable';
    }
    if (receipt.configuration.mode !== requested.mode || receipt.application.mode !== requested.mode) {
        return 'mode-mismatch';
    }
    return undefined;
}
