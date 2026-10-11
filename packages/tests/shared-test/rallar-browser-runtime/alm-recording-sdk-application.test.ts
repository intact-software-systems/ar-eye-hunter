import { expect, it } from 'vitest';

import {
    createCaptureApplicationRuntime,
    installCaptureApplicationTestEnvironment
} from './capture-application-test-runtime.ts';

installCaptureApplicationTestEnvironment();

it.each([undefined, true, false])('keeps the actual SDK run-Off receipt independent of ALM recording %s', async (almDiagnostics) => {
    const { page, facade, events } = createCaptureApplicationRuntime();
    try {
        const connected = await page.connect({
            connection: 'sdk-alm',
            rallar: {
                apiBaseUrl: 'https://test.invalid',
                applicationId: 'app',
                almDiagnostics,
                rtc: { captureMode: 'native' },
                rtcCaptureContext: { run: 'off' }
            }
        });
        expect(connected.rtcCapture).toMatchObject({
            status: 'observed',
            value: {
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            }
        });
        expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
        expect(events).toContainEqual(expect.objectContaining({
            topic: 'rallar.browser.connect.phase_completed',
            data: expect.objectContaining({ phase: 'configure', almDiagnostics: almDiagnostics !== false })
        }));
        expect(events.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics')).toEqual([]);
        if (almDiagnostics === false) {
            expect(events.filter((event) => event.topic.startsWith('rallar.browser.alm.'))).toEqual([]);
        }
    }
    finally {
        await page.close();
    }
});
