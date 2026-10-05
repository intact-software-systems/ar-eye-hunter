import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export interface CreateBrowserRtcCaptureInput {
    readonly configuration: RtcSignalingDiagnostics.CaptureConfiguration;
    readonly connectionId: RtcSignalingDiagnostics.Readout<string>;
    readonly record: RtcSignalingDiagnostics['record'] | undefined;
    readonly nowEpochMs: () => number;
}

export interface BrowserRtcCapture {
    readonly diagnostics: RtcSignalingDiagnostics | undefined;
    readonly receipt: RtcSignalingDiagnostics.CaptureReceipt;
}

export function createBrowserRtcCapture(input: CreateBrowserRtcCaptureInput): BrowserRtcCapture {
    const configuration = Object.freeze({ ...input.configuration });
    const application: RtcSignalingDiagnostics.CaptureApplication = configuration.mode === 'off'
        ? { status: 'applied', mode: 'off' }
        : !input.record
        ? { status: 'unavailable', reason: 'sink-unavailable' }
        : configuration.mode === 'native'
        ? { status: 'unavailable', reason: 'unsupported' }
        : { status: 'applied', mode: 'signaling' };
    const nativeUnavailable = configuration.mode === 'native';
    return Object.freeze({
        diagnostics: application.status === 'applied' && application.mode === 'signaling' && input.record
            ? Object.freeze({ nowEpochMs: input.nowEpochMs, record: input.record })
            : undefined,
        receipt: Object.freeze({
            configuration,
            application: Object.freeze(application),
            connectionId: Object.freeze({ ...input.connectionId }),
            nativeScopeId: Object.freeze({
                status: 'unavailable',
                reason: nativeUnavailable ? 'unsupported' : 'not-applicable'
            }),
            configurationVersion: 1,
            nativeAvailability: Object.freeze({
                status: 'unavailable',
                reason: nativeUnavailable ? 'unsupported' : 'disabled'
            }),
            nativeCoverage: nativeUnavailable ? 'unavailable' : 'not-applicable'
        })
    });
}
