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

test('associates native WebSocket signaling with its replacement socket', async ({ page }) => {
    const socketUrl = 'ws://127.0.0.1:6179/rtc-signaling-observation';
    const signalingFrame = JSON.stringify({
        id: { msgId: 'replacement-offer', senderId: 'session-a' },
        targets: { mode: 'unicast', toPeerId: 'session-b' },
        payload: {
            typeId: 'rtc-signaling',
            resource: JSON.stringify({
                channel: 'RtcSignal',
                type: 'Signal',
                signalType: 'Offer',
                offerId: 'offer-b',
                fromId: 'session-a',
                toId: 'session-b',
                payload: { description: { type: 'offer', sdp: 'secret-sdp' }, candidate: null }
            })
        }
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    await page.routeWebSocket(socketUrl, (route) => {
        route.onMessage((message) => {
            if (message === 'request-offer') {
                route.send(signalingFrame);
            }
        });
    });
    await page.addInitScript(installLiveRtcSignalingObservation);
    await page.goto('data:text/html,<title>RTC signaling observation</title>');

    const snapshot = await page.evaluate(async (url) => {
        const first = new WebSocket(url);
        await new Promise<void>((resolve) => first.addEventListener('open', () => resolve(), { once: true }));
        first.close();
        await new Promise<void>((resolve) => first.addEventListener('close', () => resolve(), { once: true }));

        const replacement = new WebSocket(url);
        await new Promise<void>((resolve) => replacement.addEventListener('open', () => resolve(), { once: true }));
        const received = new Promise<void>((resolve) =>
            replacement.addEventListener('message', () => resolve(), { once: true })
        );
        replacement.send('request-offer');
        await received;
        return window.__liveRtcSignalingObservation?.read() ?? null;
    }, socketUrl);

    expect(pageErrors).toEqual([]);
    expect(snapshot).toMatchObject({
        available: true,
        socketLifetimes: [
            {
                socketInstanceOrdinal: 1,
                openedAtEpochMs: expect.any(Number),
                closedAtEpochMs: expect.any(Number)
            },
            {
                socketInstanceOrdinal: 2,
                openedAtEpochMs: expect.any(Number),
                closedAtEpochMs: null
            }
        ],
        received: [{ msgId: 'replacement-offer', offerId: 'offer-b', socketInstanceOrdinal: 2 }]
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-sdp');
});
