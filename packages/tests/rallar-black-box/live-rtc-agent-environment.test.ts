import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

describe('live RTC agent API origins', () => {
    it('uses one A/B/C URL map for single-process and distinct cluster origins', async () => {
        vi.resetModules();
        vi.stubEnv('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE', undefined);
        for (const prefix of ['A', 'B', 'C']) {
            vi.stubEnv(`VITE_RALLAR_AGENT_${prefix}_USERNAME`, 'fixture-user');
            vi.stubEnv(`VITE_RALLAR_AGENT_${prefix}_PASSWORD`, 'fixture-password');
        }
        vi.stubEnv('VITE_RALLAR_API_BASE_URL', 'http://localhost:18080');
        onTestFinished(() => {
            vi.unstubAllEnvs();
            vi.resetModules();
        });
        const { readLiveRtcAgentApiUrls } = await import(
            '../../../tests/playwright/rallar-black-box/live-rtc-agent-environment.ts'
        );
        vi.stubEnv('RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER', '0');
        expect(readLiveRtcAgentApiUrls('http://localhost:18080')).toEqual({
            A: 'http://localhost:18080',
            B: 'http://localhost:18080',
            C: 'http://localhost:18080'
        });
        vi.stubEnv('RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER', '1');
        vi.stubEnv('VITE_RALLAR_API_BASE_URL_B', 'http://localhost:18081');
        vi.stubEnv('VITE_RALLAR_API_BASE_URL_C', 'http://localhost:18082');
        expect(readLiveRtcAgentApiUrls('http://localhost:18080')).toEqual({
            A: 'http://localhost:18080',
            B: 'http://localhost:18081',
            C: 'http://localhost:18082'
        });
    });
});

describe('live RTC process capture selection', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE', undefined);
        onTestFinished(() => {
            vi.unstubAllEnvs();
            vi.resetModules();
        });
    });

    it('inherits when process selection is absent and remains inherited after admission', async () => {
        const environment = await import(
            '../../../tests/playwright/rallar-black-box/live-rtc-agent-environment.ts'
        );
        expect(Reflect.get(environment, 'rtcCaptureMode')).toBeUndefined();

        vi.stubEnv('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE', 'native');
        expect(Reflect.get(environment, 'rtcCaptureMode')).toBeUndefined();
    });

    it.each([
        { mode: 'off', nextMode: 'native' },
        { mode: 'signaling', nextMode: 'off' },
        { mode: 'native', nextMode: 'signaling' }
    ])('retains accepted $mode selection after the process environment changes', async ({ mode, nextMode }) => {
        vi.stubEnv('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE', mode);
        const environment = await import(
            '../../../tests/playwright/rallar-black-box/live-rtc-agent-environment.ts'
        );
        expect(environment).toHaveProperty('rtcCaptureMode', mode);

        vi.stubEnv('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE', nextMode);
        expect(environment).toHaveProperty('rtcCaptureMode', mode);
    });

    it.each([
        { name: 'empty', value: '' },
        { name: 'whitespace', value: ' ' },
        { name: 'padded mode', value: ' native ' },
        { name: 'inherit label', value: 'inherit' },
        { name: 'true label', value: 'true' },
        { name: 'false label', value: 'false' },
        { name: 'one label', value: '1' },
        { name: 'zero label', value: '0' },
        { name: 'on label', value: 'on' },
        { name: 'yes label', value: 'yes' },
        { name: 'capitalized mode', value: 'Native' },
        { name: 'unknown mode', value: 'full' }
    ])('rejects $name at module admission before browser work', async ({ value }) => {
        vi.stubEnv('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE', value);

        await expect(
            import(
                '../../../tests/playwright/rallar-black-box/live-rtc-agent-environment.ts'
            )
        ).rejects.toThrow(/RTC capture mode/);
    });
});
