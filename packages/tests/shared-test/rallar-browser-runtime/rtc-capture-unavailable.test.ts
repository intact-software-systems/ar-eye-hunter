import { beforeEach, expect, it } from 'vitest';
import { loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

beforeEach(resetFacade);

it('reports absent actual receipt rather than certifying the requested capture', async () => {
    const runtime = await loadRuntime();
    try {
        const result = await runtime.connect({
            connection: 'default',
            rallar: {
                apiBaseUrl: 'https://test.invalid',
                username: 'tester',
                password: 'unit-test',
                rtcCaptureContext: { run: 'native' }
            }
        });
        expect(result.rtcCapture).toEqual({ status: 'unavailable', reason: 'absent' });
    }
    finally {
        await runtime.close();
    }
});
