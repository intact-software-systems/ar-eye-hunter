import { describe, expect, it, onTestFinished, vi } from 'vitest';

describe('live RTC agent API origins', () => {
    it('uses one A/B/C URL map for single-process and distinct cluster origins', async () => {
        for (const prefix of ['A', 'B', 'C']) {
            vi.stubEnv(`VITE_RALLAR_AGENT_${prefix}_USERNAME`, 'fixture-user');
            vi.stubEnv(`VITE_RALLAR_AGENT_${prefix}_PASSWORD`, 'fixture-password');
        }
        vi.stubEnv('VITE_RALLAR_API_BASE_URL', 'http://localhost:18080');
        onTestFinished(() => {
            vi.unstubAllEnvs();
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
