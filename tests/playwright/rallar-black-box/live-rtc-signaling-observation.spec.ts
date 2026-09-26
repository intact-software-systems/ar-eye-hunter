import { expect, test } from '@playwright/test';

import { installLiveRtcSignalingObservation } from './live-rtc-signaling-observation.ts';

test('installs the signaling witness when TypeScript is loaded by Playwright', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    await page.addInitScript(installLiveRtcSignalingObservation);

    await page.goto('data:text/html,<title>RTC signaling observation</title>');

    const result = await page.evaluate(() => {
        const peer = new RTCPeerConnection();
        peer.close();
        return window.__liveRtcSignalingObservation?.read() ?? null;
    });
    expect(pageErrors).toEqual([]);
    expect(result).toMatchObject({
        available: true,
        received: [],
        attempts: [],
        nativeLifetimes: [{
            nativeInstanceOrdinal: 1,
            closedAtEpochMs: expect.any(Number),
            closeState: {
                signalingState: 'closed',
                connectionState: 'closed',
                iceConnectionState: 'closed'
            },
            observation: 'live'
        }]
    });
});
