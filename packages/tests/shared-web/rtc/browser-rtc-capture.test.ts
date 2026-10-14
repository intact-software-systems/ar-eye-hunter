import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { RtcNativeObservationScope } from '@shared/webrtc/rtc-native-observation-scope.ts';

import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import { recordRtcSignalingObservation, type RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

describe('browser RTC capture construction', () => {
    it.each(['off', 'signaling', 'native'] as const)('constructs truthful serialized %s evidence and selected observations', (mode) => {
        const events: RtcSignalingDiagnostics.Event[] = [];
        const configuration = { mode, origin: 'step' as const };
        const identity = { status: 'observed' as const, value: 'connection-one' };
        const capture = createBrowserRtcCapture({ configuration, connectionId: identity, record: (event) => events.push(event), nowEpochMs: () => 10 });
        recordRtcSignalingObservation(capture.diagnostics, {
            kind: 'service-signal-route',
            disposition: 'policy-retry',
            result: undefined,
            localSessionId: 'self',
            peerSessionId: 'peer',
            signalType: 'Offer',
            offerId: 'offer'
        });
        expect(events).toHaveLength(mode === 'off' ? 0 : 1);
        expect(JSON.parse(JSON.stringify(capture.receipt))).toEqual({
            configuration: { mode, origin: 'step' },
            application: { status: 'applied', mode },
            connectionId: { status: 'observed', value: 'connection-one' },
            nativeScopeId: mode === 'native' ? { status: 'observed', value: expect.any(String) } : { status: 'unavailable', reason: 'not-applicable' },
            configurationVersion: 1,
            nativeAvailability: mode === 'native' ? { status: 'observed', value: 'enabled' } : { status: 'unavailable', reason: 'disabled' },
            nativeCoverage: mode === 'native' ? 'partial' : 'not-applicable'
        });
        Object.assign(configuration, { mode: 'native', origin: 'host' });
        Object.assign(identity, { value: 'replacement' });
        expect(capture.receipt.configuration).toEqual({ mode, origin: 'step' });
        expect(capture.receipt.connectionId).toEqual({ status: 'observed', value: 'connection-one' });
        expect(Object.isFrozen(capture.receipt.application)).toBe(true);
    });
    it.each(['signaling', 'native'] as const)('reports missing sink for %s without installing capture', (mode) => {
        const capture = createBrowserRtcCapture({
            configuration: { mode, origin: 'host' },
            connectionId: { status: 'unavailable', reason: 'identity-source-failed' },
            record: undefined,
            nowEpochMs: () => 10
        });
        expect(capture.diagnostics).toBeUndefined();
        expect(capture.receipt.application).toEqual({ status: 'unavailable', reason: 'sink-unavailable' });
        expect(capture.receipt.connectionId).toEqual({ status: 'unavailable', reason: 'identity-source-failed' });
    });
});

it('distinguishes a failed native scope initialization in every serialized receipt field', () => {
    onTestFinished(() => {
        vi.restoreAllMocks();
    });
    vi.spyOn(RtcNativeObservationScope, 'create').mockReturnValue({ status: 'unavailable', reason: 'initialization-failed' });
    const capture = createBrowserRtcCapture({
        configuration: { mode: 'native', origin: 'step' },
        connectionId: { status: 'observed', value: 'connection' },
        record: () => {},
        nowEpochMs: () => 1
    });
    expect(JSON.parse(JSON.stringify(capture.receipt))).toMatchObject({
        application: { status: 'unavailable', reason: 'initialization-failed' },
        nativeScopeId: { status: 'unavailable', reason: 'initialization-failed' },
        nativeAvailability: { status: 'unavailable', reason: 'initialization-failed' },
        nativeCoverage: 'unavailable'
    });
});
