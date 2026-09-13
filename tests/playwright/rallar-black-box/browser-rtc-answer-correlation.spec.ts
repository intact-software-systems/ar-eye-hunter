import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserRtcAnswerCorrelationResult } from './browser-rtc-answer-correlation-fixture.ts';

for (const delayedOldAnswer of [false, true]) {
    test(
        delayedOldAnswer
            ? 'opens the replacement channel and delivers a payload after a captured retired answer'
            : 'opens the native control channel and delivers a payload with its current answer',
        async ({ page }, testInfo) => {
            await page.goto('/');
            const fixturePath = path.resolve(
                'tests/playwright/rallar-black-box/browser-rtc-answer-correlation-fixture.ts'
            );
            const result = await page.evaluate<
                BrowserRtcAnswerCorrelationResult,
                { moduleUrl: string; delayedOldAnswer: boolean; }
            >(
                async ({ moduleUrl, delayedOldAnswer }) => {
                    const fixture: typeof import('./browser-rtc-answer-correlation-fixture.ts') = await import(
                        moduleUrl
                    );
                    return await fixture.runBrowserRtcAnswerCorrelation(delayedOldAnswer);
                },
                { moduleUrl: `/@fs${fixturePath}`, delayedOldAnswer }
            );
            const observationPath = testInfo.outputPath('native-answer-observation.json');
            await writeFile(observationPath, JSON.stringify(result, null, 2));
            await testInfo.attach('native-answer-observation', {
                path: observationPath,
                contentType: 'application/json'
            });

            expect(result.channelState).toBe('open');
            expect(result.receivedPayload).toBe('current-answer-native-payload');
            expect(result).toMatchObject({
                delayedOldAnswer,
                distinctOfferIds: delayedOldAnswer,
                oldAnswerDelivered: delayedOldAnswer,
                signalingAfterOldAnswer: 'have-local-offer',
                oldDescriptionSelected: false,
                currentAnswerMatchesOffer: true,
                signalingAfterCurrentAnswer: 'stable',
                observationLimitMs: 5000,
                timedOut: false,
                cleanupErrors: []
            });
        }
    );
}

for (const descriptionType of ['offer', 'answer'] as const) {
    test(`settles the native ${descriptionType} observation at its deadline and blocks late resource use`, async ({
        page
    }, testInfo) => {
        await page.goto('/');
        const fixturePath = path.resolve('tests/playwright/rallar-black-box/browser-rtc-answer-correlation-fixture.ts');
        const result = await page.evaluate(async ({ moduleUrl, descriptionType }) => {
            const fixture: typeof import('./browser-rtc-answer-correlation-fixture.ts') = await import(moduleUrl);
            const peers = new Set<RTCPeerConnection>();
            const channels = new Set<RTCDataChannel>();
            const nativeApply = RTCPeerConnection.prototype.setRemoteDescription;
            const nativeCreateChannel = RTCPeerConnection.prototype.createDataChannel;
            const nativeSend = RTCDataChannel.prototype.send;
            const descriptionRelease = new AbortController();
            let delayedDescription = false;
            let sendCount = 0;
            RTCPeerConnection.prototype.setRemoteDescription = async function (description) {
                peers.add(this);
                await nativeApply.bind(this)(description);
                if (description.type === descriptionType && !delayedDescription) {
                    delayedDescription = true;
                    if (!descriptionRelease.signal.aborted) {
                        await new Promise<void>((resolve) => {
                            descriptionRelease.signal.addEventListener('abort', () => resolve(), { once: true });
                        });
                    }
                }
            };
            RTCPeerConnection.prototype.createDataChannel = function (label, options) {
                peers.add(this);
                const channel = nativeCreateChannel.call(this, label, options);
                channels.add(channel);
                return channel;
            };
            RTCDataChannel.prototype.send = function (data) {
                sendCount++;
                Reflect.apply(nativeSend, this, [data]);
            };
            try {
                let rejectedAtDeadline = false;
                try {
                    await fixture.runBrowserRtcAnswerCorrelation(true);
                }
                catch (error) {
                    rejectedAtDeadline = error instanceof Error &&
                        error.message === 'Native RTC observation exceeded 5000 ms';
                }
                const peersAtDeadline = peers.size;
                const allPeersClosedAtDeadline = [...peers].every((peer) => peer.signalingState === 'closed');
                const allChannelsClosingAtDeadline = [...channels].every((channel) =>
                    channel.readyState === 'closing' || channel.readyState === 'closed'
                );
                descriptionRelease.abort();
                await Promise.all([...channels].map(async (channel) => {
                    if (channel.readyState !== 'closed') {
                        await new Promise<void>((resolve) => {
                            channel.addEventListener('close', () => resolve(), { once: true });
                        });
                    }
                }));
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                return {
                    delayedDescription,
                    rejectedAtDeadline,
                    peersAtDeadline,
                    allPeersClosedAtDeadline,
                    allChannelsClosingAtDeadline,
                    peersAfterLateCompletion: peers.size,
                    allPeersClosedAfterLateCompletion: [...peers].every((peer) => peer.signalingState === 'closed'),
                    allChannelsClosedAfterLateCompletion: [...channels].every((channel) =>
                        channel.readyState === 'closed'
                    ),
                    sendCount
                };
            }
            finally {
                descriptionRelease.abort();
                RTCPeerConnection.prototype.setRemoteDescription = nativeApply;
                RTCPeerConnection.prototype.createDataChannel = nativeCreateChannel;
                RTCDataChannel.prototype.send = nativeSend;
                await Promise.allSettled([...peers].map(async (peer) => peer.close()));
            }
        }, { moduleUrl: `/@fs${fixturePath}`, descriptionType });
        const observationPath = testInfo.outputPath('native-deadline-observation.json');
        await writeFile(observationPath, JSON.stringify(result, null, 2));
        await testInfo.attach('native-deadline-observation', {
            path: observationPath,
            contentType: 'application/json'
        });
        expect(result).toEqual({
            delayedDescription: true,
            rejectedAtDeadline: true,
            peersAtDeadline: descriptionType === 'offer' ? 2 : 4,
            allPeersClosedAtDeadline: true,
            allChannelsClosingAtDeadline: true,
            peersAfterLateCompletion: descriptionType === 'offer' ? 2 : 4,
            allPeersClosedAfterLateCompletion: true,
            allChannelsClosedAfterLateCompletion: true,
            sendCount: 0
        });
    });
}
