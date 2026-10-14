import { beforeEach, describe, expect, it } from 'vitest';

import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { readAuthSessionContractMocks, resetAuthSessionContractMocks } from '../session/browser-auth-session-contract-fixture.ts';

const mocks = readAuthSessionContractMocks();
installFakeBroadcastChannelPerTest();

beforeEach(async () => {
    await resetAuthSessionContractMocks();
    mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => ({
        middleware: mocks.ctx.middleware,
        checkpoints: [],
        rtcCaptureReceipt: createBrowserRtcCapture({
            configuration: options.rtcCaptureConfiguration,
            connectionId: { status: 'observed', value: 'constructed-connection' },
            record: options.diagnosticsPorts.signalingDiagnostics,
            nowEpochMs: () => 10
        }).receipt
    }));
});

interface SelectionCase {
    readonly run?: RtcSignalingDiagnostics.CaptureMode;
    readonly recipe?: RtcSignalingDiagnostics.CaptureMode;
    readonly step?: RtcSignalingDiagnostics.CaptureMode;
    readonly expected: RtcSignalingDiagnostics.CaptureConfiguration;
}

const cases: readonly SelectionCase[] = [
    { run: 'off', step: 'signaling', recipe: 'native', expected: { mode: 'off', origin: 'run' } },
    { run: 'native', step: 'off', expected: { mode: 'native', origin: 'run' } },
    { recipe: 'signaling', expected: { mode: 'signaling', origin: 'recipe' } },
    { recipe: 'native', step: 'off', expected: { mode: 'off', origin: 'step' } }
];

describe('SDK capture source context', () => {
    it.each(cases)('constructs the selected $expected.mode/$expected.origin receipt', async (selection) => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        facade.setDefaults({ applicationId: 'app', rtc: { captureMode: 'native' }, diagnosticsPorts: { signalingDiagnostics: () => {} } });
        const options = { rtcCaptureMode: selection.step, rtcCaptureContext: { run: selection.run, recipe: selection.recipe } };
        await facade.connect(options);
        expect(facade.rtcCapture()?.configuration).toEqual(selection.expected);
        expect(facade.rtcCapture()?.application).toEqual({ status: 'applied', mode: selection.expected.mode });
        await facade.disconnect();
    });

    it('captures source selections before yielding to authentication settlement', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const context: { run: RtcSignalingDiagnostics.CaptureMode; recipe: RtcSignalingDiagnostics.CaptureMode; } = { run: 'off', recipe: 'native' };
        const options = { rtcCaptureMode: 'signaling' as const, rtcCaptureContext: context };
        const pending = facade.connect(options);
        options.rtcCaptureContext.run = 'native';
        await pending;
        expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
        await facade.disconnect();
    });
});
