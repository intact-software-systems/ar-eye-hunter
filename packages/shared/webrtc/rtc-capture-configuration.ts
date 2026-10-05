import { Either } from '../resilience/Either.ts';
import type { RtcSignalingDiagnostics } from './rtc-signaling-diagnostics.ts';

export interface RtcCaptureModeValidationIssue {
    readonly code: 'invalid-rtc-capture-mode';
    readonly message: string;
}

export interface ParsedRtcCaptureMode {
    readonly mode: RtcSignalingDiagnostics.CaptureMode | undefined;
}

export interface ResolveRtcCaptureConfigurationInput {
    readonly run?: RtcSignalingDiagnostics.CaptureMode;
    readonly step?: RtcSignalingDiagnostics.CaptureMode;
    readonly recipe?: RtcSignalingDiagnostics.CaptureMode;
    readonly host?: RtcSignalingDiagnostics.CaptureMode;
    readonly sinkAvailable: boolean;
}

export function parseRtcCaptureMode(
    value: unknown
): Either<readonly RtcCaptureModeValidationIssue[], ParsedRtcCaptureMode> {
    if (value === undefined || value === 'off' || value === 'signaling' || value === 'native') {
        return Either.ofRight({ mode: value });
    }
    return Either.ofLeft([{
        code: 'invalid-rtc-capture-mode',
        message: 'RTC capture mode must be off, signaling or native.'
    }]);
}

export function resolveRtcCaptureConfiguration(
    input: ResolveRtcCaptureConfigurationInput
): RtcSignalingDiagnostics.CaptureConfiguration {
    if (input.run !== undefined) {
        return Object.freeze({ mode: input.run, origin: 'run' });
    }
    if (input.step !== undefined) {
        return Object.freeze({ mode: input.step, origin: 'step' });
    }
    if (input.recipe !== undefined) {
        return Object.freeze({ mode: input.recipe, origin: 'recipe' });
    }
    if (input.host !== undefined) {
        return Object.freeze({ mode: input.host, origin: 'host' });
    }
    return Object.freeze({ mode: input.sinkAvailable ? 'signaling' : 'off', origin: 'product-default' });
}
