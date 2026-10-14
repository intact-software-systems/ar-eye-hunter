import { beforeEach, expect, it } from 'vitest';

import { loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

beforeEach(resetFacade);

it('refuses required Native with absent actual receipt rather than certifying requested capture', async () => {
    const runtime = await loadRuntime();
    try {
        await expect(runtime.connect({
            connection: 'default',
            rallar: {
                apiBaseUrl: 'https://test.invalid',
                username: 'tester',
                password: 'unit-test',
                rtcCaptureContext: { run: 'native' }
            }
        })).rejects.toMatchObject({
            code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
            reason: 'receipt-unavailable',
            requestedConfiguration: { mode: 'native', origin: 'run' },
            rtcCapture: { status: 'unavailable', reason: 'absent' }
        });
    }
    finally {
        await runtime.close();
    }
});

it('preserves omitted-intent Connect success with an absent capture readout', async () => {
    const runtime = await loadRuntime();
    try {
        const result = await runtime.connect({
            connection: 'default',
            rallar: {
                apiBaseUrl: 'https://test.invalid',
                username: 'tester',
                password: 'unit-test'
            }
        });
        expect(result.status).toBe('connected');
        expect(result.rtcCapture).toEqual({ status: 'unavailable', reason: 'absent' });
    }
    finally {
        await runtime.close();
    }
});
