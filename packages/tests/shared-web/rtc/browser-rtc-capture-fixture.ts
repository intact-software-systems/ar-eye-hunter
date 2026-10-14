import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

/** An intentionally uncaptured test connection; no fabricated connection identity. */
export function createBrowserRtcCaptureReceiptFixture(): RtcSignalingDiagnostics.CaptureReceipt {
    return Object.freeze({
        configuration: Object.freeze({ mode: 'off', origin: 'product-default' }),
        application: Object.freeze({ status: 'applied', mode: 'off' }),
        connectionId: Object.freeze({ status: 'unavailable', reason: 'identity-source-absent' }),
        nativeScopeId: Object.freeze({ status: 'unavailable', reason: 'not-applicable' }),
        configurationVersion: 1,
        nativeAvailability: Object.freeze({ status: 'unavailable', reason: 'disabled' }),
        nativeCoverage: 'not-applicable'
    });
}
