import { Either } from '@shared/resilience/Either.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export interface CheckRtcCaptureCompatibilityInput {
    readonly requested: RtcSignalingDiagnostics.CaptureConfiguration;
    readonly current: RtcSignalingDiagnostics.CaptureConfiguration | undefined;
    readonly currentReceipt: RtcSignalingDiagnostics.CaptureReceipt | undefined;
}

export class RallarRtcCaptureConnectionRequiredError extends Error {
    public readonly code = 'new-connection-required';
    public readonly requestedConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
    public readonly currentConfiguration: RtcSignalingDiagnostics.CaptureConfiguration;
    public readonly currentReceipt: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>;

    public constructor(
        input: CheckRtcCaptureCompatibilityInput & { readonly current: RtcSignalingDiagnostics.CaptureConfiguration; }
    ) {
        super('A new connection is required to change RTC capture mode.');
        this.name = 'RallarRtcCaptureConnectionRequiredError';
        this.requestedConfiguration = Object.freeze({ ...input.requested });
        this.currentConfiguration = Object.freeze({ ...input.current });
        this.currentReceipt = Object.freeze(
            input.currentReceipt
                ? { status: 'observed', value: input.currentReceipt }
                : { status: 'unavailable', reason: 'absent' }
        );
    }
}

export function checkRtcCaptureCompatibility(
    input: CheckRtcCaptureCompatibilityInput
): Either<RallarRtcCaptureConnectionRequiredError, RtcSignalingDiagnostics.CaptureConfiguration> {
    if (input.current === undefined || input.current.mode === input.requested.mode) {
        return Either.ofRight(input.requested);
    }
    return Either.ofLeft(new RallarRtcCaptureConnectionRequiredError({ ...input, current: input.current }));
}
