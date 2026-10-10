import { RtcNativeObservationScope } from '@shared/webrtc/rtc-native-observation-scope.ts';
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
    const nativeObservation = configuration.mode === 'native' && input.record
        ? RtcNativeObservationScope.create({ createScopeId: () => crypto.randomUUID() })
        : undefined;
    const application: RtcSignalingDiagnostics.CaptureApplication = configuration.mode === 'off'
        ? { status: 'applied', mode: 'off' }
        : !input.record
        ? { status: 'unavailable', reason: 'sink-unavailable' }
        : nativeObservation?.status === 'unavailable'
        ? { status: 'unavailable', reason: 'initialization-failed' }
        : { status: 'applied', mode: configuration.mode };
    const nativeUnavailable = configuration.mode === 'native';
    return Object.freeze({
        diagnostics: configuration.mode !== 'off' && input.record
            ? Object.freeze({ nowEpochMs: input.nowEpochMs, record: input.record, nativeObservation })
            : undefined,
        receipt: Object.freeze({
            configuration,
            application: Object.freeze(application),
            connectionId: Object.freeze({ ...input.connectionId }),
            nativeScopeId: nativeObservation?.status === 'available'
                ? nativeObservation.scope.getCaptureStatus().scopeId
                : Object.freeze({
                    status: 'unavailable',
                    reason: nativeObservation?.status === 'unavailable'
                        ? nativeObservation.reason
                        : nativeUnavailable
                        ? 'unsupported'
                        : 'not-applicable'
                }),
            configurationVersion: 1,
            nativeAvailability: nativeObservation?.status === 'available'
                ? Object.freeze({ status: 'observed', value: 'enabled' })
                : Object.freeze({
                    status: 'unavailable',
                    reason: nativeObservation?.status === 'unavailable'
                        ? nativeObservation.reason
                        : nativeUnavailable
                        ? 'unsupported'
                        : 'disabled'
                }),
            nativeCoverage: nativeObservation?.status === 'available'
                ? 'partial'
                : nativeUnavailable
                ? 'unavailable'
                : 'not-applicable'
        })
    });
}
